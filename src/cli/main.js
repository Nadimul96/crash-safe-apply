import { readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { apply } from "../apply.js";
import { CrashSafeError } from "../errors.js";
import { preview } from "../preview.js";
import { rollback } from "../rollback.js";
import { status } from "../status.js";
import { parseArgs, USAGE } from "./args.js";
import {
	createStyle,
	progressLine,
	renderApplyResult,
	renderPlan,
	renderRollbackResult,
	renderStatus,
} from "./render.js";

/** @import { CliArgs } from "./args.js" */

/**
 * @typedef {object} Streams
 * @property {{ write(text: string): unknown, isTTY?: boolean }} stdout
 * @property {{ write(text: string): unknown }} stderr
 * @property {Record<string, string | undefined>} env
 */

const EXIT = { ok: 0, refused: 1, usage: 2, needsRecovery: 3 };

/**
 * @param {readonly string[]} argv
 * @param {Streams} [streams]
 * @returns {Promise<number>} exit code
 */
export async function main(
	argv,
	streams = { stdout: process.stdout, stderr: process.stderr, env: process.env },
) {
	const { stdout, stderr, env } = streams;
	const color = env.FORCE_COLOR ? env.FORCE_COLOR !== "0" : Boolean(stdout.isTTY) && !env.NO_COLOR;
	const s = createStyle(color);
	/** @type {CliArgs | undefined} */
	let args;
	try {
		const parsed = parseArgs(argv);
		if ("help" in parsed) {
			stdout.write(`${USAGE}\n`);
			return EXIT.ok;
		}
		if ("version" in parsed) {
			stdout.write(`${version()}\n`);
			return EXIT.ok;
		}
		args = parsed;
		return await run(args, stdout, s);
	} catch (error) {
		const code = error instanceof CrashSafeError ? error.code : "INTERNAL";
		const message = error instanceof Error ? error.message : String(error);
		if (args?.json) {
			const details = error instanceof CrashSafeError ? error.details : {};
			stdout.write(
				`${JSON.stringify({ ok: false, error: { code, message, details } }, null, 2)}\n`,
			);
		} else {
			stderr.write(
				`${s.red(s.bold("crash-safe-apply:"))} ${message}${code === "USAGE" ? "\nRun with --help for usage." : ""}\n`,
			);
		}
		return code === "USAGE" ? EXIT.usage : EXIT.refused;
	}
}

/**
 * @param {CliArgs} args
 * @param {Streams["stdout"]} stdout
 * @param {import("./render.js").Style} s
 * @returns {Promise<number>}
 */
async function run(args, stdout, s) {
	const how = { bundle: args.bundle, target: args.target };
	const options = { bundle: args.bundle, target: args.target };
	const print = (/** @type {string} */ text) => stdout.write(`${text}\n`);
	const json = (/** @type {object} */ value) =>
		print(JSON.stringify({ ok: true, command: args.command, ...value }, null, 2));
	const live = progressLine(s);
	const onProgress = args.json
		? undefined
		: (/** @type {import("../types.js").ProgressEvent} */ e) => print(live(e));

	switch (args.command) {
		case "preview": {
			const plan = await preview(options);
			args.json ? json({ plan }) : print(renderPlan(plan, s, how));
			return EXIT.ok;
		}
		case "apply": {
			if (!args.json) print(`${s.bold("Apply")}  ${args.bundle}  ${s.dim("->")}  ${args.target}`);
			const result = await apply({ ...options, plan: args.plan, onProgress });
			args.json
				? json(result)
				: print(renderApplyResult(result, s, how, await realpath(args.target)));
			return EXIT.ok;
		}
		case "rollback": {
			if (!args.json)
				print(`${s.bold("Rollback")}  ${args.bundle}  ${s.dim("->")}  ${args.target}`);
			const result = await rollback({ ...options, onProgress });
			args.json ? json(result) : print(renderRollbackResult(result, s));
			return EXIT.ok;
		}
		case "status": {
			const report = await status(options);
			args.json ? json(report) : print(renderStatus(report, s, how));
			return report.state === "interrupted" || report.state === "incomplete"
				? EXIT.needsRecovery
				: EXIT.ok;
		}
	}
}

function version() {
	const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
	return String(manifest.version);
}
