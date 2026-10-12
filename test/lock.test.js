import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { apply } from "../src/apply.js";
import { rollback } from "../src/rollback.js";
import { status } from "../src/status.js";
import { makeScenario } from "./support/scenario.js";
import { snapshot } from "./support/tree.js";

/** @param {string} target @param {object | string} content */
async function plantLock(target, content) {
	const dir = path.join(target, ".crash-safe-apply");
	await fs.mkdir(dir, { mode: 0o700, recursive: true });
	await fs.writeFile(
		path.join(dir, "lock"),
		typeof content === "string" ? content : JSON.stringify(content),
	);
}

function deadPid() {
	const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
	return Number(child.stdout.toString());
}

describe("lock", () => {
	it("refuses a second run while the first is active, and status says in-progress", async (t) => {
		const s = await makeScenario(t);
		const gate = Promise.withResolvers();
		const reached = Promise.withResolvers();
		const first = apply({
			bundle: s.bundle,
			target: s.target,
			faults: async (point) => {
				if (point.step === "journal: applying" && point.op === "fsync") {
					reached.resolve(undefined);
					await gate.promise;
				}
			},
		});
		await reached.promise;
		await assert.rejects(apply({ bundle: s.bundle, target: s.target }), {
			code: "LOCKED",
			message: /apply, pid/,
		});
		await assert.rejects(rollback({ bundle: s.bundle, target: s.target }), { code: "LOCKED" });
		const report = await status({ bundle: s.bundle, target: s.target });
		assert.equal(report.state, "in-progress");
		assert.equal(report.lock?.alive, true);
		assert.deepEqual(report.next, []);
		gate.resolve(undefined);
		assert.equal((await first).outcome, "applied");
		assert.deepEqual(await snapshot(s.target), s.expected);
	});

	it("clears a lock left by a process that no longer exists", async (t) => {
		const s = await makeScenario(t);
		await plantLock(s.target, {
			pid: deadPid(),
			host: os.hostname(),
			runId: "gone",
			command: "apply",
			bundle: "x",
			startedAt: "earlier",
		});
		await apply({ bundle: s.bundle, target: s.target });
		assert.deepEqual(await snapshot(s.target), s.expected);
	});

	it("treats an unreadable lock as stale", async (t) => {
		const s = await makeScenario(t);
		await plantLock(s.target, "\u0000\u0000garbage");
		await apply({ bundle: s.bundle, target: s.target });
		assert.deepEqual(await snapshot(s.target), s.expected);
	});

	it("does not break a lock held from another host", async (t) => {
		const s = await makeScenario(t);
		await plantLock(s.target, {
			pid: 1,
			host: "some-other-host",
			runId: "r",
			command: "apply",
			bundle: "x",
			startedAt: "now",
		});
		await assert.rejects(apply({ bundle: s.bundle, target: s.target }), {
			code: "LOCKED",
			message: /some-other-host/,
		});
		assert.deepEqual(await snapshot(s.target), s.original);
	});

	it("refuses a state directory that other users can read", async (t) => {
		const s = await makeScenario(t);
		await fs.mkdir(path.join(s.target, ".crash-safe-apply"), { mode: 0o755 });
		await fs.chmod(path.join(s.target, ".crash-safe-apply"), 0o755);
		await assert.rejects(apply({ bundle: s.bundle, target: s.target }), {
			code: "INVALID_TARGET",
			message: /0700/,
		});
	});
});
