import path from "node:path";
import { writeBundle } from "./bundles.js";
import { snapshot, tempDir, writeTree } from "./tree.js";

/** @import { BundleSpec } from "./bundles.js" */
/** @import { FileSpec } from "./tree.js" */

/** The target before apply. */
export const TARGET_FILES = {
	"config/app.toml": "port = 8080\nworkers = 2\n",
	"README.md": "# service\n",
	"notes/keep.txt": "not part of the bundle\n",
};

/**
 * One replace, two creates (one in a new nested directory), one create with an
 * explicit mode in another new directory, and one unchanged file.
 * @type {Record<string, string | BundleSpec>}
 */
export const BUNDLE_FILES = {
	"config/app.toml": "port = 8443\nworkers = 4\n\n[tls]\nenabled = true\n",
	"config/features.json": '{ "checkout_v2": true }\n',
	"config/tls/ciphers.conf": "TLS_AES_256_GCM_SHA384\nTLS_CHACHA20_POLY1305_SHA256\n",
	"README.md": "# service\n",
	"bin/health.sh": { content: "#!/bin/sh\nexit 0\n", mode: "0755" },
};

/**
 * @typedef {object} Scenario
 * @property {string} root
 * @property {string} target
 * @property {string} bundle
 * @property {string[]} original  snapshot of the target before apply
 * @property {string[]} expected  snapshot the target must have after apply
 */

/**
 * @typedef {{ targetFiles?: Record<string, FileSpec>, bundleFiles?: Record<string, string | BundleSpec> }} ScenarioOptions
 */

/**
 * @param {import("node:test").TestContext} t
 * @param {ScenarioOptions} [options]
 * @returns {Promise<Scenario>}
 */
export async function makeScenario(t, options = {}) {
	return buildScenario(await tempDir(t), options);
}

/**
 * @param {string} root  empty directory to build in
 * @param {ScenarioOptions} [options]
 * @returns {Promise<Scenario>}
 */
export async function buildScenario(root, options = {}) {
	const targetFiles = options.targetFiles ?? TARGET_FILES;
	const bundleFiles = options.bundleFiles ?? BUNDLE_FILES;
	const target = path.join(root, "target");
	const bundle = path.join(root, "bundle");
	const expectedDir = path.join(root, "expected");
	await writeTree(target, targetFiles);
	await writeBundle(bundle, bundleFiles, { name: "test-bundle" });
	await writeTree(expectedDir, targetFiles);
	await writeTree(expectedDir, asTree(bundleFiles));
	return {
		root,
		target,
		bundle,
		original: await snapshot(target),
		expected: await snapshot(expectedDir),
	};
}

/**
 * @param {Record<string, string | BundleSpec>} files
 * @returns {Record<string, FileSpec>}
 */
function asTree(files) {
	/** @type {Record<string, FileSpec>} */
	const tree = {};
	for (const [relative, spec] of Object.entries(files)) {
		tree[relative] =
			typeof spec === "string"
				? spec
				: { content: spec.content, mode: spec.mode ? Number.parseInt(spec.mode, 8) : undefined };
	}
	return tree;
}
