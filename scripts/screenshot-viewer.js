#!/usr/bin/env node
// Captures the journal viewer in light and dark, desktop and mobile, into
// docs/media. Uses an already-installed Chromium: set CHROMIUM_PATH, or it
// picks the newest headless shell in the Playwright cache.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const page = pathToFileURL(path.join(repo, "viewer", "index.html")).href;
const out = path.join(repo, "docs", "media");

function findChromium() {
	if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
	const caches = [
		path.join(os.homedir(), "Library", "Caches", "ms-playwright"),
		path.join(os.homedir(), ".cache", "ms-playwright"),
	];
	for (const cache of caches) {
		if (!fs.existsSync(cache)) continue;
		const shells = fs
			.readdirSync(cache)
			.filter((name) => name.startsWith("chromium_headless_shell-"))
			.sort()
			.reverse();
		for (const shell of shells) {
			const dir = path.join(cache, shell);
			for (const sub of fs.readdirSync(dir)) {
				const binary = path.join(dir, sub, "chrome-headless-shell");
				if (fs.existsSync(binary)) return binary;
			}
		}
	}
	throw new Error("No Chromium found. Set CHROMIUM_PATH to a Chrome or Chromium binary.");
}

const shots = [
	{
		name: "viewer-light-desktop",
		scheme: "light",
		width: 1440,
		height: 900,
		scale: 2,
		sample: "killed",
		full: true,
	},
	{
		name: "viewer-dark-desktop",
		scheme: "dark",
		width: 1440,
		height: 900,
		scale: 2,
		sample: "refused",
		full: true,
	},
	{
		name: "viewer-light-mobile",
		scheme: "light",
		width: 390,
		height: 844,
		scale: 2,
		sample: "killed",
		full: false,
	},
	{
		name: "viewer-dark-mobile",
		scheme: "dark",
		width: 390,
		height: 844,
		scale: 2,
		sample: "refused",
		full: false,
	},
];

const browser = await chromium.launch({ executablePath: findChromium() });
try {
	fs.mkdirSync(out, { recursive: true });
	for (const shot of shots) {
		const context = await browser.newContext({
			viewport: { width: shot.width, height: shot.height },
			deviceScaleFactor: shot.scale,
			colorScheme: /** @type {"light" | "dark"} */ (shot.scheme),
		});
		const tab = await context.newPage();
		await tab.goto(`${page}#${shot.sample}`);
		await tab.waitForSelector(".summary");
		const file = path.join(out, `${shot.name}.png`);
		await tab.screenshot({ path: file, fullPage: shot.full });
		process.stdout.write(
			`${path.relative(repo, file)}  ${(fs.statSync(file).size / 1024).toFixed(0)} KiB\n`,
		);
		await context.close();
	}
} finally {
	await browser.close();
}
