/**
 * @typedef {"USAGE"
 *   | "UNSUPPORTED_PLATFORM"
 *   | "UNSAFE_PATH"
 *   | "INVALID_BUNDLE"
 *   | "INVALID_ZIP"
 *   | "INVALID_TARGET"
 *   | "UNSUPPORTED_FILE"
 *   | "PLAN_MISMATCH"
 *   | "CHANGED_AFTER_PREVIEW"
 *   | "CONFLICT"
 *   | "LOCKED"
 *   | "INVALID_JOURNAL"
 *   | "WRONG_PHASE"} ErrorCode
 */

/** Every refusal the library makes is one of these, with a stable `code`. */
export class CrashSafeError extends Error {
	/**
	 * @param {ErrorCode} code
	 * @param {string} message
	 * @param {Record<string, unknown>} [details]
	 */
	constructor(code, message, details = {}) {
		super(message);
		this.name = "CrashSafeError";
		/** @type {ErrorCode} */
		this.code = code;
		this.details = details;
	}
}

/**
 * @param {ErrorCode} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 * @returns {never}
 */
export function fail(code, message, details) {
	throw new CrashSafeError(code, message, details);
}

/**
 * @param {unknown} error
 * @returns {error is NodeJS.ErrnoException}
 */
export function isErrno(error) {
	return error instanceof Error && typeof Reflect.get(error, "code") === "string";
}
