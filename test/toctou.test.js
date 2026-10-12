import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { apply } from "../src/apply.js";
import { Io } from "../src/io.js";
import { preview } from "../src/preview.js";
import { publish } from "../src/publish.js";
import { rollback } from "../src/rollback.js";
import { status } from "../src/status.js";
import { makeScenario } from "./support/scenario.js";
import { exists, snapshot } from "./support/tree.js";

/** @import { Scenario } from "./support/scenario.js" */

/**
 * Previews, lets `change` modify the target, then applies the previewed plan.
 * @param {Scenario} s
 * @param {() => Promise<void>} change
 */
async function applyAfter(s, change) {
	const plan = await preview({ bundle: s.bundle, target: s.target });
	await change();
	const before = await snapshot(s.target);
	await assert.rejects(apply({ bundle: s.bundle, target: s.target, plan: plan.id }), {
		code: "PLAN_MISMATCH",
	});
	assert.deepEqual(await snapshot(s.target), before, "a refused apply must not change the target");
	assert.equal(
		await exists(
			path.join(
				s.target,
				".crash-safe-apply",
				(await status({ bundle: s.bundle, target: s.target })).bundle.id,
			),
		),
		false,
	);
}

describe("changes between preview and apply are refused", () => {
	it("content of a file to be replaced", async (t) => {
		const s = await makeScenario(t);
		await applyAfter(s, () =>
			fs.writeFile(path.join(s.target, "config/app.toml"), "port = 9999\n"),
		);
	});

	it("a file appearing where apply would create one", async (t) => {
		const s = await makeScenario(t);
		await applyAfter(s, () => fs.writeFile(path.join(s.target, "config/features.json"), "{}\n"));
	});

	it("a directory appearing where apply would create one", async (t) => {
		const s = await makeScenario(t);
		await applyAfter(s, () => fs.mkdir(path.join(s.target, "config/tls")));
	});

	it("a file replaced by an identical copy (new inode)", async (t) => {
		const s = await makeScenario(t);
		const file = path.join(s.target, "config/app.toml");
		await applyAfter(s, async () => {
			await fs.copyFile(file, `${file}.copy`);
			await fs.rename(`${file}.copy`, file);
		});
	});

	it("a permission change", async (t) => {
		const s = await makeScenario(t);
		await applyAfter(s, () => fs.chmod(path.join(s.target, "config/app.toml"), 0o600));
	});

	it("an unchanged file that is no longer unchanged", async (t) => {
		const s = await makeScenario(t);
		await applyAfter(s, () => fs.writeFile(path.join(s.target, "README.md"), "# edited\n"));
	});
});

describe("changes during apply are refused and recoverable", () => {
	it("a file edited after the journal is prepared is left alone; rollback restores the rest", async (t) => {
		const s = await makeScenario(t);
		const edited = path.join(s.target, "bin/health.sh");
		const plan = await preview({ bundle: s.bundle, target: s.target });
		await assert.rejects(
			apply({
				bundle: s.bundle,
				target: s.target,
				plan: plan.id,
				// After config/app.toml is published, someone creates bin/health.sh.
				faults: (point) => {
					if (point.op === "rename" && point.step === "publish config/app.toml")
						writeFileSync(edited, "theirs\n");
				},
			}),
			{ code: "CHANGED_AFTER_PREVIEW", message: /bin\/health\.sh was modified after preview/ },
		);
		assert.equal(await fs.readFile(edited, "utf8"), "theirs\n");
		const report = await status({ bundle: s.bundle, target: s.target });
		assert.equal(report.state, "incomplete");
		assert.deepEqual(report.rollbackBlockers, []);
		const result = await rollback({ bundle: s.bundle, target: s.target });
		assert.ok(
			result.files.some((f) => f.path === "bin/health.sh" && f.action.startsWith("left alone")),
		);
		assert.equal(await fs.readFile(edited, "utf8"), "theirs\n");
		const restored = (await snapshot(s.target)).filter((line) => !line.includes("bin"));
		assert.deepEqual(restored, s.original);
	});

	it("a file replaced right before its rename is refused", async (t) => {
		const s = await makeScenario(t);
		const target = path.join(s.target, "config/app.toml");
		await assert.rejects(
			apply({
				bundle: s.bundle,
				target: s.target,
				faults: (point) => {
					if (point.op === "fsync" && point.step === "stage config/app.toml")
						writeFileSync(target, "last-second edit\n");
				},
			}),
			{ code: "CHANGED_AFTER_PREVIEW" },
		);
		assert.equal(await fs.readFile(target, "utf8"), "last-second edit\n");
	});

	it("link(2) refuses to clobber a file that appears at the last moment", async (t) => {
		const s = await makeScenario(t);
		const temp = path.join(s.target, "temp-file");
		const destination = path.join(s.target, "late.txt");
		await fs.writeFile(temp, "ours\n");
		await fs.writeFile(destination, "theirs\n");
		const io = new Io(s.target);
		await assert.rejects(
			publish(io, { absolute: destination, temp, relative: "late.txt", how: "create" }),
			{
				code: "CONFLICT",
				message: /appeared after it was checked/,
			},
		);
		assert.equal(await fs.readFile(destination, "utf8"), "theirs\n");
		assert.equal(await exists(temp), false);
	});
});
