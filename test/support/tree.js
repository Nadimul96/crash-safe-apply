import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const STATE_DIR = ".crash-safe-apply";

/**
 * @typedef {string | Buffer | { content: string | Buffer, mode?: number }} FileSpec
 */

/**
 * A fresh, canonical temp directory that is removed when the test ends.
 * @param {import("node:test").TestContext} t
 * @param {string} [prefix]
 */
export async function tempDir(t, prefix = "csa-") {
	const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	return dir;
}

/**
 * @param {string} root
 * @param {Record<string, FileSpec>} files
 */
export async function writeTree(root, files) {
	for (const [relative, spec] of Object.entries(files)) {
		const file = path.join(root, relative);
		await fs.mkdir(path.dirname(file), { recursive: true });
		const { content, mode } = normalize(spec);
		await fs.writeFile(file, content);
		await fs.chmod(file, mode ?? 0o644);
	}
}

/**
 * @param {FileSpec} spec
 * @returns {{ content: string | Buffer, mode?: number }}
 */
export function normalize(spec) {
	return typeof spec === "string" || Buffer.isBuffer(spec) ? { content: spec } : spec;
}

/**
 * Every entry under `root` (except the tool's state directory) as one line:
 * type, permission bits, path, and a content hash for files. Two snapshots are
 * equal exactly when the trees are byte-identical in content, names and modes.
 * @param {string} root
 * @returns {Promise<string[]>}
 */
export async function snapshot(root) {
	/** @type {string[]} */
	const lines = [];
	/** @param {string} relative */
	async function visit(relative) {
		const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
		for (const entry of entries) {
			const child = relative ? `${relative}/${entry.name}` : entry.name;
			if (child === STATE_DIR) continue;
			const absolute = path.join(root, child);
			const stat = await fs.lstat(absolute);
			const mode = (stat.mode & 0o7777).toString(8);
			if (entry.isSymbolicLink()) {
				lines.push(`l ${child} -> ${await fs.readlink(absolute)}`);
			} else if (entry.isDirectory()) {
				lines.push(`d ${mode} ${child}`);
				await visit(child);
			} else {
				lines.push(`f ${mode} ${child} ${sha256(await fs.readFile(absolute))}`);
			}
		}
	}
	await visit("");
	return lines.sort();
}

/** @param {string | Uint8Array} data */
export function sha256(data) {
	return createHash("sha256").update(data).digest("hex");
}

/**
 * @param {string} file
 * @returns {Promise<boolean>}
 */
export async function exists(file) {
	return fs.lstat(file).then(
		() => true,
		() => false,
	);
}
