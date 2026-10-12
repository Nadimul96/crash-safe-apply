import fs from "node:fs/promises";
import path from "node:path";
import { BUNDLE_FORMAT } from "../../src/constants.js";
import { sha256, writeTree } from "./tree.js";
import { buildZip } from "./zip-writer.js";

/** @import { FileSpec } from "./tree.js" */

/**
 * @typedef {{ content: string | Buffer, mode?: string }} BundleSpec
 */

/**
 * @param {Record<string, string | Buffer | BundleSpec>} files
 * @param {{ name?: string }} [options]
 */
export function manifestFor(files, { name } = {}) {
	return {
		format: BUNDLE_FORMAT,
		...(name ? { name } : {}),
		files: Object.entries(files).map(([relative, spec]) => {
			const { content, mode } = toBundleSpec(spec);
			return { path: relative, sha256: sha256(content), ...(mode ? { mode } : {}) };
		}),
	};
}

/**
 * Writes a directory bundle: manifest.json plus files/.
 * @param {string} dir
 * @param {Record<string, string | Buffer | BundleSpec>} files
 * @param {{ name?: string, manifest?: object }} [options]
 */
export async function writeBundle(dir, files, options = {}) {
	await fs.mkdir(dir, { recursive: true });
	const manifest = options.manifest ?? manifestFor(files, options);
	await fs.writeFile(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	/** @type {Record<string, FileSpec>} */
	const tree = {};
	for (const [relative, spec] of Object.entries(files))
		tree[`files/${relative}`] = toBundleSpec(spec).content;
	await fs.mkdir(path.join(dir, "files"), { recursive: true });
	await writeTree(dir, tree);
	return dir;
}

/**
 * The same bundle as a stored ZIP.
 * @param {Record<string, string | Buffer | BundleSpec>} files
 * @param {{ name?: string, manifest?: object }} [options]
 */
export function zipBundle(files, options = {}) {
	const manifest = options.manifest ?? manifestFor(files, options);
	return buildZip([
		{ name: "manifest.json", data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
		...Object.entries(files).map(([relative, spec]) => ({
			name: `files/${relative}`,
			data: Buffer.from(toBundleSpec(spec).content),
		})),
	]);
}

/**
 * @param {string | Buffer | BundleSpec} spec
 * @returns {BundleSpec}
 */
function toBundleSpec(spec) {
	return typeof spec === "string" || Buffer.isBuffer(spec) ? { content: spec } : spec;
}
