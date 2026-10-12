import path from "node:path";

/** @import { ApplyResult, FileStatusReport, Plan, ProgressEvent, RollbackResult, StatusReport } from "../types.js" */

/**
 * @typedef {object} Style
 * @property {(text: string) => string} bold
 * @property {(text: string) => string} dim
 * @property {(text: string) => string} green
 * @property {(text: string) => string} yellow
 * @property {(text: string) => string} red
 * @property {(text: string) => string} cyan
 */

/**
 * @typedef {object} Invocation   how the user referred to the bundle and target, for suggested commands
 * @property {string} bundle
 * @property {string} target
 */

/** @param {boolean} enabled @returns {Style} */
export function createStyle(enabled) {
	const wrap =
		(/** @type {number} */ open, /** @type {number} */ close) => (/** @type {string} */ text) =>
			enabled ? `\u001b[${open}m${text}\u001b[${close}m` : text;
	return {
		bold: wrap(1, 22),
		dim: wrap(2, 22),
		green: wrap(32, 39),
		yellow: wrap(33, 39),
		red: wrap(31, 39),
		cyan: wrap(36, 39),
	};
}

const MARK = { create: "+", replace: "~", unchanged: "=" };

/**
 * @param {Style} s
 * @param {string} verb
 * @param {{ name: string | null, id: string }} bundle
 * @param {string} target
 */
function header(s, verb, bundle, target) {
	return `${s.bold(verb)}  ${bundle.name ?? bundle.id}  ${s.dim("->")}  ${target}`;
}

/**
 * @param {Plan} plan
 * @param {Style} s
 * @param {Invocation} how
 */
export function renderPlan(plan, s, how) {
	const width = Math.max(...plan.changes.map((change) => change.path.length));
	const lines = [header(s, "Preview", plan.bundle, plan.target)];
	for (const change of plan.changes) {
		const label = change.action === "unchanged" ? "same" : change.action;
		const row = `  ${MARK[change.action]} ${label.padEnd(8)} ${change.path.padEnd(width)}`;
		if (change.action === "unchanged") {
			lines.push(s.dim(row.trimEnd()));
			continue;
		}
		const color = change.action === "create" ? s.green : s.yellow;
		const was = change.original ? s.dim(`  was ${change.original.sha256.slice(0, 8)}`) : "";
		lines.push(`${color(row)}  ${bytes(change.size).padStart(9)}${was}`);
	}
	const { create, replace, unchanged } = plan.summary;
	const parts = [
		`${create + replace} to write`,
		`${unchanged} unchanged`,
		`${bytes(plan.summary.bytes)}`,
	];
	if (plan.directories.length > 0)
		parts.push(`${plural(plan.directories.length, "new directory", "new directories")}`);
	lines.push("", `  ${parts.join(s.dim(" · "))}`, `  Plan ${s.cyan(plan.id)}`);
	if (create + replace === 0) {
		lines.push("", "  The target already matches this bundle.");
	} else {
		lines.push("", s.dim("  Apply exactly this plan:"), `    ${command(how, "apply", plan.id)}`);
	}
	return lines.join("\n");
}

/**
 * @param {Style} s
 * @returns {(event: ProgressEvent) => string}
 */
export function progressLine(s) {
	const meaning = {
		applying: "originals backed up and plan fsynced; writing files",
		applied: "every file published; touched directories fsynced",
		complete: "every file read back and verified",
		restoring: "putting originals back",
		restored: "every original back in place",
	};
	return (event) => {
		if (event.kind === "state") {
			const why = meaning[/** @type {keyof typeof meaning} */ (event.state)] ?? "";
			return s.dim(`  journal  ${event.state.padEnd(10)} ${why}`);
		}
		const mark = event.action === "created" ? "+" : event.action === "removed" ? "-" : "~";
		const color =
			event.action === "created" ? s.green : event.action === "removed" ? s.red : s.yellow;
		return color(`  ${mark} ${event.action.padEnd(9)}${event.path}`);
	};
}

/**
 * @param {ApplyResult} result
 * @param {Style} s
 * @param {Invocation} how
 * @param {string} target
 */
export function renderApplyResult(result, s, how, target) {
	if (result.outcome === "nothing-to-do")
		return "  Nothing to do: the target already matches this bundle.";
	if (result.outcome === "already-applied")
		return "  Already applied. Every file still matches the bundle.";
	const journal = result.journal ? path.relative(target, result.journal) : "";
	const verb = result.outcome === "resumed" ? "Finished the interrupted apply." : "Complete.";
	return [
		"",
		`  ${s.bold(verb)} Journal and originals: ${journal}`,
		s.dim(`  ${result.io.fsyncs} file fsyncs, ${result.io.dirFsyncs} directory fsyncs`),
		s.dim("  Undo with:"),
		`    ${command(how, "rollback")}`,
	].join("\n");
}

/**
 * @param {RollbackResult} result
 * @param {Style} s
 */
export function renderRollbackResult(result, s) {
	if (result.outcome === "nothing-to-roll-back")
		return "  Nothing to roll back: this bundle was never applied here.";
	if (result.outcome === "already-restored") return "  Already rolled back.";
	const lines = [
		"",
		`  ${s.bold("Restored.")} Every file this bundle changed holds its original bytes again.`,
	];
	for (const dir of result.keptDirectories) {
		lines.push(s.yellow(`  Kept ${dir}/ because it now contains other files.`));
	}
	return lines.join("\n");
}

const STATE_TEXT = {
	"not-applied": "nothing applied yet",
	"in-progress": "another run is working on it now",
	interrupted: "the process stopped mid-way; no run holds the lock",
	incomplete: "apply stopped on a file that was not as expected",
	complete: "applied and verified",
	restored: "rolled back",
};

/**
 * @param {StatusReport} report
 * @param {Style} s
 * @param {Invocation} how
 */
export function renderStatus(report, s, how) {
	const lines = [header(s, "Status", report.bundle, report.target)];
	const color = { complete: s.green, restored: s.green, interrupted: s.yellow, incomplete: s.red };
	const paint = color[/** @type {keyof typeof color} */ (report.state)] ?? s.cyan;
	const phase = report.phase ? ` during ${report.phase}` : "";
	lines.push(
		`  State    ${paint(s.bold(report.state))}${phase}  ${s.dim(STATE_TEXT[report.state])}`,
	);
	if (report.journal) {
		const where = path.relative(report.target, report.journal.path);
		const torn = report.journal.discardedBytes
			? `, ${report.journal.discardedBytes} torn bytes ignored`
			: "";
		lines.push(
			`  Journal  ${where}  ${s.dim(`last state "${report.journal.state}", ${report.journal.records} records${torn}`)}`,
		);
	}
	if (report.lock) {
		const owner = `${report.lock.command}, pid ${report.lock.pid}`;
		lines.push(
			`  Lock     ${report.lock.alive ? `held (${owner})` : s.dim(`stale (${owner} has exited)`)}`,
		);
	}
	if (report.files.length > 0) {
		lines.push("");
		const width = Math.max(...report.files.map((file) => file.path.length));
		for (const file of report.files) lines.push(fileRow(file, width, s));
	} else if (report.plan) {
		lines.push(`  Plan     ${s.cyan(report.plan.id)}  ${s.dim(summary(report.plan))}`);
	}
	if (report.rollbackBlockers.length > 0) {
		lines.push(
			"",
			s.red(`  Rollback would refuse: ${report.rollbackBlockers.join(", ")} changed after apply.`),
		);
	}
	if (report.next.length > 0) {
		lines.push("", s.dim("  Next"));
		const commands = report.next.map((step) => command(how, step.command, step.plan ?? undefined));
		const width = Math.max(...commands.map((text) => text.length));
		report.next.forEach((step, index) => {
			lines.push(`    ${(commands[index] ?? "").padEnd(width)}   ${s.dim(step.reason)}`);
		});
	}
	return lines.join("\n");
}

/**
 * @param {FileStatusReport} file
 * @param {number} width
 * @param {Style} s
 */
function fileRow(file, width, s) {
	const content = { installed: s.green, original: s.dim, missing: s.red, modified: s.red }[
		file.content
	];
	const temp = file.tempPresent ? s.yellow("  temp file present") : "";
	return `  ${file.status.padEnd(9)} ${MARK[file.action]} ${file.path.padEnd(width)}  ${content(file.content)}${temp}`;
}

/** @param {Plan} plan */
function summary(plan) {
	const { create, replace, unchanged } = plan.summary;
	return `${create} to create, ${replace} to replace, ${unchanged} unchanged`;
}

/**
 * @param {Invocation} how
 * @param {"apply" | "rollback"} verb
 * @param {string} [plan]
 */
function command(how, verb, plan) {
	const parts = ["crash-safe-apply", verb, quote(how.bundle), "--target", quote(how.target)];
	if (plan) parts.push("--plan", plan);
	return parts.join(" ");
}

/** @param {string} value */
function quote(value) {
	return /^[\w./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** @param {number} count @param {string} one @param {string} many */
function plural(count, one, many) {
	return `${count} ${count === 1 ? one : many}`;
}

/** @param {number} size */
export function bytes(size) {
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
	return `${(size / 1024 / 1024).toFixed(1)} MiB`;
}
