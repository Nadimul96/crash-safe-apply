// The demo session shared by `pnpm demo` (live) and scripts/record-demo.js
// (animated SVG). It drives the real CLI against a scratch copy of the files
// in examples/: preview, apply killed with a real SIGKILL mid-way, status,
// rollback, and a diff against an untouched copy.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(repo, "bin", "crash-safe-apply.js");
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** @param {string} text */
export const stripAnsi = (text) => text.replace(ANSI, "");

/**
 * @typedef {object} Scene
 * @property {string} note      one-line comment shown before the command
 * @property {string} command   as a user would type it
 * @property {string} output    captured stdout and stderr, with ANSI colors
 * @property {boolean} killed
 */

/**
 * @typedef {object} SessionHooks
 * @property {(scene: Pick<Scene, "note" | "command">) => void} [onCommand]
 * @property {(text: string) => void} [onOutput]
 */

/**
 * @param {SessionHooks} [hooks]
 * @returns {Promise<Scene[]>}
 */
export async function runSession(hooks = {}) {
	const work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "csa-demo-")));
	try {
		await fs.cp(path.join(repo, "examples", "demo-bundle"), path.join(work, "demo-bundle"), {
			recursive: true,
		});
		await fs.cp(path.join(repo, "examples", "demo-target"), path.join(work, "site"), {
			recursive: true,
		});
		await fs.cp(path.join(repo, "examples", "demo-target"), path.join(work, "original"), {
			recursive: true,
		});
		const run = (/** @type {string} */ note, /** @type {string[]} */ args, killAfterFiles = 0) =>
			runCommand(work, note, args, killAfterFiles, hooks);

		const target = ["demo-bundle", "--target", "site"];
		const scenes = [
			await run("Preview is read-only. It prints what would change and a plan id.", [
				"preview",
				...target,
			]),
		];
		const plan = /Plan ([0-9a-f]{16})/.exec(scenes[0]?.output.replace(ANSI, "") ?? "")?.[1];
		if (!plan) throw new Error("preview printed no plan id");
		scenes.push(
			await run(
				"Apply exactly that plan. The demo sends SIGKILL after the second file.",
				["apply", ...target, "--plan", plan],
				2,
			),
			await run(
				"Status reads the journal: the run was interrupted, and here is how to finish or undo it.",
				["status", ...target],
			),
			await run("Roll back to the original bytes.", ["rollback", ...target]),
			await run("Compare with an untouched copy of the original directory.", ["diff"]),
		);
		return scenes.map((scene) => ({ ...scene, output: scene.output.replaceAll(work, "~/demo") }));
	} finally {
		await fs.rm(work, { recursive: true, force: true });
	}
}

/**
 * @param {string} cwd
 * @param {string} note
 * @param {string[]} args
 * @param {number} killAfterFiles  0 to let it finish
 * @param {SessionHooks} hooks
 * @returns {Promise<Scene>}
 */
function runCommand(cwd, note, args, killAfterFiles, hooks) {
	const isDiff = args[0] === "diff";
	const command = isDiff
		? "diff -r -x .crash-safe-apply original site && echo identical"
		: `crash-safe-apply ${args.join(" ")}`;
	hooks.onCommand?.({ note, command });
	const child = isDiff
		? spawn("sh", ["-c", command], { cwd })
		: spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, FORCE_COLOR: "1" } });
	let output = "";
	let published = 0;
	let killed = false;
	/** @param {Buffer} chunk */
	const collect = (chunk) => {
		const text = String(chunk);
		output += text;
		hooks.onOutput?.(text);
		published += (text.replace(ANSI, "").match(/(created|replaced) +\S/g) ?? []).length;
		if (killAfterFiles > 0 && !killed && published >= killAfterFiles) {
			killed = true;
			child.kill("SIGKILL");
		}
	};
	child.stdout.on("data", collect);
	child.stderr.on("data", collect);
	return new Promise((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (_code, signal) => {
			if (signal === "SIGKILL") {
				const line = "\u001b[31mKilled: 9\u001b[39m\n";
				output += line;
				hooks.onOutput?.(line);
			}
			resolve({ note, command, output, killed: signal === "SIGKILL" });
		});
	});
}
