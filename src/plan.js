import { DEFAULT_FILE_MODE } from "./constants.js";
import { fail } from "./errors.js";
import { readRegularFile, resolveInside, sha256 } from "./fsutil.js";
import { ancestorsOf } from "./paths.js";

/** @import { Bundle, BundleFile, ChangeAction, Fingerprint, Limits, Plan, PlannedChange } from "./types.js" */

/**
 * Compares the bundle with the target without writing anything. The plan id
 * is a digest of every input apply depends on (each target file's content,
 * mode, device and inode, and which directories are missing), so if anything
 * changes between preview and apply, the id changes and apply refuses.
 * @param {Bundle} bundle
 * @param {string} target  canonical target path
 * @param {Limits} limits
 * @returns {Promise<{ plan: Plan, originalData: Map<string, Buffer> }>}
 */
export async function buildPlan(bundle, target, limits) {
	/** @type {PlannedChange[]} */
	const changes = [];
	/** @type {Set<string>} */
	const directories = new Set();
	/** @type {Map<string, Buffer>} */
	const originalData = new Map();
	let originalBytes = 0;

	for (const file of bundle.files) {
		const resolved = await resolveInside(target, file.path);
		if (!resolved.stat) {
			for (const dir of ancestorsOf(file.path).slice(resolved.missingFrom)) directories.add(dir);
			changes.push(change(file, "create", file.mode ?? DEFAULT_FILE_MODE, null));
			continue;
		}
		if (!resolved.stat.isFile()) {
			fail("UNSUPPORTED_FILE", `${file.path} exists in the target but is not a regular file`);
		}
		const current = await readRegularFile(resolved.absolute, limits.maxFileBytes);
		const mode = file.mode ?? current.fingerprint.mode & 0o777;
		const unchanged =
			current.fingerprint.sha256 === file.sha256 && current.fingerprint.mode === mode;
		if (!unchanged) {
			assertReplaceable(file.path, current.fingerprint, current.uid);
			originalBytes += current.data.length;
			if (originalBytes > limits.maxTotalBytes) {
				fail("UNSUPPORTED_FILE", `Files to back up exceed ${limits.maxTotalBytes} bytes`);
			}
			originalData.set(file.path, current.data);
		}
		changes.push(change(file, unchanged ? "unchanged" : "replace", mode, current.fingerprint));
	}

	const sortedDirectories = [...directories].sort(
		(a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
	);
	const plan = {
		id: planId(bundle.digest, target, changes, sortedDirectories),
		target,
		bundle: { id: bundle.id, digest: bundle.digest, name: bundle.name },
		changes,
		directories: sortedDirectories,
		summary: summarize(changes),
	};
	return { plan, originalData };
}

/**
 * We restore content and permission bits, not ownership or setuid/setgid/
 * sticky bits, so files where those matter are refused up front.
 * @param {string} relative
 * @param {Fingerprint} fingerprint
 * @param {number} uid
 */
function assertReplaceable(relative, fingerprint, uid) {
	if (typeof process.getuid === "function" && uid !== process.getuid()) {
		fail(
			"UNSUPPORTED_FILE",
			`${relative} is owned by another user; its ownership could not be restored`,
		);
	}
	if ((fingerprint.mode & 0o7000) !== 0) {
		fail(
			"UNSUPPORTED_FILE",
			`${relative} has setuid, setgid or sticky bits (${fingerprint.mode.toString(8)}); refusing to replace it`,
		);
	}
}

/**
 * @param {BundleFile} file
 * @param {ChangeAction} action
 * @param {number} mode
 * @param {Fingerprint | null} original
 * @returns {PlannedChange}
 */
function change(file, action, mode, original) {
	return {
		path: file.path,
		action,
		sha256: file.sha256,
		size: file.size,
		mode,
		original,
	};
}

/**
 * @param {string} bundleDigest
 * @param {string} target
 * @param {PlannedChange[]} changes
 * @param {string[]} directories
 */
function planId(bundleDigest, target, changes, directories) {
	const inputs = changes.map((c) => [
		c.path,
		c.action,
		c.sha256,
		c.mode,
		c.original && [
			c.original.sha256,
			c.original.size,
			c.original.mode,
			c.original.dev,
			c.original.ino,
		],
	]);
	const canonical = JSON.stringify({
		v: 1,
		bundleDigest,
		target,
		inputs,
		directories,
	});
	return sha256(Buffer.from(canonical)).slice(0, 16);
}

/** @param {PlannedChange[]} changes */
function summarize(changes) {
	const count = (/** @type {ChangeAction} */ action) =>
		changes.filter((c) => c.action === action).length;
	const bytes = changes.filter((c) => c.action !== "unchanged").reduce((sum, c) => sum + c.size, 0);
	return {
		create: count("create"),
		replace: count("replace"),
		unchanged: count("unchanged"),
		bytes,
	};
}
