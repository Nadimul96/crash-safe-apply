import assert from "node:assert/strict";
import { renameSync, symlinkSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { apply } from "../src/apply.js";
import { preview } from "../src/preview.js";
import { manifestFor, writeBundle, zipBundle } from "./support/bundles.js";
import { makeScenario } from "./support/scenario.js";
import { exists, snapshot, tempDir, writeTree } from "./support/tree.js";
import { buildZip } from "./support/zip-writer.js";

/**
 * A target, a file just outside it, and a helper that asserts an apply of
 * the given bundle is rejected before anything is written.
 * @param {import("node:test").TestContext} t
 */
async function arena(t) {
	const root = await tempDir(t);
	const target = path.join(root, "target");
	const outside = path.join(root, "outside");
	await writeTree(target, { "config/app.toml": "port = 1\n" });
	await writeTree(outside, { "secret.txt": "do not touch\n" });
	/** @param {string} bundle @param {string} code */
	const refused = async (bundle, code) => {
		const before = { target: await snapshot(target), outside: await snapshot(outside) };
		await assert.rejects(apply({ bundle, target }), { code });
		assert.deepEqual(await snapshot(target), before.target);
		assert.deepEqual(await snapshot(outside), before.outside);
	};
	return { root, target, outside, refused };
}

describe("hostile bundles are rejected before any write", () => {
	for (const evil of [
		"../outside/secret.txt",
		"config/../../outside/secret.txt",
		"/etc/passwd",
		".git/hooks/pre-commit",
		".crash-safe-apply/lock",
		"a\\..\\b",
	]) {
		it(`manifest path ${JSON.stringify(evil)}`, async (t) => {
			const { root, refused } = await arena(t);
			const bundle = await writeBundle(
				path.join(root, "bundle"),
				{ "x.txt": "x" },
				{ manifest: manifestFor({ [evil]: "x" }) },
			);
			await refused(bundle, "UNSAFE_PATH");
		});
	}

	it("ZIP entry names that climb out of files/", async (t) => {
		const { root, refused } = await arena(t);
		const manifest = Buffer.from(JSON.stringify(manifestFor({ "a.txt": "a" })));
		await fs.writeFile(
			path.join(root, "slip.zip"),
			buildZip([
				{ name: "manifest.json", data: manifest },
				{ name: "files/../../outside/secret.txt", data: Buffer.from("a") },
			]),
		);
		await refused(path.join(root, "slip.zip"), "UNSAFE_PATH");
	});

	it("ZIP symlink entries", async (t) => {
		const { root, refused } = await arena(t);
		const manifest = Buffer.from(JSON.stringify(manifestFor({ "a.txt": "/etc/passwd" })));
		await fs.writeFile(
			path.join(root, "link.zip"),
			buildZip([
				{ name: "manifest.json", data: manifest },
				{ name: "files/a.txt", data: Buffer.from("/etc/passwd"), unixMode: 0o120777 },
			]),
		);
		await refused(path.join(root, "link.zip"), "INVALID_ZIP");
	});

	it("case-colliding paths and file/directory clashes", async (t) => {
		const { root, refused } = await arena(t);
		const clash = await writeBundle(
			path.join(root, "clash"),
			{ "a.txt": "1" },
			{ manifest: manifestFor({ "a.txt": "1", "A.TXT": "2" }) },
		);
		await refused(clash, "UNSAFE_PATH");
		const nested = await writeBundle(
			path.join(root, "nested"),
			{ x: "1" },
			{ manifest: manifestFor({ x: "1", "x/y": "2" }) },
		);
		await refused(nested, "UNSAFE_PATH");
	});

	it("a valid ZIP bundle still works end to end", async (t) => {
		const { root, target } = await arena(t);
		await fs.writeFile(path.join(root, "ok.zip"), zipBundle({ "config/app.toml": "port = 2\n" }));
		await apply({ bundle: path.join(root, "ok.zip"), target });
		assert.equal(await fs.readFile(path.join(target, "config/app.toml"), "utf8"), "port = 2\n");
	});
});

describe("symlinks in the target are never followed", () => {
	it("a symlinked parent directory", async (t) => {
		const { root, target, outside, refused } = await arena(t);
		await fs.symlink(outside, path.join(target, "linked"));
		const bundle = await writeBundle(path.join(root, "bundle"), { "linked/secret.txt": "pwned\n" });
		await refused(bundle, "UNSAFE_PATH");
	});

	it("a symlink at the destination itself", async (t) => {
		const { root, target, outside, refused } = await arena(t);
		await fs.symlink(path.join(outside, "secret.txt"), path.join(target, "app.conf"));
		const bundle = await writeBundle(path.join(root, "bundle"), { "app.conf": "pwned\n" });
		await refused(bundle, "UNSAFE_PATH");
	});

	it("a parent swapped for a symlink in the middle of apply", async (t) => {
		const s = await makeScenario(t);
		const outside = path.join(s.root, "outside");
		await writeTree(outside, { "features.json": "theirs\n" });
		const before = await snapshot(outside);
		await assert.rejects(
			apply({
				bundle: s.bundle,
				target: s.target,
				faults: (point) => {
					if (point.step === "publish config/app.toml" && point.op === "rename") {
						renameSync(path.join(s.target, "config"), path.join(s.root, "moved-config"));
						symlinkSync(outside, path.join(s.target, "config"));
					}
				},
			}),
			{ code: "CHANGED_AFTER_PREVIEW" },
		);
		assert.deepEqual(await snapshot(outside), before);
	});

	it("a hard-linked target file: only the name is replaced", async (t) => {
		const { root, target } = await arena(t);
		const shared = path.join(root, "outside", "secret.txt");
		await fs.link(shared, path.join(target, "shared.txt"));
		const bundle = await writeBundle(path.join(root, "bundle"), { "shared.txt": "new\n" });
		await apply({ bundle, target });
		assert.equal(await fs.readFile(path.join(target, "shared.txt"), "utf8"), "new\n");
		assert.equal(await fs.readFile(shared, "utf8"), "do not touch\n");
	});

	it("a target given as a symlink", async (t) => {
		const s = await makeScenario(t);
		await fs.symlink(s.target, path.join(s.root, "alias"));
		await assert.rejects(preview({ bundle: s.bundle, target: path.join(s.root, "alias") }), {
			code: "INVALID_TARGET",
		});
		assert.equal(await exists(path.join(s.target, ".crash-safe-apply")), false);
	});
});
