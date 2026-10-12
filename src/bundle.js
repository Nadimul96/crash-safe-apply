import fs from "node:fs/promises";
import path from "node:path";
import { BUNDLE_FORMAT, MANIFEST_NAME, PAYLOAD_DIR } from "./constants.js";
import { fail } from "./errors.js";
import { lstatMaybe, readRegularFile, sha256 } from "./fsutil.js";
import { assertDistinctPaths, checkRelativePath } from "./paths.js";
import { SHA256_HEX, schema } from "./validate.js";
import { readStoredZip } from "./zip.js";

/** @import { Bundle, BundleFile, Limits } from "./types.js" */

/**
 * A bundle is a directory or a stored (uncompressed) ZIP with this layout:
 *
 *   manifest.json   { "format": "crash-safe-apply/bundle@1", "name"?: "...",
 *                     "files": [{ "path": "config/app.toml", "sha256": "...", "mode"?: "0644" }] }
 *   files/<path>    the new content for each listed path
 *
 * Every file under files/ must be listed and every listed file must match its
 * sha256. Bundle content is only ever treated as data.
 */

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MODE = /^0?[0-7]{3}$/;
const ZIP_OVERHEAD_PER_ENTRY = 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const v = schema("INVALID_BUNDLE");

/**
 * @typedef {object} ManifestEntry
 * @property {string} path
 * @property {string} sha256
 * @property {number | null} mode
 */

/**
 * @param {string} input
 * @param {Limits} limits
 * @returns {Promise<Bundle>}
 */
export async function loadBundle(input, limits) {
	const absolute = path.resolve(input);
	const stat = await lstatMaybe(absolute);
	if (!stat) fail("INVALID_BUNDLE", `Bundle not found: ${input}`);
	if (stat.isSymbolicLink()) fail("INVALID_BUNDLE", `The bundle must not be a symlink: ${input}`);
	if (stat.isDirectory()) return loadDirectoryBundle(absolute, limits);
	if (stat.isFile()) return loadZipBundle(absolute, limits);
	return fail("INVALID_BUNDLE", `The bundle must be a directory or a .zip file: ${input}`);
}

/**
 * @param {string} root
 * @param {Limits} limits
 * @returns {Promise<Bundle>}
 */
async function loadDirectoryBundle(root, limits) {
	const manifestBytes = (
		await readRegularFile(path.join(root, MANIFEST_NAME), limits.maxManifestBytes)
	).data;
	const manifest = parseManifest(manifestBytes, limits);
	const payloadRoot = path.join(root, PAYLOAD_DIR);
	const present = await listPayload(payloadRoot, limits);
	assertExactlyListed(manifest.files, present);
	/** @type {Map<string, Buffer>} */
	const payload = new Map();
	for (const entry of manifest.files) {
		const file = path.join(payloadRoot, ...entry.path.split("/"));
		payload.set(entry.path, (await readRegularFile(file, limits.maxFileBytes)).data);
	}
	return assemble("directory", manifestBytes, manifest, payload, limits);
}

/**
 * @param {string} file
 * @param {Limits} limits
 * @returns {Promise<Bundle>}
 */
async function loadZipBundle(file, limits) {
	const maxEntries = limits.maxFiles * 4 + 16;
	const maxArchive =
		limits.maxTotalBytes + limits.maxManifestBytes + maxEntries * ZIP_OVERHEAD_PER_ENTRY;
	const archive = readStoredZip((await readRegularFile(file, maxArchive)).data, {
		maxEntries,
		maxFileBytes: Math.max(limits.maxFileBytes, limits.maxManifestBytes),
		maxTotalBytes: limits.maxTotalBytes + limits.maxManifestBytes,
	});
	const manifestBytes = archive.files.get(MANIFEST_NAME);
	if (!manifestBytes) fail("INVALID_BUNDLE", `The ZIP has no ${MANIFEST_NAME} at its root`);
	const manifest = parseManifest(manifestBytes, limits);
	/** @type {Map<string, Buffer>} */
	const payload = new Map();
	for (const [name, data] of archive.files) {
		if (name === MANIFEST_NAME) continue;
		if (!name.startsWith(`${PAYLOAD_DIR}/`)) {
			fail("INVALID_BUNDLE", `Unexpected ZIP entry outside ${PAYLOAD_DIR}/: ${name}`);
		}
		payload.set(name.slice(PAYLOAD_DIR.length + 1), data);
	}
	assertExactlyListed(manifest.files, new Set(payload.keys()));
	return assemble("zip", manifestBytes, manifest, payload, limits);
}

/**
 * @param {Uint8Array} bytes
 * @param {Limits} limits
 * @returns {{ name: string | null, files: ManifestEntry[] }}
 */
export function parseManifest(bytes, limits) {
	if (bytes.length > limits.maxManifestBytes) {
		fail("INVALID_BUNDLE", `${MANIFEST_NAME} is larger than ${limits.maxManifestBytes} bytes`);
	}
	let json;
	try {
		json = JSON.parse(utf8.decode(bytes));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return fail("INVALID_BUNDLE", `${MANIFEST_NAME} is not valid UTF-8 JSON: ${reason}`);
	}
	const root = v.object(json, MANIFEST_NAME, ["format", "files"], ["name"]);
	v.oneOf(root.format, `${MANIFEST_NAME} format`, [BUNDLE_FORMAT]);
	const name = root.name === undefined ? null : v.string(root.name, `${MANIFEST_NAME} name`, NAME);
	const entries = v.array(root.files, `${MANIFEST_NAME} files`, limits.maxFiles);
	if (entries.length === 0) fail("INVALID_BUNDLE", `${MANIFEST_NAME} lists no files`);
	const files = entries.map((entry, index) => {
		const where = `${MANIFEST_NAME} files[${index}]`;
		const record = v.object(entry, where, ["path", "sha256"], ["mode"]);
		const mode =
			record.mode === undefined
				? null
				: Number.parseInt(v.string(record.mode, `${where}.mode`, MODE), 8);
		return {
			path: checkRelativePath(record.path),
			sha256: v.string(record.sha256, `${where}.sha256`, SHA256_HEX),
			mode,
		};
	});
	assertDistinctPaths(files.map((file) => file.path));
	return { name, files };
}

/**
 * @param {"directory" | "zip"} kind
 * @param {Uint8Array} manifestBytes
 * @param {{ name: string | null, files: ManifestEntry[] }} manifest
 * @param {Map<string, Buffer>} payload
 * @param {Limits} limits
 * @returns {Bundle}
 */
function assemble(kind, manifestBytes, manifest, payload, limits) {
	let total = 0;
	/** @type {BundleFile[]} */
	const files = manifest.files.map((entry) => {
		const data = payload.get(entry.path);
		if (data === undefined) fail("INVALID_BUNDLE", `Missing ${PAYLOAD_DIR}/${entry.path}`);
		if (data.length > limits.maxFileBytes) {
			fail("INVALID_BUNDLE", `${entry.path} is larger than ${limits.maxFileBytes} bytes`);
		}
		total += data.length;
		if (total > limits.maxTotalBytes) {
			fail("INVALID_BUNDLE", `Bundle content exceeds ${limits.maxTotalBytes} bytes`);
		}
		const actual = sha256(data);
		if (actual !== entry.sha256) {
			fail(
				"INVALID_BUNDLE",
				`sha256 mismatch for ${entry.path}: manifest says ${entry.sha256.slice(0, 12)}…, content is ${actual.slice(0, 12)}…`,
			);
		}
		return {
			path: entry.path,
			sha256: actual,
			size: data.length,
			mode: entry.mode,
			data,
		};
	});
	const digest = sha256(manifestBytes);
	return { id: digest.slice(0, 16), digest, name: manifest.name, kind, files };
}

/**
 * @param {ManifestEntry[]} listed
 * @param {Set<string>} present
 */
function assertExactlyListed(listed, present) {
	const names = new Set(listed.map((entry) => entry.path));
	for (const name of names) {
		if (!present.has(name)) fail("INVALID_BUNDLE", `Missing ${PAYLOAD_DIR}/${name}`);
	}
	for (const name of present) {
		if (!names.has(name)) {
			fail("INVALID_BUNDLE", `${PAYLOAD_DIR}/${name} is not listed in ${MANIFEST_NAME}`);
		}
	}
}

/**
 * Lists regular files under files/, refusing symlinks and special files.
 * @param {string} root
 * @param {Limits} limits
 * @returns {Promise<Set<string>>}
 */
async function listPayload(root, limits) {
	/** @type {Set<string>} */
	const found = new Set();
	const rootStat = await lstatMaybe(root);
	if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
		fail("INVALID_BUNDLE", `The bundle has no ${PAYLOAD_DIR}/ directory`);
	}
	/** @param {string} relative */
	async function visit(relative) {
		const entries = await fs.readdir(relative ? path.join(root, relative) : root, {
			withFileTypes: true,
		});
		for (const entry of entries) {
			const child = checkRelativePath(relative ? `${relative}/${entry.name}` : entry.name);
			if (entry.isDirectory()) {
				await visit(child);
			} else if (entry.isFile()) {
				found.add(child);
				if (found.size > limits.maxFiles)
					fail("INVALID_BUNDLE", `More than ${limits.maxFiles} files`);
			} else {
				fail("INVALID_BUNDLE", `${PAYLOAD_DIR}/${child} is a symlink or special file`);
			}
		}
	}
	await visit("");
	return found;
}
