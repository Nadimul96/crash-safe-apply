import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { apply } from "../src/apply.js";
import { preview } from "../src/preview.js";
import { rollback } from "../src/rollback.js";
import { status } from "../src/status.js";
import { crashAt } from "./support/faults.js";
import { makeScenario } from "./support/scenario.js";
import { snapshot } from "./support/tree.js";

describe("status", () => {
	it("before anything is applied: not-applied with a plan to apply", async (t) => {
		const s = await makeScenario(t);
		const report = await status({ bundle: s.bundle, target: s.target });
		const plan = await preview({ bundle: s.bundle, target: s.target });
		assert.equal(report.state, "not-applied");
		assert.equal(report.journal, null);
		assert.equal(report.plan?.id, plan.id);
		assert.deepEqual(report.next, [
			{ command: "apply", plan: plan.id, reason: "apply the previewed plan" },
		]);
		assert.deepEqual(await snapshot(s.target), s.original, "status is read-only");
	});

	it("after a crash mid-apply: interrupted, with resume and rollback as next steps", async (t) => {
		const s = await makeScenario(t);
		const plan = await preview({ bundle: s.bundle, target: s.target });
		await assert.rejects(
			apply({
				bundle: s.bundle,
				target: s.target,
				plan: plan.id,
				faults: crashAt((p) => p.step === "publish config/features.json"),
			}),
		);
		const report = await status({ bundle: s.bundle, target: s.target });
		assert.equal(report.state, "interrupted");
		assert.equal(report.phase, "apply");
		assert.equal(report.lock?.alive, false);
		assert.deepEqual(
			report.files.map((f) => [f.path, f.status, f.content]),
			[
				["config/app.toml", "applied", "installed"],
				["config/features.json", "applying", "installed"],
				["config/tls/ciphers.conf", "pending", "original"],
				["bin/health.sh", "pending", "original"],
			],
		);
		assert.equal(report.files[1]?.tempPresent, true);
		assert.deepEqual(
			report.next.map((n) => [n.command, n.plan]),
			[
				["apply", plan.id],
				["rollback", null],
			],
		);
	});

	it("after a crash mid-rollback: interrupted during rollback", async (t) => {
		const s = await makeScenario(t);
		await apply({ bundle: s.bundle, target: s.target });
		await assert.rejects(
			rollback({
				bundle: s.bundle,
				target: s.target,
				faults: crashAt((p) => p.step === "remove bin/health.sh"),
			}),
		);
		const report = await status({ bundle: s.bundle, target: s.target });
		assert.equal(report.state, "interrupted");
		assert.equal(report.phase, "rollback");
		assert.deepEqual(
			report.next.map((n) => n.command),
			["rollback"],
		);
	});

	it("reports a torn journal tail", async (t) => {
		const s = await makeScenario(t);
		const { journal } = await apply({ bundle: s.bundle, target: s.target });
		const torn = '0badc0de {"seq":99,"tor';
		await fs.appendFile(journal ?? "", torn);
		const report = await status({ bundle: s.bundle, target: s.target });
		assert.equal(report.journal?.discardedBytes, Buffer.byteLength(torn));
		assert.equal(report.state, "complete");
		await rollback({ bundle: s.bundle, target: s.target });
		assert.deepEqual(await snapshot(s.target), s.original);
	});

	it("after rollback: restored, with the plan to apply again", async (t) => {
		const s = await makeScenario(t);
		await apply({ bundle: s.bundle, target: s.target });
		await rollback({ bundle: s.bundle, target: s.target });
		const report = await status({ bundle: s.bundle, target: s.target });
		assert.equal(report.state, "restored");
		assert.equal(report.next[0]?.command, "apply");
		assert.equal(
			report.journal?.path,
			path.join(s.target, ".crash-safe-apply", report.bundle.id, "1", "journal.log"),
		);
	});
});
