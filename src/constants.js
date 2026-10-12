/** Directory inside the target that holds locks, journals and original-file backups. */
export const STATE_DIR = ".crash-safe-apply";

/** Bundle paths may not use this prefix: it names our state directory and temp files. */
export const RESERVED_PREFIX = ".crash-safe-apply";

export const BUNDLE_FORMAT = "crash-safe-apply/bundle@1";
export const JOURNAL_FORMAT = "crash-safe-apply/journal@1";

export const MANIFEST_NAME = "manifest.json";
export const PAYLOAD_DIR = "files";
export const JOURNAL_NAME = "journal.log";
export const ORIGINALS_DIR = "originals";

/** Mode for files the manifest creates without asking for one. */
export const DEFAULT_FILE_MODE = 0o644;
export const DEFAULT_DIR_MODE = 0o755;

/**
 * Everything is held in memory while planning, so a bundle is bounded.
 * @type {Readonly<import("./types.js").Limits>}
 */
export const DEFAULT_LIMITS = Object.freeze({
	maxFiles: 1000,
	maxFileBytes: 16 * 1024 * 1024,
	maxTotalBytes: 64 * 1024 * 1024,
	maxManifestBytes: 1024 * 1024,
});

/**
 * @param {Partial<import("./types.js").Limits> | undefined} overrides
 * @returns {import("./types.js").Limits}
 */
export function resolveLimits(overrides) {
	return { ...DEFAULT_LIMITS, ...overrides };
}
