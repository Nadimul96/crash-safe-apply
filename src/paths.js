import { RESERVED_PREFIX } from "./constants.js";
import { fail } from "./errors.js";

const MAX_PATH_BYTES = 1024;
const MAX_SEGMENT_BYTES = 255;
const MAX_DEPTH = 32;

// Backslash and colon are path separators on other systems; control characters
// make paths ambiguous in terminals and logs.
const SEPARATOR_LIKE = /[\\:]/;

/** @param {string} value */
function hasForbiddenCharacter(value) {
	if (SEPARATOR_LIKE.test(value)) return true;
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

/**
 * Validates a bundle-relative path such as `config/app.toml`. Rejects anything
 * that could resolve outside the target or collide with our own state.
 * @param {unknown} value
 * @returns {string}
 */
export function checkRelativePath(value) {
	if (typeof value !== "string" || value.length === 0) {
		unsafe(value, "must be a non-empty string");
	}
	if (Buffer.byteLength(value) > MAX_PATH_BYTES) {
		unsafe(value, `is longer than ${MAX_PATH_BYTES} bytes`);
	}
	if (value !== value.normalize("NFC")) {
		unsafe(value, "must be Unicode NFC-normalized");
	}
	if (hasForbiddenCharacter(value)) {
		unsafe(value, "contains a backslash, colon or control character");
	}
	if (value.startsWith("/")) unsafe(value, "is absolute");
	const segments = value.split("/");
	if (segments.length > MAX_DEPTH) {
		unsafe(value, `is deeper than ${MAX_DEPTH} levels`);
	}
	for (const segment of segments) checkSegment(value, segment);
	return value;
}

/**
 * @param {string} value
 * @param {string} segment
 */
function checkSegment(value, segment) {
	if (segment === "") unsafe(value, "has an empty segment");
	if (segment === "." || segment === "..") {
		unsafe(value, `has a "${segment}" segment`);
	}
	if (Buffer.byteLength(segment) > MAX_SEGMENT_BYTES) {
		unsafe(value, `has a segment longer than ${MAX_SEGMENT_BYTES} bytes`);
	}
	const lower = segment.toLowerCase();
	if (lower === ".git") unsafe(value, "writes inside a .git directory");
	if (lower.startsWith(RESERVED_PREFIX)) {
		unsafe(value, `uses the reserved name ${RESERVED_PREFIX}`);
	}
}

/**
 * Rejects sets of paths that would collide on a case-insensitive filesystem
 * (the macOS default), or that use one name as both a file and a directory.
 * @param {readonly string[]} paths
 */
export function assertDistinctPaths(paths) {
	const seen = new Map();
	for (const path of paths) {
		const key = path.toLowerCase();
		const previous = seen.get(key);
		if (previous !== undefined) {
			const how = previous === path ? "is listed twice" : `collides with "${previous}"`;
			unsafe(path, how);
		}
		seen.set(key, path);
	}
	for (const [key, path] of seen) {
		for (const ancestor of ancestorsOf(key)) {
			if (seen.has(ancestor)) {
				unsafe(path, `is inside "${seen.get(ancestor)}", which is also a file`);
			}
		}
	}
}

/**
 * `a/b/c` -> [`a`, `a/b`]
 * @param {string} path
 * @returns {string[]}
 */
export function ancestorsOf(path) {
	const segments = path.split("/");
	return segments.slice(1).map((_, index) => segments.slice(0, index + 1).join("/"));
}

/**
 * @param {unknown} value
 * @param {string} reason
 * @returns {never}
 */
function unsafe(value, reason) {
	return fail("UNSAFE_PATH", `Unsafe path ${JSON.stringify(value)}: ${reason}`, {
		path: value,
	});
}
