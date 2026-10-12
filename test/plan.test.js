import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { preview } from "../src/preview.js";
import { writeBundle } from "./support/bundles.js";
import { makeScenario } from "./support/scenario.js";
import { exists, snapshot } from "./support/tree.js";

describe("preview", () => {
	it("classifies every bundle file and lists directories to create", async (t) => {
		const s = await makeScenario(t);
		const plan = await preview({ bundle: s.bundle, target: s.target });
		assert.deepEqual(
			plan.changes.map((c) => [c.path, c.action, c.mode.toString(8)]),
			[
				["config/app.toml", "replace", "644"],
				["config/features.json", "create", "644"],
				["config/tls/ciphers.conf", "create", "644"],
				["README.md", "unchanged", "644"],
				["bin/health.sh", "create", "755"],
			],
		);
		assert.deepEqual(plan.directories, ["bin", "config/tls"]);
		assert.deepEqual(plan.summary, {
			create: 3,
			replace: 1,
			unchanged: 1,
			bytes: plan.summary.bytes,
		});
		assert.match(plan.id, /^[0-9a-f]{16}$/);
		assert.equal(plan.changes[0]?.original?.size, "port = 8080\nworkers = 2\n".length);
	});

	it("writes nothing, not even the state directory", async (t) => {
		const s = await makeScenario(t);
		await preview({ bundle: s.bundle, target: s.target });
		assert.deepEqual(await snapshot(s.target), s.original);
		assert.equal(await exists(path.join(s.target, ".crash-safe-apply")), false);
	});

	it("gives the same plan id for the same inputs", async (t) => {
		const s = await makeScenario(t);
		const first = await preview({ bundle: s.bundle, target: s.target });
		const second = await preview({ bundle: s.bundle, target: s.target });
		assert.equal(first.id, second.id);
	});

	it("changes the plan id when content, mode or inode changes", async (t) => {
		const s = await makeScenario(t);
		const file = path.join(s.target, "config/app.toml");
		const ids = new Set([(await preview({ bundle: s.bundle, target: s.target })).id]);
		await fs.chmod(file, 0o600);
		ids.add((await preview({ bundle: s.bundle, target: s.target })).id);
		await fs.chmod(file, 0o644);
		await fs.writeFile(`${file}.new`, await fs.readFile(file));
		await fs.rename(`${file}.new`, file);
		ids.add((await preview({ bundle: s.bundle, target: s.target })).id);
		await fs.writeFile(path.join(s.target, "README.md"), "# edited\n");
		ids.add((await preview({ bundle: s.bundle, target: s.target })).id);
		assert.equal(ids.size, 4);
	});

	it("treats a mode-only difference as a replacement", async (t) => {
		const s = await makeScenario(t, {
			targetFiles: { "run.sh": "#!/bin/sh\n" },
			bundleFiles: { "run.sh": { content: "#!/bin/sh\n", mode: "0755" } },
		});
		const plan = await preview({ bundle: s.bundle, target: s.target });
		assert.equal(plan.changes[0]?.action, "replace");
	});

	it("refuses to replace setuid files and non-regular files", async (t) => {
		const s = await makeScenario(t, { targetFiles: { tool: "old" }, bundleFiles: { tool: "new" } });
		await fs.chmod(path.join(s.target, "tool"), 0o4755);
		await assert.rejects(preview({ bundle: s.bundle, target: s.target }), {
			code: "UNSUPPORTED_FILE",
			message: /setuid/,
		});
		await fs.mkdir(path.join(s.target, "dir"));
		await writeBundle(path.join(s.root, "b2"), { dir: "a file where a directory is" });
		await assert.rejects(preview({ bundle: path.join(s.root, "b2"), target: s.target }), {
			code: "UNSUPPORTED_FILE",
			message: /not a regular file/,
		});
	});

	it("requires an existing, real target directory", async (t) => {
		const s = await makeScenario(t);
		await assert.rejects(preview({ bundle: s.bundle, target: path.join(s.root, "nope") }), {
			code: "INVALID_TARGET",
		});
		await fs.symlink(s.target, path.join(s.root, "link"));
		await assert.rejects(preview({ bundle: s.bundle, target: path.join(s.root, "link") }), {
			code: "INVALID_TARGET",
			message: /symlink/,
		});
	});
});
