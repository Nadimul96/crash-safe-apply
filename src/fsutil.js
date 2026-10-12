import { createHash } from "node:crypto";
import { constants as FS } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { CrashSafeError, fail, isErrno } from "./errors.js";
import { checkRelativePath } from "./paths.js";

/** @import { Stats } from "node:fs" */
/** @import { Fingerprint } from "./types.js" */

/**
 * @typedef {object} RegularFile
 * @property {Buffer} data
 * @property {Fingerprint} fingerprint
 * @property {number} uid
 */

/**
 * @typedef {{ kind: "absent" }
 *   | { kind: "file", fingerprint: Fingerprint, uid: number }
 *   | { kind: "other", reason: string }} Inspection
 */

export function assertPosix() {
	if (process.platform === "win32") {
		fail(
			"UNSUPPORTED_PLATFORM",
			"crash-safe-apply relies on POSIX rename(2), link(2) and directory fsync. Windows is not supported.",
		);
	}
}

/** @param {Uint8Array} data */
export function sha256(data) {
	return createHash("sha256").update(data).digest("hex");
}

/**
 * @param {string} file
 * @returns {Promise<Stats | null>}
 */
export async function lstatMaybe(file) {
	try {
		return await fs.lstat(file);
	} catch (error) {
		if (isErrno(error) && error.code === "ENOENT") return null;
		throw error;
	}
}

/**
 * Reads a regular file without following symlinks and fingerprints it. Fails
 * if the file is swapped while opening or modified while reading.
 * @param {string} file
 * @param {number} maxBytes
 * @returns {Promise<RegularFile>}
 */
export async function readRegularFile(file, maxBytes) {
	const before = await fs.lstat(file, { bigint: true });
	if (!before.isFile()) fail("UNSUPPORTED_FILE", `Not a regular file: ${file}`);
	if (before.size > BigInt(maxBytes)) {
		fail("UNSUPPORTED_FILE", `Larger than the ${maxBytes}-byte limit: ${file}`);
	}
	// O_NONBLOCK: if a FIFO is swapped in after the lstat, open must not hang.
	const handle = await fs.open(file, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
	try {
		const opened = await handle.stat({ bigint: true });
		if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
			fail("CONFLICT", `File was replaced while being opened: ${file}`);
		}
		const data = Buffer.alloc(Number(opened.size));
		let offset = 0;
		while (offset < data.length) {
			const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
			if (bytesRead === 0) fail("CONFLICT", `File shrank while being read: ${file}`);
			offset += bytesRead;
		}
		const after = await handle.stat({ bigint: true });
		const untouched =
			after.size === opened.size &&
			after.mtimeNs === opened.mtimeNs &&
			after.ctimeNs === opened.ctimeNs;
		if (!untouched) fail("CONFLICT", `File changed while being read: ${file}`);
		return {
			data,
			fingerprint: {
				sha256: sha256(data),
				size: data.length,
				mode: Number(opened.mode & 0o7777n),
				dev: String(opened.dev),
				ino: String(opened.ino),
			},
			uid: Number(opened.uid),
		};
	} finally {
		await handle.close();
	}
}

/**
 * Canonical path of an existing, real (non-symlink) target directory. Aliases
 * above it, such as macOS /tmp -> /private/tmp, are resolved once here.
 * @param {string} input
 * @returns {Promise<string>}
 */
export async function resolveTargetRoot(input) {
	const absolute = path.resolve(input);
	const stat = await lstatMaybe(absolute);
	if (!stat) fail("INVALID_TARGET", `Target directory does not exist: ${absolute}`);
	if (stat.isSymbolicLink()) {
		fail("INVALID_TARGET", `Target must be a real directory, not a symlink: ${absolute}`);
	}
	if (!stat.isDirectory()) fail("INVALID_TARGET", `Target is not a directory: ${absolute}`);
	return fs.realpath(absolute);
}

/**
 * Resolves `relative` under `root` one component at a time with lstat and
 * refuses symlinks anywhere along the way, so a link planted in the target
 * cannot redirect a write elsewhere.
 * @param {string} root
 * @param {string} relative
 * @returns {Promise<{ absolute: string, stat: Stats | null, missingFrom: number }>}
 *   `missingFrom` is the index of the first segment that does not exist.
 */
export async function resolveInside(root, relative) {
	checkRelativePath(relative);
	const rootStat = await lstatMaybe(root);
	if (!rootStat?.isDirectory()) fail("INVALID_TARGET", `Target is no longer a directory: ${root}`);
	const segments = relative.split("/");
	let current = root;
	for (let index = 0; index < segments.length; index += 1) {
		current = path.join(current, segments[index] ?? "");
		const stat = await lstatMaybe(current);
		if (!stat)
			return {
				absolute: path.join(root, ...segments),
				stat: null,
				missingFrom: index,
			};
		const shown = path.relative(root, current);
		if (stat.isSymbolicLink()) {
			fail("UNSAFE_PATH", `Refusing to follow a symlink at ${shown}`, {
				path: shown,
			});
		}
		const isLast = index === segments.length - 1;
		if (!isLast && !stat.isDirectory()) {
			fail("UNSAFE_PATH", `${shown} is not a directory`, { path: shown });
		}
		if (isLast) return { absolute: current, stat, missingFrom: segments.length };
	}
	return fail("UNSAFE_PATH", `Empty path: ${relative}`);
}

/**
 * Describes what is at a target path without throwing for foreign content:
 * symlinks, special files and unreadable files all become `other`.
 * @param {string} root
 * @param {string} relative
 * @param {number} maxBytes
 * @returns {Promise<Inspection>}
 */
export async function inspectFile(root, relative, maxBytes) {
	try {
		const resolved = await resolveInside(root, relative);
		if (!resolved.stat) return { kind: "absent" };
		if (!resolved.stat.isFile()) return { kind: "other", reason: "not a regular file" };
		const { fingerprint, uid } = await readRegularFile(resolved.absolute, maxBytes);
		return { kind: "file", fingerprint, uid };
	} catch (error) {
		if (isErrno(error) && error.code === "ENOENT") return { kind: "absent" };
		if (error instanceof CrashSafeError && error.code !== "INVALID_TARGET") {
			return { kind: "other", reason: error.message };
		}
		throw error;
	}
}

/**
 * The state directory holds backups of the user's files, so it must not be
 * readable by others or redirectable through a symlink.
 * @param {string} directory
 */
export async function assertPrivateDirectory(directory) {
	const stat = await fs.lstat(directory);
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		fail("INVALID_TARGET", `Expected a real directory: ${directory}`);
	}
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
		fail("INVALID_TARGET", `Directory is owned by another user: ${directory}`);
	}
	if ((stat.mode & 0o077) !== 0) {
		fail(
			"INVALID_TARGET",
			`Directory must not be accessible to other users (expected 0700): ${directory}`,
		);
	}
}
