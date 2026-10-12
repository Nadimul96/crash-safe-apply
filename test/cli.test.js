import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseArgs } from "../src/cli/args.js";
import { main } from "../src/cli/main.js";
import { makeScenario } from "./support/scenario.js";
import { snapshot } from "./support/tree.js";

const CLI = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"bin",
	"crash-safe-apply.js",
);

/**
 * Runs the CLI in-process and captures its output.
 * @param {string[]} argv
 */
async function invoke(...argv) {
	let stdout = "";
	let stderr = "";
	const code = await main(argv, {
		stdout: { write: (text) => (stdout += text) },
		stderr: { write: (text) => (stderr += text) },
		env: {},
	});
	return { code, stdout, stderr };
}

describe("argument parsing", () => {
	it("parses a full apply command", () => {
		assert.deepEqual(
			parseArgs(["apply", "b", "--target", "t", "--plan", "0123456789abcdef", "--json"]),
			{
				command: "apply",
				bundle: "b",
				target: "t",
				plan: "0123456789abcdef",
				yes: false,
				json: true,
			},
		);
		assert.equal(/** @type {any} */ (parseArgs(["status", "b", "--target=t"])).target, "t");
	});

	it("rejects incomplete or contradictory commands", () => {
		const cases = [
			[["explode", "b", "--target", "t"], /Unknown command/],
			[["preview", "--target", "t"], /bundle .* is required/],
			[["preview", "b"], /--target <dir> is required/],
			[["apply", "b", "--target", "t"], /needs --plan/],
			[["apply", "b", "--target", "t", "--plan", "xyz"], /16-character/],
			[
				["apply", "b", "--target", "t", "--plan", "0123456789abcdef", "--yes"],
				/either --plan or --yes/,
			],
			[["rollback", "b", "--target", "t", "--yes"], /only for apply/],
			[["preview", "b", "--target", "t", "--target", "u"], /given twice/],
			[["preview", "b", "--target", "t", "--force"], /Unknown option --force/],
			[["preview", "b", "c", "--target", "t"], /Unexpected argument/],
		];
		for (const [argv, message] of cases) {
			assert.throws(() => parseArgs(/** @type {string[]} */ (argv)), {
				code: "USAGE",
				message: /** @type {RegExp} */ (message),
			});
		}
	});
});

describe("crash-safe-apply CLI", () => {
	it("prints help and exits 0, and exits 2 on usage errors", async () => {
		const help = await invoke("--help");
		assert.equal(help.code, 0);
		assert.match(help.stdout, /Usage: crash-safe-apply <command>/);
		const bad = await invoke("apply", "b", "--target", "t");
		assert.equal(bad.code, 2);
		assert.match(bad.stderr, /needs --plan/);
	});

	it("runs preview -> apply -> status -> rollback with human output", async (t) => {
		const s = await makeScenario(t);
		const previewed = await invoke("preview", s.bundle, "--target", s.target);
		assert.equal(previewed.code, 0);
		assert.match(previewed.stdout, /~ replace\s+config\/app\.toml/);
		assert.match(previewed.stdout, /\+ create\s+config\/tls\/ciphers\.conf/);
		assert.match(previewed.stdout, /= same\s+README\.md/);
		const plan = /Plan ([0-9a-f]{16})/.exec(previewed.stdout)?.[1] ?? "";
		assert.match(previewed.stdout, new RegExp(`--plan ${plan}`));

		const applied = await invoke("apply", s.bundle, "--target", s.target, "--plan", plan);
		assert.equal(applied.code, 0, applied.stderr);
		assert.match(applied.stdout, /journal {2}applying /);
		assert.match(applied.stdout, /\+ created\s+config\/features\.json/);
		assert.match(applied.stdout, /journal {2}complete /);
		assert.deepEqual(await snapshot(s.target), s.expected);

		const reported = await invoke("status", s.bundle, "--target", s.target);
		assert.equal(reported.code, 0);
		assert.match(reported.stdout, /State {4}complete/);

		const rolled = await invoke("rollback", s.bundle, "--target", s.target);
		assert.equal(rolled.code, 0);
		assert.match(rolled.stdout, /Restored\./);
		assert.deepEqual(await snapshot(s.target), s.original);
	});

	it("refuses a stale plan id with exit 1 and a JSON error", async (t) => {
		const s = await makeScenario(t);
		const result = await invoke(
			"apply",
			s.bundle,
			"--target",
			s.target,
			"--plan",
			"0000000000000000",
			"--json",
		);
		assert.equal(result.code, 1);
		const body = JSON.parse(result.stdout);
		assert.equal(body.ok, false);
		assert.equal(body.error.code, "PLAN_MISMATCH");
		assert.deepEqual(await snapshot(s.target), s.original);
	});

	it("works as an executable", async () => {
		const { stdout } = await promisify(execFile)(process.execPath, [CLI, "--version"]);
		assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
	});
});
