import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { loadBundle } from "../src/bundle.js";
import { DEFAULT_LIMITS, resolveLimits } from "../src/constants.js";
import { manifestFor, writeBundle, zipBundle } from "./support/bundles.js";
import { sha256, tempDir } from "./support/tree.js";
import { buildZip } from "./support/zip-writer.js";

const FILES = {
	"config/app.toml": "port = 1\n",
	"bin/run.sh": { content: "#!/bin/sh\n", mode: "0755" },
};

describe("loadBundle", () => {
	it("loads a directory bundle and a ZIP bundle to the same result", async (t) => {
		const dir = await tempDir(t);
		const fromDir = await loadBundle(
			await writeBundle(path.join(dir, "b"), FILES, { name: "demo" }),
			DEFAULT_LIMITS,
		);
		await fs.writeFile(path.join(dir, "b.zip"), zipBundle(FILES, { name: "demo" }));
		const fromZip = await loadBundle(path.join(dir, "b.zip"), DEFAULT_LIMITS);
		assert.equal(fromDir.kind, "directory");
		assert.equal(fromZip.kind, "zip");
		assert.equal(fromDir.id, fromZip.id);
		assert.equal(fromDir.name, "demo");
		assert.deepEqual(
			fromDir.files.map((f) => [f.path, f.sha256, f.mode]),
			[
				["config/app.toml", sha256("port = 1\n"), null],
				["bin/run.sh", sha256("#!/bin/sh\n"), 0o755],
			],
		);
		assert.equal(fromDir.digest.slice(0, 16), fromDir.id);
	});

	it("rejects content that does not match its sha256", async (t) => {
		const dir = await tempDir(t);
		const manifest = manifestFor({ "a.txt": "expected" });
		await writeBundle(path.join(dir, "b"), { "a.txt": "tampered" }, { manifest });
		await assert.rejects(loadBundle(path.join(dir, "b"), DEFAULT_LIMITS), {
			code: "INVALID_BUNDLE",
			message: /sha256 mismatch for a\.txt/,
		});
	});

	it("rejects unlisted and missing payload files", async (t) => {
		const dir = await tempDir(t);
		await writeBundle(
			path.join(dir, "extra"),
			{ "a.txt": "a", "b.txt": "b" },
			{ manifest: manifestFor({ "a.txt": "a" }) },
		);
		await assert.rejects(
			loadBundle(path.join(dir, "extra"), DEFAULT_LIMITS),
			/files\/b\.txt is not listed/,
		);
		await writeBundle(
			path.join(dir, "missing"),
			{ "a.txt": "a" },
			{ manifest: manifestFor({ "a.txt": "a", "b.txt": "b" }) },
		);
		await assert.rejects(
			loadBundle(path.join(dir, "missing"), DEFAULT_LIMITS),
			/Missing files\/b\.txt/,
		);
	});

	it("rejects symlinks inside a directory bundle", async (t) => {
		const dir = await tempDir(t);
		const bundle = await writeBundle(path.join(dir, "b"), { "a.txt": "a" });
		await fs.symlink("/etc/hosts", path.join(bundle, "files", "hosts"));
		await assert.rejects(loadBundle(bundle, DEFAULT_LIMITS), {
			code: "INVALID_BUNDLE",
			message: /symlink/,
		});
	});

	it("rejects a bundle path that is itself a symlink", async (t) => {
		const dir = await tempDir(t);
		const bundle = await writeBundle(path.join(dir, "b"), { "a.txt": "a" });
		await fs.symlink(bundle, path.join(dir, "link"));
		await assert.rejects(
			loadBundle(path.join(dir, "link"), DEFAULT_LIMITS),
			/must not be a symlink/,
		);
	});

	it("validates the manifest strictly", async (t) => {
		const dir = await tempDir(t);
		const cases = [
			[{ format: "other", files: [] }, /format must be one of/],
			[{ format: "crash-safe-apply/bundle@1", files: [] }, /lists no files/],
			[{ ...manifestFor({ "a.txt": "a" }), extra: 1 }, /unknown field "extra"/],
			[
				{ format: "crash-safe-apply/bundle@1", files: [{ path: "a.txt", sha256: "nothex" }] },
				/sha256 has an invalid value/,
			],
			[
				{
					format: "crash-safe-apply/bundle@1",
					files: [{ path: "a.txt", sha256: sha256("a"), mode: "4755" }],
				},
				/mode has an invalid value/,
			],
			[
				{ format: "crash-safe-apply/bundle@1", files: [{ path: "../a.txt", sha256: sha256("a") }] },
				/Unsafe path/,
			],
			[
				{
					format: "crash-safe-apply/bundle@1",
					name: "has spaces",
					files: [{ path: "a.txt", sha256: sha256("a") }],
				},
				/name has an invalid value/,
			],
		];
		for (const [index, [manifest, reason]] of cases.entries()) {
			const bundle = await writeBundle(
				path.join(dir, `case${index}`),
				{ "a.txt": "a" },
				{ manifest: /** @type {object} */ (manifest) },
			);
			await assert.rejects(loadBundle(bundle, DEFAULT_LIMITS), {
				message: /** @type {RegExp} */ (reason),
			});
		}
	});

	it("rejects invalid JSON in the manifest", async (t) => {
		const dir = await tempDir(t);
		const bundle = await writeBundle(path.join(dir, "b"), { "a.txt": "a" });
		await fs.writeFile(path.join(bundle, "manifest.json"), "{ not json");
		await assert.rejects(loadBundle(bundle, DEFAULT_LIMITS), /not valid UTF-8 JSON/);
	});

	it("enforces file count and size limits", async (t) => {
		const dir = await tempDir(t);
		const bundle = await writeBundle(path.join(dir, "b"), {
			"a.txt": "aaaa",
			"b.txt": "bbbb",
			"c.txt": "cccc",
		});
		await assert.rejects(
			loadBundle(bundle, resolveLimits({ maxFiles: 2 })),
			/more than 2 entries|More than 2 files/,
		);
		await assert.rejects(loadBundle(bundle, resolveLimits({ maxFileBytes: 3 })), /larger than/i);
		await assert.rejects(
			loadBundle(bundle, resolveLimits({ maxTotalBytes: 10 })),
			/exceeds 10 bytes/,
		);
	});

	it("rejects ZIP entries outside files/ and archives without a manifest", async (t) => {
		const dir = await tempDir(t);
		const manifest = Buffer.from(JSON.stringify(manifestFor({ "a.txt": "a" })));
		await fs.writeFile(
			path.join(dir, "stray.zip"),
			buildZip([
				{ name: "manifest.json", data: manifest },
				{ name: "files/a.txt", data: Buffer.from("a") },
				{ name: "run.sh", data: Buffer.from("x") },
			]),
		);
		await assert.rejects(
			loadBundle(path.join(dir, "stray.zip"), DEFAULT_LIMITS),
			/outside files\//,
		);
		await fs.writeFile(
			path.join(dir, "bare.zip"),
			buildZip([{ name: "files/a.txt", data: Buffer.from("a") }]),
		);
		await assert.rejects(
			loadBundle(path.join(dir, "bare.zip"), DEFAULT_LIMITS),
			/no manifest\.json/,
		);
	});
});
