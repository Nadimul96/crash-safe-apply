// Shared JSDoc types. `tsc` checks every module against these, and
// `pnpm build` emits them as .d.ts files for library users.

/**
 * @typedef {object} Limits
 * @property {number} maxFiles          files per bundle
 * @property {number} maxFileBytes      bytes per file
 * @property {number} maxTotalBytes     bytes across the bundle (and across backed-up originals)
 * @property {number} maxManifestBytes  size of manifest.json
 */

/**
 * @typedef {object} BundleFile
 * @property {string} path         target-relative destination, e.g. "config/app.toml"
 * @property {string} sha256       hex digest of `data`, as declared in the manifest
 * @property {number} size
 * @property {number | null} mode  permission bits requested by the manifest, if any
 * @property {Buffer} data
 */

/**
 * @typedef {object} Bundle
 * @property {string} id           first 16 hex characters of `digest`; names the journal directory
 * @property {string} digest       sha256 of the manifest bytes, which commit to every file's sha256
 * @property {string | null} name
 * @property {"directory" | "zip"} kind
 * @property {BundleFile[]} files
 */

/**
 * Identity of a regular file at one moment. `dev` and `ino` are decimal
 * strings because they can exceed Number.MAX_SAFE_INTEGER.
 * @typedef {object} Fingerprint
 * @property {string} sha256
 * @property {number} size
 * @property {number} mode   permission bits (st_mode & 0o7777)
 * @property {string} dev
 * @property {string} ino
 */

/** @typedef {"create" | "replace" | "unchanged"} ChangeAction */

/**
 * @typedef {object} PlannedChange
 * @property {string} path
 * @property {ChangeAction} action
 * @property {string} sha256           content the bundle installs
 * @property {number} size
 * @property {number} mode             mode the installed file will have
 * @property {Fingerprint | null} original  what is there now (null if nothing)
 */

/**
 * @typedef {object} Plan
 * @property {string} id               digest of everything apply depends on; pass it to `apply`
 * @property {string} target           canonical absolute target path
 * @property {{ id: string, digest: string, name: string | null }} bundle
 * @property {PlannedChange[]} changes every bundle file, including unchanged ones
 * @property {string[]} directories    directories apply will create, parents first
 * @property {{ create: number, replace: number, unchanged: number, bytes: number }} summary
 */

/**
 * @typedef {"prepared" | "applying" | "applied" | "complete" | "incomplete" | "restoring" | "restored"} JournalState
 */

/** @typedef {"pending" | "applying" | "applied" | "restoring" | "restored"} FileStatus */

/**
 * How a target file compares with what the journal expects.
 * @typedef {"original" | "installed" | "missing" | "modified"} ContentState
 */

/**
 * One mutating filesystem step. Fault hooks receive these after the step has
 * completed, so throwing from the hook models a crash right after it.
 * @typedef {object} FaultPoint
 * @property {number} seq     1-based position in this run's sequence of steps
 * @property {"mkdir" | "create" | "write-partial" | "write" | "chmod" | "fsync" | "fsync-dir" | "rename" | "link" | "unlink" | "rmdir" | "truncate"} op
 * @property {string} path    path relative to the target
 * @property {string} step    what the step is for, e.g. `publish config/app.toml`
 */

/** @typedef {(point: FaultPoint) => void | Promise<void>} FaultHook */

/**
 * @typedef {object} IoStats
 * @property {number} steps      mutating filesystem calls
 * @property {number} fsyncs     file fsyncs (F_FULLFSYNC on macOS)
 * @property {number} dirFsyncs  directory fsyncs
 */

/**
 * @typedef {{ kind: "file", phase: "apply" | "rollback", path: string, action: string, index: number, total: number }
 *   | { kind: "state", state: JournalState }} ProgressEvent
 */

/**
 * @typedef {object} TargetOptions
 * @property {string} bundle            bundle directory or stored ZIP
 * @property {string} target            existing directory to change
 * @property {Partial<Limits>} [limits]
 */

/**
 * @typedef {object} RunOptions
 * @property {FaultHook} [faults]                     test hook called after every mutating step
 * @property {(event: ProgressEvent) => void} [onProgress]
 */

/** @typedef {TargetOptions & RunOptions & { plan?: string }} ApplyOptions */
/** @typedef {TargetOptions & RunOptions} RollbackOptions */

/**
 * @typedef {object} FileOutcome
 * @property {string} path
 * @property {string} action   what this run did, e.g. "created", "replaced", "restored", "removed", "kept"
 */

/**
 * @typedef {object} ApplyResult
 * @property {"applied" | "resumed" | "already-applied" | "nothing-to-do"} outcome
 * @property {string} planId
 * @property {string | null} journal   path of journal.log, if one was written
 * @property {FileOutcome[]} files
 * @property {IoStats} io
 */

/**
 * @typedef {object} RollbackResult
 * @property {"restored" | "already-restored" | "nothing-to-roll-back"} outcome
 * @property {string | null} journal
 * @property {FileOutcome[]} files
 * @property {string[]} keptDirectories  created directories left in place because they are not empty
 * @property {IoStats} io
 */

/**
 * @typedef {object} LockInfo
 * @property {number} pid
 * @property {string} host
 * @property {string} runId
 * @property {string} command
 * @property {string} bundle   id of the bundle the holder is working on
 * @property {string} startedAt
 * @property {boolean} alive    false when the holder has exited (a crash leaves a stale lock)
 */

/**
 * @typedef {object} FileStatusReport
 * @property {string} path
 * @property {"create" | "replace"} action
 * @property {FileStatus} status    last status the journal recorded
 * @property {ContentState} content what the target holds now
 * @property {boolean} tempPresent  a temp file from an interrupted write is still on disk
 */

/**
 * @typedef {"not-applied" | "in-progress" | "interrupted" | "incomplete" | "complete" | "restored"} OverallState
 */

/**
 * @typedef {object} StatusReport
 * @property {OverallState} state
 * @property {"apply" | "rollback" | null} phase
 * @property {string} target
 * @property {{ id: string, name: string | null }} bundle
 * @property {{ path: string, generation: number, state: JournalState, planId: string, records: number, updatedAt: string, discardedBytes: number } | null} journal
 * @property {LockInfo | null} lock
 * @property {FileStatusReport[]} files
 * @property {Plan | null} plan             fresh plan when nothing has been applied yet
 * @property {string[]} rollbackBlockers    files rollback would refuse to touch
 * @property {NextStep[]} next              commands that would finish or undo the change
 */

/**
 * @typedef {object} NextStep
 * @property {"apply" | "rollback"} command
 * @property {string | null} plan   plan id to pass to apply
 * @property {string} reason
 */

export {};
