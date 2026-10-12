// Renders a crash-safe-apply journal.log: one "<crc32> <json>" record per
// line. The log ends at the first line whose checksum fails (a torn append).
// Journal content is untrusted, so every value is escaped before display.

const STATE_COLOR = {
	prepared: "--s-prepared",
	applying: "--s-applying",
	applied: "--s-applied",
	complete: "--s-complete",
	incomplete: "--s-incomplete",
	restoring: "--s-restoring",
	restored: "--s-restored",
	interrupted: "--s-interrupted",
};

const STATE_MEANING = {
	prepared:
		"Originals backed up and the plan written, all fsynced. Nothing in the target touched yet.",
	applying: "Writing files: temp file, fsync, then rename(2) or link(2), then fsync the directory.",
	applied: "Every file published and its directory fsynced.",
	complete: "Every file read back and verified against the bundle.",
	incomplete: "Apply stopped because a file was not as expected. Nothing was overwritten.",
	restoring: "Putting originals back and removing created files.",
	restored: "Every original is back in place.",
};

const TERMINAL = new Set(["complete", "restored"]);
const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n += 1) {
		let c = n;
		for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

const app = document.getElementById("app");
const select = document.getElementById("sample-select");
const samples = Array.isArray(window.JOURNAL_SAMPLES) ? window.JOURNAL_SAMPLES : [];
let timelineFilter = "all";
let current = null;

function crc32(bytes) {
	let crc = 0xffffffff;
	for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function escapeHtml(value) {
	return String(value).replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
	);
}

function stateVar(state) {
	return `var(${STATE_COLOR[state] ?? "--muted"})`;
}

/** Parses raw bytes into verified records, stopping at the first bad line. */
function parseJournal(bytes) {
	const decoder = new TextDecoder();
	const records = [];
	let offset = 0;
	while (offset < bytes.length) {
		const newline = bytes.indexOf(0x0a, offset);
		if (newline === -1) break;
		const line = bytes.subarray(offset, newline);
		const crc = decoder.decode(line.subarray(0, 8));
		const json = line.subarray(9);
		if (
			line[8] !== 0x20 ||
			!/^[0-9a-f]{8}$/.test(crc) ||
			crc32(json).toString(16).padStart(8, "0") !== crc
		)
			break;
		try {
			records.push(JSON.parse(decoder.decode(json)));
		} catch {
			break;
		}
		offset = newline + 1;
	}
	const header = records[0];
	if (header?.type !== "prepared" || !Array.isArray(header.files)) {
		throw new Error(
			records.length === 0
				? "No valid record found. Is this a crash-safe-apply journal.log?"
				: "The first record is not a prepared record.",
		);
	}
	return { records, header, discardedBytes: bytes.length - offset };
}

/** Folds records into per-file status and the sequence of journal states. */
function fold(parsed) {
	const files = parsed.header.files.map((file) => ({ ...file, status: "pending" }));
	const path = ["prepared"];
	for (const record of parsed.records.slice(1)) {
		if (record.type === "state" && path[path.length - 1] !== record.state) path.push(record.state);
		if (record.type === "file" && files[record.index]) files[record.index].status = record.status;
	}
	const state = path[path.length - 1];
	return { ...parsed, files, path, state };
}

function overall(view) {
	if (view.state === "incomplete") return "incomplete";
	return TERMINAL.has(view.state) ? view.state : "interrupted";
}

function formatOffset(ms) {
	if (!Number.isFinite(ms)) return "";
	if (ms < 1000) return `+${Math.round(ms)} ms`;
	return `+${(ms / 1000).toFixed(2)} s`;
}

function plural(count, one, many) {
	return `${count} ${count === 1 ? one : many}`;
}

function formatBytes(size) {
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
	return `${(size / 1024 / 1024).toFixed(1)} MiB`;
}

function describeRecord(record, view) {
	const file = view.header.files[record.index];
	const pathHtml = file ? `<code>${escapeHtml(file.path)}</code>` : "";
	switch (record.type) {
		case "prepared": {
			const originals = record.files.filter((f) => f.original).length;
			const counts = [
				plural(record.files.length, "file", "files"),
				`${plural(originals, "original", "originals")} backed up`,
				`${plural(record.directories.length, "directory", "directories")} to create`,
			];
			return {
				title: "Journal prepared",
				detail: `${counts.join(", ")}. Plan ${escapeHtml(record.plan)}.`,
			};
		}
		case "state":
			return {
				title: `State <span class="chip" style="--state:${stateVar(record.state)}">${escapeHtml(record.state)}</span>`,
				detail: escapeHtml(record.note ?? STATE_MEANING[record.state] ?? ""),
			};
		case "file": {
			const create = file?.action === "create";
			const verbs = {
				applying: "Writing",
				applied: create ? "Created" : "Replaced",
				restoring: create ? "Removing" : "Restoring",
				restored: create ? "Removed" : "Restored",
				pending: "Pending",
			};
			const how = {
				applied: create
					? "temp file, fsync, link(2), fsync directory"
					: "temp file, fsync, rename(2), fsync directory",
				restored: create
					? "unlink(2), fsync directory"
					: "original from backup, fsync, rename(2), fsync directory",
			};
			return {
				title: `${verbs[record.status] ?? escapeHtml(record.status)} ${pathHtml}`,
				detail: escapeHtml(record.note ?? how[record.status] ?? ""),
			};
		}
		case "dir": {
			const verbs = {
				created: "Created directory",
				removed: "Removed directory",
				kept: "Kept directory",
			};
			const detail =
				record.status === "kept"
					? "Left in place because it is not empty."
					: "Parent directory fsynced.";
			return {
				title: `${verbs[record.status] ?? "Directory"} <code>${escapeHtml(record.path)}/</code>`,
				detail,
			};
		}
		case "error":
			return { title: "Stopped", detail: escapeHtml(record.message) };
		default:
			return { title: escapeHtml(record.type), detail: "" };
	}
}

function renderSummary(view, description) {
	const state = overall(view);
	const header = view.header;
	const start = Date.parse(header.at);
	const last = view.records[view.records.length - 1];
	const elapsed = Date.parse(last.at) - start;
	const creates = header.files.filter((f) => f.action === "create").length;
	const synced = view.records.filter((r) => r.sync).length;
	const label = state === view.state ? state : `${state} (${view.state})`;
	const notices = [];
	if (view.discardedBytes > 0) {
		notices.push(
			notice(
				"--s-interrupted",
				`<strong>Torn final record.</strong> The last ${view.discardedBytes} bytes fail their checksum: the process died while appending. Recovery ignores them and truncates the log before writing again.`,
			),
		);
	}
	if (state === "interrupted") {
		notices.push(
			notice(
				"--s-interrupted",
				`<strong>The run stopped in state "${escapeHtml(view.state)}".</strong> <code>status</code> reports it as interrupted; <code>apply --plan ${escapeHtml(header.plan)}</code> finishes it and <code>rollback</code> undoes it.`,
			),
		);
	}
	return `
		<section class="card summary" aria-label="Journal summary">
			<div>
				<h1>${escapeHtml(header.bundle?.name ?? header.bundle?.id ?? "bundle")}</h1>
				<p class="description">${escapeHtml(description)}</p>
			</div>
			<span class="state-badge" style="--state:${stateVar(state)}">${escapeHtml(label)}</span>
			<dl class="meta">
				<div><dt>Target</dt><dd class="mono" title="${escapeHtml(header.target)}">${escapeHtml(header.target)}</dd></div>
				<div><dt>Bundle · generation</dt><dd class="mono">${escapeHtml(header.bundle?.id ?? "")} · ${escapeHtml(header.generation)}</dd></div>
				<div><dt>Files</dt><dd>${header.files.length - creates} replace · ${creates} create</dd></div>
				<div><dt>Records</dt><dd>${view.records.length} verified · ${synced} fsynced · ${formatOffset(elapsed).replace("+", "")}</dd></div>
			</dl>
			${notices.join("")}
		</section>`;
}

function notice(tone, html) {
	return `<div class="notice" style="--tone:var(${tone})"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5"/><path d="M8 4.8v3.6M8 11h0"/></svg><div>${html}</div></div>`;
}

const NODES = {
	prepared: [70, 48],
	applying: [250, 48],
	applied: [430, 48],
	complete: [610, 48],
	incomplete: [340, 150],
	restoring: [520, 150],
	restored: [690, 150],
};

const EDGES = [
	["prepared", "applying", "M118 48 H202"],
	["applying", "applied", "M298 48 H382"],
	["applied", "complete", "M478 48 H562"],
	["applying", "incomplete", "M272 66 L322 130"],
	["applied", "incomplete", "M410 66 L360 130"],
	["incomplete", "applying", "M294 146 Q236 140 230 70"],
	["incomplete", "restoring", "M388 150 H468"],
	["complete", "restoring", "M592 66 L540 130"],
	["prepared", "restoring", "M70 66 V172 Q70 186 84 186 H506 Q520 186 520 172"],
	["restoring", "restored", "M568 150 H638"],
];

function renderMachine(view) {
	const visitedEdges = new Set();
	for (let i = 1; i < view.path.length; i += 1)
		visitedEdges.add(`${view.path[i - 1]}>${view.path[i]}`);
	const visited = new Set(view.path);
	const edges = EDGES.map(([from, to, d]) => {
		const on = visitedEdges.has(`${from}>${to}`);
		return `<path class="edge${on ? " visited" : ""}" d="${d}"/>`;
	}).join("");
	const nodes = Object.entries(NODES)
		.map(([state, [x, y]]) => {
			const classes = [
				"node",
				visited.has(state) ? "visited" : "",
				view.state === state ? "current" : "",
			].join(" ");
			return `<g class="${classes}" style="--state:${stateVar(state)}"><rect x="${x - 48}" y="${y - 17}" width="96" height="34" rx="9"/><text x="${x}" y="${y}">${state}</text></g>`;
		})
		.join("");
	const chips = view.path
		.map((state) => `<span class="chip" style="--state:${stateVar(state)}">${state}</span>`)
		.join('<span class="sep">→</span>');
	return `
		<section class="card machine" aria-label="Journal state machine">
			<h2 class="section-title">State machine · path taken</h2>
			<svg viewBox="0 0 760 200" role="img" aria-label="States visited: ${escapeHtml(view.path.join(", "))}">
				<defs>
					<marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 8 4 0 8Z"/></marker>
					<marker id="arrow-strong" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 8 4 0 8Z"/></marker>
				</defs>
				${edges}${nodes}
				<text class="edge-label" x="206" y="118">resume</text>
				<text class="edge-label" x="190" y="180">rollback before any change</text>
			</svg>
			<div class="path-chips">${chips}</div>
			<div class="legend"><span><i></i>transition this journal took</span><span><i class="faint"></i>possible transition</span></div>
		</section>`;
}

function renderTimeline(view) {
	const start = Date.parse(view.header.at);
	const items = view.records
		.filter(
			(r) =>
				timelineFilter === "all" ||
				r.type === "state" ||
				r.type === "prepared" ||
				r.type === "error",
		)
		.map((record) => {
			const { title, detail } = describeRecord(record, view);
			const color =
				record.type === "state"
					? stateVar(record.state)
					: record.type === "prepared"
						? stateVar("prepared")
						: "var(--muted)";
			const sync = record.sync
				? '<span class="sync" title="fsynced before the next step">fsync</span>'
				: "";
			return `
				<li class="event kind-${escapeHtml(record.type)}" style="--state:${color}">
					<span class="dot"><i></i></span>
					<div class="event-title">${title}</div>
					<div class="event-side"><span class="offset">#${escapeHtml(record.seq)} · ${formatOffset(Date.parse(record.at) - start)}</span>${sync}</div>
					<div class="event-detail">${detail}</div>
				</li>`;
		});
	if (view.discardedBytes > 0) {
		items.push(`
			<li class="event torn" style="--state:var(--s-interrupted)">
				<span class="dot"><i></i></span>
				<div class="event-title">Torn record (${view.discardedBytes} bytes)</div>
				<div class="event-side"><span class="offset">checksum fails</span></div>
				<div class="event-detail">The append was cut short by the crash. Everything above it verified.</div>
			</li>`);
	}
	const pressed = (value) => `aria-pressed="${timelineFilter === value}"`;
	return `
		<section class="card" aria-label="Timeline">
			<div class="panel-head">
				<h2 class="section-title">Timeline</h2>
				<div class="segmented" role="group" aria-label="Filter timeline">
					<button type="button" data-filter="all" ${pressed("all")}>All records</button>
					<button type="button" data-filter="state" ${pressed("state")}>State changes</button>
				</div>
			</div>
			<ol class="timeline">${items.join("")}</ol>
		</section>`;
}

function renderFiles(view) {
	const rows = view.files.map((file) => {
		const status = file.status;
		const color = {
			pending: "--muted",
			applying: "--s-interrupted",
			applied: "--s-complete",
			restoring: "--s-interrupted",
			restored: "--s-restored",
		}[status];
		const before = file.original ? `${escapeHtml(file.original.sha256.slice(0, 10))} → ` : "new → ";
		const mode = `mode ${Number(file.mode).toString(8).padStart(4, "0")}`;
		return `
			<div class="file-row">
				<div class="file-path">${escapeHtml(file.path)}</div>
				<div class="file-tags">
					<span class="action-tag">${escapeHtml(file.action)}</span>
					<span class="chip" style="--state:var(${color ?? "--muted"})">${escapeHtml(status)}</span>
				</div>
				<div class="file-meta">
					<span>${formatBytes(Number(file.size))}</span>
					<span>${mode}</span>
					<span>sha256 <span class="mono">${before}${escapeHtml(String(file.sha256).slice(0, 10))}</span></span>
				</div>
			</div>`;
	});
	return `
		<section class="card" aria-label="Files">
			<div class="panel-head"><h2 class="section-title">Files · last recorded status</h2></div>
			<div class="files">${rows.join("") || '<p class="empty-files">This journal lists no files.</p>'}</div>
		</section>`;
}

function renderError(message, name) {
	app.innerHTML = `
		<section class="card state-error" role="alert">
			<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 7v6M12 16.5h0"/></svg>
			<h2>Could not read ${escapeHtml(name)}</h2>
			<p>${escapeHtml(message)} Pick one of the samples above, or open a <code>journal.log</code> from a target's <code>.crash-safe-apply</code> directory.</p>
		</section>`;
}

function render() {
	if (!current) return;
	app.innerHTML = `${renderSummary(current.view, current.description)}${renderMachine(current.view)}<div class="columns">${renderTimeline(current.view)}${renderFiles(current.view)}</div>`;
	for (const button of app.querySelectorAll("[data-filter]")) {
		button.addEventListener("click", () => {
			timelineFilter = button.dataset.filter;
			render();
		});
	}
}

function show(bytes, name, description) {
	try {
		current = { view: fold(parseJournal(bytes)), description };
		render();
	} catch (error) {
		current = null;
		renderError(error instanceof Error ? error.message : String(error), name);
	}
}

function showSample(id) {
	const sample = samples.find((s) => s.id === id) ?? samples[0];
	if (!sample) {
		renderError("No samples are bundled with this page.", "samples");
		return;
	}
	select.value = sample.id;
	show(new TextEncoder().encode(sample.journal), sample.label, sample.description);
}

async function showFile(file) {
	if (file.size > 64 * 1024 * 1024) {
		renderError("The file is larger than 64 MiB, which no journal should be.", file.name);
		return;
	}
	select.value = "";
	show(
		new Uint8Array(await file.arrayBuffer()),
		file.name,
		`Loaded from ${file.name} (${formatBytes(file.size)}).`,
	);
}

function setupTheme() {
	const root = document.documentElement;
	try {
		const saved = localStorage.getItem("journal-viewer-theme");
		if (saved === "light" || saved === "dark") root.dataset.theme = saved;
	} catch {
		// Storage can be unavailable (private mode); the system theme still applies.
	}
	document.getElementById("theme-toggle").addEventListener("click", () => {
		const dark = root.dataset.theme
			? root.dataset.theme === "dark"
			: matchMedia("(prefers-color-scheme: dark)").matches;
		root.dataset.theme = dark ? "light" : "dark";
		try {
			localStorage.setItem("journal-viewer-theme", root.dataset.theme);
		} catch {
			// Not persisted; fine.
		}
	});
}

function setupInputs() {
	const options = samples
		.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.label)}</option>`)
		.join("");
	select.innerHTML = `<optgroup label="Sample journals">${options}</optgroup><option value="" hidden>Your file</option>`;
	select.addEventListener("change", () => {
		if (select.value) {
			showSample(select.value);
			history.replaceState(null, "", `#${select.value}`);
		}
	});
	document.getElementById("file-input").addEventListener("change", (event) => {
		const file = event.target.files?.[0];
		if (file) showFile(file);
		event.target.value = "";
	});
	const overlay = document.getElementById("drop-overlay");
	let depth = 0;
	window.addEventListener("dragenter", (event) => {
		if (!event.dataTransfer?.types.includes("Files")) return;
		depth += 1;
		overlay.hidden = false;
	});
	window.addEventListener("dragleave", () => {
		depth = Math.max(0, depth - 1);
		if (depth === 0) overlay.hidden = true;
	});
	window.addEventListener("dragover", (event) => event.preventDefault());
	window.addEventListener("drop", (event) => {
		event.preventDefault();
		depth = 0;
		overlay.hidden = true;
		const file = event.dataTransfer?.files?.[0];
		if (file) showFile(file);
	});
}

setupTheme();
setupInputs();
showSample(location.hash.slice(1));
