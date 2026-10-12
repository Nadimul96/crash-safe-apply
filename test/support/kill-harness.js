// Child process for the SIGKILL tests: runs a real apply and, at the chosen
// step, reports it and blocks so the parent can kill -9 it at that point.
//
//   node test/support/kill-harness.js <bundle> <target> <plan> <step-number>
import { apply } from "../../src/apply.js";

const [bundle = "", target = "", plan, pauseAt] = process.argv.slice(2);
await apply({
	bundle,
	target,
	plan,
	faults: async (point) => {
		if (point.seq !== Number(pauseAt)) return;
		process.stdout.write(`PAUSED ${JSON.stringify(point)}\n`);
		await new Promise(() => setInterval(() => {}, 60_000));
	},
});
process.stdout.write("FINISHED\n");
