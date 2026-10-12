import { fail } from "../errors.js";

/**
 * @typedef {object} CliArgs
 * @property {"preview" | "apply" | "rollback" | "status"} command
 * @property {string} bundle
 * @property {string} target
 * @property {string | undefined} plan
 * @property {boolean} yes
 * @property {boolean} json
 */

const COMMANDS = /** @type {const} */ (["preview", "apply", "rollback", "status"]);
const PLAN_ID = /^[0-9a-f]{16}$/;

export const USAGE = `Usage: crash-safe-apply <command> <bundle> --target <dir> [options]

Commands
  preview    Show what apply would change. Writes nothing.
  apply      Apply the bundle. Needs --plan <id> from preview (or --yes).
  rollback   Put back every original file the bundle changed.
  status     Show the journal state and what would finish or undo it.

Options
  --target <dir>   Existing directory to change.
  --plan <id>      Plan id printed by preview. Apply refuses if the target
                   changed since, and resumes an interrupted apply of that plan.
  --yes            Apply whatever the current plan is (for scripts).
  --json           Print machine-readable JSON.
  -h, --help       Show this help.
  -v, --version    Show the version.

A bundle is a directory or stored ZIP holding manifest.json and files/.
Exit codes: 0 ok, 1 refused or failed, 2 usage error, 3 status needs recovery.`;

/**
 * @param {readonly string[]} argv
 * @returns {{ help: true } | { version: true } | CliArgs}
 */
export function parseArgs(argv) {
	if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) return { help: true };
	if (argv.includes("-v") || argv.includes("--version")) return { version: true };
	/** @type {string[]} */
	const positional = [];
	/** @type {Map<string, string | true>} */
	const options = new Map();
	for (let index = 0; index < argv.length; index += 1) {
		const arg = /** @type {string} */ (argv[index]);
		if (!arg.startsWith("--")) {
			positional.push(arg);
			continue;
		}
		const [name, inline] = splitOption(arg);
		if (options.has(name)) usage(`--${name} was given twice`);
		if (name === "target" || name === "plan") {
			const value = inline ?? argv[index + 1];
			if (value === undefined || value.startsWith("--")) usage(`--${name} needs a value`);
			if (inline === undefined) index += 1;
			options.set(name, value);
		} else if (name === "yes" || name === "json") {
			if (inline !== undefined) usage(`--${name} does not take a value`);
			options.set(name, true);
		} else {
			usage(`Unknown option --${name}`);
		}
	}
	return validate(positional, options);
}

/**
 * @param {string[]} positional
 * @param {Map<string, string | true>} options
 * @returns {CliArgs}
 */
function validate(positional, options) {
	const [command, bundle, ...extra] = positional;
	if (!COMMANDS.includes(/** @type {CliArgs["command"]} */ (command))) {
		usage(`Unknown command ${JSON.stringify(command)}; use ${COMMANDS.join(", ")}`);
	}
	if (bundle === undefined) usage("A bundle (directory or .zip) is required");
	if (extra.length > 0) usage(`Unexpected argument ${JSON.stringify(extra[0])}`);
	const target = options.get("target");
	if (typeof target !== "string") usage("--target <dir> is required");
	const plan = options.get("plan");
	const yes = options.get("yes") === true;
	if (command !== "apply" && (plan !== undefined || yes))
		usage("--plan and --yes are only for apply");
	if (command === "apply") {
		if (plan === undefined && !yes) usage("apply needs --plan <id> from preview, or --yes");
		if (plan !== undefined && yes) usage("Use either --plan or --yes, not both");
		if (typeof plan === "string" && !PLAN_ID.test(plan))
			usage("--plan must be the 16-character id preview printed");
	}
	return {
		command: /** @type {CliArgs["command"]} */ (command),
		bundle,
		target,
		plan: typeof plan === "string" ? plan : undefined,
		yes,
		json: options.get("json") === true,
	};
}

/**
 * @param {string} arg
 * @returns {[string, string | undefined]}
 */
function splitOption(arg) {
	const equals = arg.indexOf("=");
	return equals === -1 ? [arg.slice(2), undefined] : [arg.slice(2, equals), arg.slice(equals + 1)];
}

/**
 * @param {string} message
 * @returns {never}
 */
function usage(message) {
	return fail("USAGE", message);
}
