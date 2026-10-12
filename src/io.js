import { constants as FS } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

/** @import { FileHandle } from "node:fs/promises" */
/** @import { FaultHook, FaultPoint, IoStats } from "./types.js" */

const CREATE_NEW = FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW;
const APPEND = FS.O_WRONLY | FS.O_APPEND | FS.O_NOFOLLOW;
const OPEN_DIRECTORY = FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW;

/**
 * The only module that mutates the filesystem. Routing every write, rename,
 * link, unlink, mkdir and fsync through one place gives tests a hook after
 * each step (to simulate a crash there) and gives benchmarks an fsync count.
 */
export class Io {
	#root;
	#faults;
	#seq = 0;
	/** @type {{ error: unknown } | null} */
	#halted = null;
	/** @type {IoStats} */
	stats = { steps: 0, fsyncs: 0, dirFsyncs: 0 };

	/**
	 * @param {string} root      target directory; fault points report paths relative to it
	 * @param {FaultHook} [faults]
	 */
	constructor(root, faults) {
		this.#root = root;
		this.#faults = faults;
	}

	/**
	 * @param {string} directory
	 * @param {number} mode
	 * @param {string} step
	 */
	async mkdir(directory, mode, step) {
		this.#guard();
		await fs.mkdir(directory, { mode });
		await this.#after("mkdir", directory, step);
	}

	/**
	 * Creates a file that must not already exist (O_EXCL), refusing to follow a
	 * symlink at its name (O_NOFOLLOW), sets its exact mode and, by default,
	 * fsyncs it so its bytes are on disk before anything refers to it.
	 * @param {string} file
	 * @param {Uint8Array} data
	 * @param {number} mode
	 * @param {string} step
	 * @param {{ sync?: boolean }} [options]
	 */
	async writeNewFile(file, data, mode, step, { sync = true } = {}) {
		this.#guard();
		const handle = await fs.open(file, CREATE_NEW, 0o600);
		try {
			await this.#after("create", file, step);
			await this.#write(handle, file, data, step);
			// The umask may have narrowed the mode passed to open(2).
			await handle.chmod(mode);
			await this.#after("chmod", file, step);
			if (sync) await this.#fsync(handle, file, step);
		} finally {
			await handle.close();
		}
	}

	/**
	 * @param {string} file
	 * @returns {Promise<FileHandle>}
	 */
	async openForAppend(file) {
		this.#guard();
		return fs.open(file, APPEND);
	}

	/**
	 * @param {FileHandle} handle
	 * @param {string} file
	 * @param {Uint8Array} data
	 * @param {boolean} durable  fsync before returning
	 * @param {string} step
	 */
	async append(handle, file, data, durable, step) {
		this.#guard();
		await this.#write(handle, file, data, step);
		if (durable) await this.#fsync(handle, file, step);
	}

	/**
	 * @param {FileHandle} handle
	 * @param {string} file
	 * @param {number} length
	 * @param {string} step
	 */
	async truncate(handle, file, length, step) {
		this.#guard();
		await handle.truncate(length);
		await this.#after("truncate", file, step);
		await this.#fsync(handle, file, step);
	}

	/**
	 * @param {string} from
	 * @param {string} to
	 * @param {string} step
	 */
	async rename(from, to, step) {
		this.#guard();
		await fs.rename(from, to);
		await this.#after("rename", to, step);
	}

	/**
	 * @param {string} existing
	 * @param {string} newName
	 * @param {string} step
	 */
	async link(existing, newName, step) {
		this.#guard();
		await fs.link(existing, newName);
		await this.#after("link", newName, step);
	}

	/**
	 * @param {string} file
	 * @param {string} step
	 */
	async unlink(file, step) {
		this.#guard();
		await fs.unlink(file);
		await this.#after("unlink", file, step);
	}

	/**
	 * @param {string} directory
	 * @param {string} step
	 */
	async rmdir(directory, step) {
		this.#guard();
		await fs.rmdir(directory);
		await this.#after("rmdir", directory, step);
	}

	/**
	 * Makes a directory's entries durable: a new, renamed or removed name is
	 * not guaranteed to survive power loss until its parent directory is fsynced.
	 * @param {string} directory
	 * @param {string} step
	 */
	async syncDirectory(directory, step) {
		this.#guard();
		const handle = await fs.open(directory, OPEN_DIRECTORY);
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
		this.stats.dirFsyncs += 1;
		await this.#after("fsync-dir", directory, step);
	}

	/**
	 * When a fault hook is installed, writes are split in two so a torn write
	 * (only the first half on disk) is one of the simulated crash points.
	 * @param {FileHandle} handle
	 * @param {string} file
	 * @param {Uint8Array} data
	 * @param {string} step
	 */
	async #write(handle, file, data, step) {
		const split = this.#faults && data.length > 1 ? Math.floor(data.length / 2) : 0;
		if (split > 0) {
			await writeAll(handle, data.subarray(0, split));
			await this.#after("write-partial", file, step);
		}
		await writeAll(handle, data.subarray(split));
		await this.#after("write", file, step);
	}

	/**
	 * @param {FileHandle} handle
	 * @param {string} file
	 * @param {string} step
	 */
	async #fsync(handle, file, step) {
		// On macOS, libuv implements fsync with F_FULLFSYNC, which also flushes the drive cache.
		await handle.sync();
		this.stats.fsyncs += 1;
		await this.#after("fsync", file, step);
	}

	/**
	 * @param {FaultPoint["op"]} op
	 * @param {string} file
	 * @param {string} step
	 */
	async #after(op, file, step) {
		this.#seq += 1;
		this.stats.steps += 1;
		if (!this.#faults) return;
		const point = {
			seq: this.#seq,
			op,
			path: path.relative(this.#root, file) || ".",
			step,
		};
		try {
			await this.#faults(point);
		} catch (error) {
			this.#halted = { error };
			throw error;
		}
	}

	/** After a fault hook throws, every later mutation fails the same way, as if the process had died. */
	#guard() {
		if (this.#halted) throw this.#halted.error;
	}
}

/**
 * @param {FileHandle} handle
 * @param {Uint8Array} data
 */
async function writeAll(handle, data) {
	let offset = 0;
	while (offset < data.length) {
		const { bytesWritten } = await handle.write(data, offset, data.length - offset);
		offset += bytesWritten;
	}
}
