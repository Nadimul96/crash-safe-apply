#!/usr/bin/env node
// `pnpm demo`: preview, apply, a real kill -9 mid-apply, status, rollback,
// and proof that the directory is byte-identical to the original. Runs in a
// scratch copy of examples/; nothing outside it is touched.
import { runSession, stripAnsi } from "./demo-session.js";

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (/** @type {string} */ text) => (color ? `\u001b[2m${text}\u001b[22m` : text);
const bold = (/** @type {string} */ text) => (color ? `\u001b[1m${text}\u001b[22m` : text);
const strip = (/** @type {string} */ text) => (color ? text : stripAnsi(text));

process.stdout.write(
	`${bold("crash-safe-apply demo")} ${dim("(scratch copy of examples/, removed afterwards)")}\n`,
);
let step = 0;
await runSession({
	onCommand: ({ note, command }) => {
		step += 1;
		process.stdout.write(`\n${dim(`# ${step}. ${note}`)}\n${bold(`$ ${command}`)}\n`);
	},
	onOutput: (text) => process.stdout.write(strip(text)),
});
process.stdout.write(
	`\n${dim("Every step above ran the real CLI. See docs/media/demo.svg for the recording.")}\n`,
);
