import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { apply } from "../src/apply.js";
import { rollback } from "../src/rollback.js";
import { status } from "../src/status.js";
import { makeScenario } from "./support/scenario.js";
import { snapshot } from "./support/tree.js";

describe("rollback", () => {
	it("restores a byte-identical tree", async (t) => {
		const s = await makeScenario(t);
		await apply({ bundle: s.bundle, target: s.target });
		const result = await rollback({ bundle: s.bundle, target: s.target });
		assert.equal(result.outcome, "restored");
		assert.deepEqual(await snapshot(s.target), s.original);
		assert.deepEqual(
			result.files.map((f) => [f.path, f.action]),
			[
				["config/app.toml", "restored"],
				["config/features.json", "removed"],
				["config/tls/ciphers.conf", "removed"],
				["bin/health.sh", "removed"],
			],
		);
		assert.equal((await status({ bundle: s.bundle, target: s.target })).state, "restored");
	});

	it("is idempotent and safe when nothing was applied", async (t) => {
		const s = await makeScenario(t);
		assert.equal(
			(await rollback({ bundle: s.bundle, target: s.target })).outcome,
			"nothing-to-roll-back",
		);
		await apply({ bundle: s.bundle, target: s.target });
		await rollback({ bundle: s.bundle, target: s.target });
		assert.equal(
			(await rollback({ bundle: s.bundle, target: s.target })).outcome,
			"already-restored",
		);
		assert.deepEqual(await snapshot(s.target), s.original);
	});

	it("refuses, changing nothing, when an applied file was edited", async (t) => {
		const s = await makeScenario(t);
		await apply({ bundle: s.bundle, target: s.target });
		await fs.writeFile(path.join(s.target, "config/app.toml"), "# my edit\n");
		const before = await snapshot(s.target);
		await assert.rejects(rollback({ bundle: s.bundle, target: s.target }), {
			code: "CONFLICT",
			message: /config\/app\.toml changed after apply/,
		});
		assert.deepEqual(await snapshot(s.target), before);
		const report = await status({ bundle: s.bundle, target: s.target });
		assert.deepEqual(report.rollbackBlockers, ["config/app.toml"]);
		assert.equal(report.state, "complete");
	});

	it("restores an original whose replacement was deleted", async (t) => {
		const s = await makeScenario(t);
		await apply({ bundle: s.bundle, target: s.target });
		await fs.unlink(path.join(s.target, "config/app.toml"));
		await rollback({ bundle: s.bundle, target: s.target });
		assert.deepEqual(await snapshot(s.target), s.original);
	});

	it("keeps a created directory that now holds someone else's file", async (t) => {
		const s = await makeScenario(t);
		await apply({ bundle: s.bundle, target: s.target });
		await fs.writeFile(path.join(s.target, "config/tls/mine.pem"), "user data\n");
		const result = await rollback({ bundle: s.bundle, target: s.target });
		assert.deepEqual(result.keptDirectories, ["config/tls"]);
		assert.equal(
			await fs.readFile(path.join(s.target, "config/tls/mine.pem"), "utf8"),
			"user data\n",
		);
	});

	it("refuses when a backup is damaged, before changing anything", async (t) => {
		const s = await makeScenario(t);
		const { journal } = await apply({ bundle: s.bundle, target: s.target });
		const backup = path.join(path.dirname(journal ?? ""), "originals", "0");
		await fs.chmod(backup, 0o600);
		await fs.writeFile(backup, "corrupted");
		const before = await snapshot(s.target);
		await assert.rejects(rollback({ bundle: s.bundle, target: s.target }), {
			code: "INVALID_JOURNAL",
			message: /backup/,
		});
		assert.deepEqual(await snapshot(s.target), before);
	});
});
