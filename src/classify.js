/** @import { ContentState, FileStatus, Fingerprint } from "./types.js" */
/** @import { Inspection } from "./fsutil.js" */

/**
 * @typedef {object} Expected
 * @property {string} sha256          installed content
 * @property {number} mode            installed mode
 * @property {Fingerprint | null} original
 */

/**
 * Recovery decides what to do from what is on disk, not from what the journal
 * last said, so a lost progress record can never cause a wrong action.
 *
 * `strict` identity (used within one apply, right after preview) also requires
 * the same device and inode: replacing a file with an identical copy still
 * counts as a change. `content` identity (used after a crash, possibly after
 * a reboot, when device numbers can change) compares bytes and mode only.
 * @param {Inspection} current
 * @param {Expected} expected
 * @param {"strict" | "content"} identity
 * @returns {ContentState}
 */
export function classify(current, expected, identity) {
	if (current.kind === "other") return "modified";
	if (current.kind === "absent") return expected.original === null ? "original" : "missing";
	const now = current.fingerprint;
	if (now.sha256 === expected.sha256 && now.mode === expected.mode) return "installed";
	if (expected.original && sameFile(now, expected.original, identity)) return "original";
	return "modified";
}

/**
 * @param {Fingerprint} a
 * @param {Fingerprint} b
 * @param {"strict" | "content"} identity
 */
function sameFile(a, b, identity) {
	const sameContent = a.sha256 === b.sha256 && a.size === b.size && a.mode === b.mode;
	if (identity === "content") return sameContent;
	return sameContent && a.dev === b.dev && a.ino === b.ino;
}

/**
 * @typedef {"none" | "restore" | "remove" | "leave" | "conflict"} RollbackAction
 */

/**
 * What rollback does with one journaled file:
 *
 *   original   -> none      (never published, or already restored)
 *   installed  -> restore   (put the backed-up original back) or remove (we created it)
 *   modified or missing, file never touched by apply (pending) -> leave (someone else's change)
 *   missing, file touched by apply -> restore (nothing there to overwrite)
 *   modified, file touched by apply -> conflict: rollback refuses rather than destroy an edit
 * @param {{ original: Fingerprint | null, status: FileStatus }} file
 * @param {ContentState} content
 * @returns {RollbackAction}
 */
export function rollbackAction(file, content) {
	if (content === "original") return "none";
	if (content === "installed") return file.original ? "restore" : "remove";
	if (file.status === "pending") return "leave";
	if (content === "missing") return "restore";
	return "conflict";
}
