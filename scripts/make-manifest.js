#!/usr/bin/env node
// Writes <bundle>/manifest.json listing every file under <bundle>/files with
// its sha256. Executable files get "mode": "0755"; others keep the default.
//
//   node scripts/make-manifest.js <bundle-dir> [--name <name>]
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { BUNDLE_FORMAT } from "../src/constants.js";

const [bundleDir, flag, name] = process.argv.slice(2);
if (!bundleDir || (flag !== undefined && flag !== "--name")) {
	process.stderr.write("Usage: node scripts/make-manifest.js <bundle-dir> [--name <name>]\n");
	process.exit(2);
}

const root = path.join(bundleDir, "files");
const files = [];
for (const relative of (await fs.readdir(root, { recursive: true })).sort()) {
	const absolute = path.join(root, relative);
	const stat = await fs.lstat(absolute);
	if (stat.isDirectory()) continue;
	if (!stat.isFile()) throw new Error(`Not a regular file: ${absolute}`);
	const sha256 = createHash("sha256")
		.update(await fs.readFile(absolute))
		.digest("hex");
	const entry = { path: relative.split(path.sep).join("/"), sha256 };
	files.push(stat.mode & 0o111 ? { ...entry, mode: "0755" } : entry);
}
const manifest = { format: BUNDLE_FORMAT, ...(name ? { name } : {}), files };
await fs.writeFile(path.join(bundleDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`Wrote ${files.length} entries to ${path.join(bundleDir, "manifest.json")}\n`);
