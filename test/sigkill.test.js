import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { apply } from "../src/apply.js";
import { preview } from "../src/preview.js";
import { writeBundle } from "./support/bundles.js";
import { record } from "./support/faults.js";
import { prng } from "./support/prng.js";
import { buildScenario, makeScenario } from "./support/scenario.js";
import { snapshot, tempDir, writeTree } from "./support/tree.js";

/** @import { FaultPoint } from "../src/types.js" */
/** @import { Scenario } from "./support/scenario.js" */

const root = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(root, "..", "bin", "crash-safe-apply.js");
const HARNESS = path.join(root, "support", "kill-harness.js");
const run = promisify(execFile);

/**
 * @param {string[]} args
 * @returns {Promise<{ code: number, json: any }>}
 */
async function cli(...args) {
	try {
		const { stdout } = await run(process.execPath, [CLI, ...args, "--json"]);
		return { code: 0, json: JSON.parse(stdout) };
	} catch (error) {
		const failed = /** @type {{ code: number, stdout: string }} */ (error);
		return { code: failed.code, json: JSON.parse(failed.stdout) };
	}
}

/**
 * Starts the harness, waits until it reports the chosen step, then kill -9.
 * @param {Scenario} s
 * @param {string} plan
 * @param {number} seq
 */
async function killAt(s, plan, seq) {
	const child = spawn(process.execPath, [HARNESS, s.bundle, s.target, plan, String(seq)], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	let output = "";
	for await (const chunk of child.stdout) {
		output += chunk;
		if (output.includes("PAUSED") || output.includes("FINISHED")) break;
	}
	assert.match(output, /PAUSED/, `harness did not reach step ${seq}`);
	child.kill("SIGKILL");
	const [code, signal] = await once(child, "exit");
	assert.equal(signal, "SIGKILL");
	assert.equal(code, null);
}

/** @param {(p: FaultPoint) => boolean} predicate @param {FaultPoint[]} points */
function stepWhere(points, predicate) {
	const point = points.find(predicate);
	assert.ok(point, "no step matches");
	return point;
}

/** Every step of one uninterrupted apply of the standard scenario. */
async function recordSteps() {
	/** @type {FaultPoint[]} */
	const points = [];
	const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "csa-steps-")));
	try {
		const s = await buildScenario(dir);
		await apply({ bundle: s.bundle, target: s.target, faults: record(points) });
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
	return points;
}

describe("real kill -9 at chosen steps", async () => {
	const points = await recordSteps();

	/** @type {Array<[string, (p: FaultPoint) => boolean, string]>} */
	const cases = [
		[
			"originals and plan written, journal directory not yet published",
			(p) => p.step === "journal: prepared" && p.op === "fsync",
			"not-applied",
		],
		["journal directory published", (p) => p.step === "publish journal directory", "interrupted"],
		[
			"torn journal record",
			(p) => p.op === "write-partial" && p.step === "journal: file record",
			"interrupted",
		],
		[
			"replacement renamed into place, directory not yet fsynced",
			(p) => p.op === "rename" && p.step === "publish config/app.toml",
			"interrupted",
		],
		[
			"new file linked, temp not yet removed",
			(p) => p.op === "link" && p.step === "publish config/features.json",
			"interrupted",
		],
		[
			"all files applied, not yet verified",
			(p) => p.step === "journal: applied" && p.op === "fsync",
			"interrupted",
		],
	];

	for (const [label, predicate, expectedState] of cases) {
		it(`${label}: status says ${expectedState}; rollback restores; re-apply converges`, async (t) => {
			const step = stepWhere(points, predicate);
			for (const recovery of ["rollback", "apply"]) {
				const s = await makeScenario(t);
				const plan = (await preview({ bundle: s.bundle, target: s.target })).id;
				await killAt(s, plan, step.seq);
				const report = await cli("status", s.bundle, "--target", s.target);
				assert.equal(report.json.state, expectedState);
				assert.equal(report.code, expectedState === "interrupted" ? 3 : 0);
				if (label === "torn journal record") assert.ok(report.json.journal.discardedBytes > 0);
				if (recovery === "rollback") {
					assert.equal((await cli("rollback", s.bundle, "--target", s.target)).code, 0);
					assert.deepEqual(await snapshot(s.target), s.original);
				} else {
					assert.equal(
						(await cli("apply", s.bundle, "--target", s.target, "--plan", plan)).code,
						0,
					);
					assert.deepEqual(await snapshot(s.target), s.expected);
				}
			}
		});
	}
});

describe("real kill -9 of the CLI mid-apply", () => {
	const RUNS = 8;
	const FILES = 40;
	const random = prng(0xdead_beef);
	for (let index = 0; index < RUNS; index += 1) {
		// Leave a margin: on a fast disk the last few files can finish before SIGKILL lands.
		const afterFiles = 1 + random.int(FILES - 10);
		it(`run ${index + 1}: killed after ${afterFiles} of ${FILES} files were reported`, async (t) => {
			const dir = await tempDir(t);
			const target = path.join(dir, "target");
			/** @type {Record<string, string>} */
			const targetFiles = {};
			/** @type {Record<string, string>} */
			const bundleFiles = {};
			for (let n = 0; n < FILES; n += 1) {
				if (n % 2 === 0) targetFiles[`data/${n}.txt`] = `original ${n}\n`;
				bundleFiles[`data/${n}.txt`] = `new ${n}\n`.repeat(50);
			}
			await writeTree(target, targetFiles);
			const bundle = await writeBundle(path.join(dir, "bundle"), bundleFiles);
			const original = await snapshot(target);
			const child = spawn(process.execPath, [CLI, "apply", bundle, "--target", target, "--yes"], {
				stdio: ["ignore", "pipe", "ignore"],
			});
			let reported = 0;
			for await (const chunk of child.stdout) {
				reported += (String(chunk).match(/(created|replaced) +data\//g) ?? []).length;
				if (reported >= afterFiles) break;
			}
			child.kill("SIGKILL");
			const [, signal] = await once(child, "exit");
			assert.equal(signal, "SIGKILL");
			const report = await cli("status", bundle, "--target", target);
			assert.ok(["interrupted", "complete"].includes(report.json.state), report.json.state);
			const applied = report.json.files.filter(
				(/** @type {{ content: string }} */ f) => f.content === "installed",
			).length;
			t.diagnostic(`killed with ${applied} of ${FILES} files published (${report.json.state})`);
			if (index % 2 === 0) {
				assert.equal((await cli("rollback", bundle, "--target", target)).code, 0);
				assert.deepEqual(await snapshot(target), original);
			} else {
				assert.equal((await cli("apply", bundle, "--target", target, "--yes")).code, 0);
				assert.equal((await cli("status", bundle, "--target", target)).json.state, "complete");
			}
		});
	}
});
