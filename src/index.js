export { apply } from "./apply.js";
export { loadBundle } from "./bundle.js";
export {
	BUNDLE_FORMAT,
	DEFAULT_LIMITS,
	JOURNAL_FORMAT,
	STATE_DIR,
} from "./constants.js";
export { CrashSafeError } from "./errors.js";
export { decodeJournal, TRANSITIONS } from "./journal.js";
export { preview } from "./preview.js";
export { rollback } from "./rollback.js";
export { status } from "./status.js";
export { readStoredZip } from "./zip.js";

/**
 * @typedef {import("./types.js").ApplyOptions} ApplyOptions
 * @typedef {import("./types.js").ApplyResult} ApplyResult
 * @typedef {import("./types.js").Bundle} Bundle
 * @typedef {import("./types.js").FaultHook} FaultHook
 * @typedef {import("./types.js").FaultPoint} FaultPoint
 * @typedef {import("./types.js").JournalState} JournalState
 * @typedef {import("./types.js").Plan} Plan
 * @typedef {import("./types.js").RollbackOptions} RollbackOptions
 * @typedef {import("./types.js").RollbackResult} RollbackResult
 * @typedef {import("./types.js").StatusReport} StatusReport
 * @typedef {import("./types.js").TargetOptions} TargetOptions
 * @typedef {import("./errors.js").ErrorCode} ErrorCode
 */
