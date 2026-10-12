import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { apply } from "../src/apply.js";
import { preview } from "../src/preview.js";
import { rollback } from "../src/rollback.js";
import { status } from "../src/status.js";
import { makeScenario } from "./support/scenario.js";
import { exists, snapshot } from "./support/tree.js";

describe("apply", () => {
	it("applies the previewed plan and verifies every file", async (t) => {
		const s = await makeScenario(t);
		const plan = await preview({ bundle: s.bundle, target: s.target });
		const result = await apply({ bundle: s.bundle, target: s.target, plan: plan.id });
		assert.equal(result.outcome, "applied");
		assert.deepEqual(await snapshot(s.target), s.expected);
		assert.deepEqual(
			result.files.map((f) => [f.path, f.action]),
			[
				["config/app.toml", "replaced"],
				["config/features.json", "created"],
				["config/tls/ciphers.conf", "created"],
				["bin/health.sh", "created"],
			],
		);
		assert.ok(result.journal && (await exists(result.journal)));
		assert.ok(result.io.fsyncs > 0 && result.io.dirFsyncs > 0);
		assert.equal((await status({ bundle: s.bundle, target: s.target })).state, "complete");
	});

	it("is idempotent: a second apply changes nothing", async (t) => {
		const s = await makeScenario(t);
		await apply({ bundle: s.bundle, target: s.target });
		const again = await apply({ bundle: s.bundle, target: s.target });
		assert.equal(again.outcome, "already-applied");
		assert.deepEqual(await snapshot(s.target), s.expected);
	});

	it("does nothing when the target already matches", async (t) => {
		const s = await makeScenario(t, {
			targetFiles: { "a.txt": "same" },
			bundleFiles: { "a.txt": "same" },
		});
		const result = await apply({ bundle: s.bundle, target: s.target });
		assert.equal(result.outcome, "nothing-to-do");
		assert.equal(result.journal, null);
		assert.equal((await status({ bundle: s.bundle, target: s.target })).state, "not-applied");
	});

	it("keeps the existing mode on replace unless the manifest sets one", async (t) => {
		const s = await makeScenario(t, {
			targetFiles: {
				"keep.sh": { content: "old\n", mode: 0o700 },
				"set.sh": { content: "old\n", mode: 0o600 },
			},
			bundleFiles: { "keep.sh": "new\n", "set.sh": { content: "new\n", mode: "0750" } },
		});
		await apply({ bundle: s.bundle, target: s.target });
		assert.equal((await fs.stat(path.join(s.target, "keep.sh"))).mode & 0o777, 0o700);
		assert.equal((await fs.stat(path.join(s.target, "set.sh"))).mode & 0o777, 0o750);
	});

	it("leaves no temp files behind", async (t) => {
		const s = await makeScenario(t);
		await apply({ bundle: s.bundle, target: s.target });
		const leftovers = (await snapshot(s.target)).filter((line) =>
			line.includes(".crash-safe-apply-"),
		);
		assert.deepEqual(leftovers, []);
	});

	it("starts a new journal generation when re-applied after a rollback", async (t) => {
		const s = await makeScenario(t);
		const first = await apply({ bundle: s.bundle, target: s.target });
		await rollback({ bundle: s.bundle, target: s.target });
		const second = await apply({ bundle: s.bundle, target: s.target });
		assert.equal(path.basename(path.dirname(first.journal ?? "")), "1");
		assert.equal(path.basename(path.dirname(second.journal ?? "")), "2");
		assert.deepEqual(await snapshot(s.target), s.expected);
		await rollback({ bundle: s.bundle, target: s.target });
		assert.deepEqual(await snapshot(s.target), s.original);
	});

	it("refuses to start over a complete apply that has drifted", async (t) => {
		const s = await makeScenario(t);
		await apply({ bundle: s.bundle, target: s.target });
		await fs.writeFile(path.join(s.target, "config/features.json"), "{}\n");
		await assert.rejects(apply({ bundle: s.bundle, target: s.target }), {
			code: "WRONG_PHASE",
			message: /has changed since/,
		});
	});

	it("reports progress events in order", async (t) => {
		const s = await makeScenario(t);
		/** @type {string[]} */
		const events = [];
		await apply({
			bundle: s.bundle,
			target: s.target,
			onProgress: (e) => events.push(e.kind === "state" ? e.state : `${e.action} ${e.path}`),
		});
		assert.deepEqual(events, [
			"applying",
			"replaced config/app.toml",
			"created config/features.json",
			"created config/tls/ciphers.conf",
			"created bin/health.sh",
			"applied",
			"complete",
		]);
	});
});
