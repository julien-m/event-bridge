/** Local observation contracts: true health, minimization, bounded retention and passive SSE. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runInNewContext } from "node:vm";
import { test } from "vitest";
import { configSchema } from "../src/config.ts";
import { Dispatcher } from "../src/dispatcher.ts";
import type { Signal } from "../src/events.ts";
import { ModuleStore, ModuleTasks } from "../src/module-tasks.ts";
import { startPanel } from "../src/panel.ts";
import { Sessions } from "../src/sessions.ts";
import { Store } from "../src/store.ts";
import {
	BoundedJournal,
	RECENT_EVENTS,
	type RuntimeHealth,
	readQueueSummary,
	Telemetry,
} from "../src/telemetry.ts";

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "bridge-observation-"));
	const repo = `owner/repo-${randomUUID()}`;
	const idle = {
		stopped: false,
		draining: false,
		lastStartedAt: null,
		lastFinishedAt: null,
		running: 0,
	};
	const health: RuntimeHealth = {
		process: "running",
		enabled: true,
		worker: "connected",
		ownership: "watching",
		ownershipCheckedAt: Date.now(),
		owners: 0,
		github: { ...idle },
		modules: {
			...idle,
			configurationValid: true,
			registered: 0,
			activeTasks: 0,
		},
	};
	const telemetry = new Telemetry(
		new BoundedJournal(directory, 2048),
		[repo],
		() => health,
		() => [],
	);
	return {
		directory,
		repo,
		health,
		telemetry,
		cleanup: () => rmSync(directory, { recursive: true, force: true }),
	};
}

test("connected transport never hides stopped dispatchers or invalid module configuration", {
	timeout: 2000,
}, async () => {
	const f = fixture();
	const store = new Store(join(f.directory, "inbox.sqlite"));
	const config = configSchema.parse({
		relayUrl: "https://relay.example",
		clientTokenEntry: "test/dev/client",
		credsBin: process.execPath,
		codexBin: process.execPath,
		ghBin: process.execPath,
		codexHome: f.directory,
		stateDir: f.directory,
		repositories: [{ repo: f.repo, path: f.directory }],
		reviewAuthors: ["bot"],
		tasksFile: join(f.directory, "missing.json"),
	});
	const sessions = new Sessions(config);
	const dispatcher = new Dispatcher(config, store, sessions);
	const modules = new ModuleTasks(config, new ModuleStore(store.db), {
		owners: () => 0,
		githubBusy: () => false,
		githubCount: () => 0,
		checkoutBusy: async () => false,
		released: () => {},
	});
	try {
		await modules.drain();
		assert.equal(modules.status().configurationValid, false);
		dispatcher.stop();
		modules.stop();
		f.health.github = dispatcher.status();
		f.health.modules = modules.status();
		const s = f.telemetry.snapshot();
		assert.equal(s.health.worker, "connected");
		assert.equal(s.health.github.stopped, true);
		assert.equal(s.health.modules.stopped, true);
		assert.equal(s.health.modules.configurationValid, false);
		assert.ok(s.health.modules.lastFinishedAt);
	} finally {
		sessions.close();
		store.close();
		f.cleanup();
	}
});

test("journal allowlist drops raw fields and hashes IDs; grouping and retention remain bounded", {
	timeout: 2000,
}, () => {
	const f = fixture();
	const secret = randomBytes(32).toString("hex");
	try {
		for (let i = 0; i < RECENT_EVENTS + 12; i++) {
			f.telemetry.record({
				code: "event_received",
				source: "github",
				id: `${secret}-${i}`,
				repo: secret,
				...{
					payload: secret,
					token: secret,
					header: secret,
					prompt: secret,
					stdout: secret,
					detail: secret,
					error: secret,
				},
			});
		}
		const repeated = {
			code: "relay_connection_error" as const,
			source: "system" as const,
		};
		f.telemetry.record(repeated);
		f.telemetry.record(repeated);
		const s = f.telemetry.snapshot();
		assert.equal(s.events.length, RECENT_EVENTS);
		assert.equal(s.events[0].count, 2);
		assert.equal(s.counters.event_received, RECENT_EVENTS + 12);
		assert.equal(s.last.error?.code, repeated.code);
		assert.ok(!JSON.stringify(s).includes(secret));
		const files = readdirSync(f.directory);
		assert.equal(files.length, 3);
		for (const name of files) {
			assert.ok(statSync(join(f.directory, name)).size <= 2048);
			assert.equal(statSync(join(f.directory, name)).mode & 0o777, 0o600);
			const text = readFileSync(join(f.directory, name), "utf8");
			assert.ok(!text.includes(secret));
			for (const line of text.trim().split("\n"))
				assert.ok(JSON.parse(line).code);
		}
	} finally {
		f.cleanup();
	}
});

test("a journal filesystem failure remains observable without stopping event receipt", {
	timeout: 2000,
}, () => {
	const f = fixture();
	try {
		const unavailablePath = join(f.directory, "unavailable");
		writeFileSync(unavailablePath, "not a directory");
		const telemetry = new Telemetry(
			new BoundedJournal(unavailablePath),
			[],
			() => f.health,
			() => [],
		);
		telemetry.record({
			code: "event_received",
			source: "github",
			id: randomUUID(),
		});
		assert.equal(telemetry.snapshot().journalAvailable, false);
		assert.equal(telemetry.snapshot().counters.event_received, 1);
	} finally {
		f.cleanup();
	}
});

test("writer migration preserves dedupe and unknown ages; observation uses a truly read-only connection", {
	timeout: 2000,
}, () => {
	const f = fixture();
	const path = join(f.directory, "inbox.sqlite");
	const old = new DatabaseSync(path);
	old.exec(
		"CREATE TABLE jobs(id TEXT PRIMARY KEY,repo TEXT NOT NULL,body TEXT NOT NULL,state TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',thread TEXT,updated INTEGER NOT NULL); CREATE TABLE module_jobs(id TEXT PRIMARY KEY,body TEXT NOT NULL,state TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',resource TEXT NOT NULL DEFAULT '')",
	);
	const signal: Signal = {
		id: randomUUID(),
		repo: f.repo,
		kind: "ci",
		resourceId: 1,
		sha: randomBytes(20).toString("hex"),
		branch: "feature",
		url: `https://github.com/${f.repo}/actions`,
	};
	old
		.prepare(
			"INSERT INTO jobs(id,repo,body,state,updated) VALUES(?,?,?,'deferred',?)",
		)
		.run(signal.id, signal.repo, JSON.stringify(signal), Date.now());
	old.close();
	const statusReader = new Store(path, true);
	try {
		new ModuleStore(statusReader.db, true).list();
		assert.equal(statusReader.list()[0].state, "deferred");
		assert.ok(
			!statusReader.db
				.prepare("PRAGMA table_info(jobs)")
				.all()
				.some((column) => column.name === "received"),
		);
	} finally {
		statusReader.close();
	}
	const writer = new Store(path);
	const modules = new ModuleStore(writer.db);
	try {
		assert.equal(writer.receive(signal), false);
		writer.receive({ ...signal, id: randomUUID() });
		modules.receive({
			kind: "module",
			id: `module:${randomBytes(32).toString("hex")}`,
			module: "sample",
			task: "sample",
			inputs: {},
		});
		const reader = new DatabaseSync(path, { readOnly: true });
		try {
			const version = reader.prepare("PRAGMA schema_version").get();
			const queue = readQueueSummary(reader);
			assert.equal(queue.find((q) => q.state === "deferred")?.unknownAge, 1);
			assert.ok(queue.find((q) => q.source === "module")?.oldestReceivedAt);
			assert.deepEqual(reader.prepare("PRAGMA schema_version").get(), version);
			assert.equal(
				writer.list().find((j) => j.id === signal.id)?.state,
				"deferred",
			);
		} finally {
			reader.close();
		}
		const unavailable = new Telemetry(
			new BoundedJournal(join(f.directory, "log")),
			[],
			() => f.health,
			() => {
				throw Error("private db error");
			},
		);
		assert.equal(unavailable.snapshot().queueAvailable, false);
	} finally {
		writer.close();
		f.cleanup();
	}
});

/** node:http preserves browser security headers; fetch rewrites Host and Sec-Fetch-Mode. */
async function httpStatus(
	url: string,
	headers: Record<string, string>,
): Promise<number | undefined> {
	return new Promise((resolve, reject) => {
		const request = get(url, { headers, timeout: 2000 }, (response) => {
			response.resume();
			resolve(response.statusCode);
		});
		request.on("error", reject);
		request.on("timeout", () => request.destroy(Error("HTTP deadline")));
	});
}

async function snapshotFrom(url: string) {
	const response = await fetch(`${url}/events`, {
		signal: AbortSignal.timeout(3000),
	});
	const reader = response.body?.getReader();
	assert.ok(reader);
	let data = "";
	try {
		while (!data.includes("\n\n")) {
			const part = await reader.read();
			assert.equal(part.done, false);
			data += Buffer.from(part.value ?? []).toString();
		}
		return JSON.parse(data.split("data: ")[1].split("\n\n")[0]);
	} finally {
		await reader.cancel();
	}
}

test("panel is loopback and GET-only; reconnect always receives a fresh safe snapshot", {
	timeout: 10000,
}, async () => {
	const f = fixture();
	const panel = await startPanel(f.telemetry, 0);
	try {
		assert.equal(new URL(panel.url).hostname, "127.0.0.1");
		const response = await fetch(panel.url);
		const html = await response.text();
		assert.equal(response.status, 200);
		assert.ok(html.includes('data-testid="panel-github"'));
		assert.ok(
			response.headers
				.get("content-security-policy")
				?.includes("frame-ancestors 'none'"),
		);
		assert.equal((await fetch(panel.url, { method: "POST" })).status, 405);
		assert.equal(
			await httpStatus(panel.url, { Host: "untrusted.example" }),
			403,
		);
		assert.equal(
			(
				await fetch(panel.url, {
					headers: { Origin: "https://untrusted.example" },
				})
			).status,
			403,
		);
		const navigation = {
			"Sec-Fetch-Site": "cross-site",
			"Sec-Fetch-Mode": "navigate",
			"Sec-Fetch-Dest": "document",
		};
		assert.equal(await httpStatus(panel.url, navigation), 200);
		assert.equal(await httpStatus(`${panel.url}/events`, navigation), 403);
		assert.equal((await fetch(`${panel.url}/retry`)).status, 404);
		assert.equal((await snapshotFrom(panel.url)).events.length, 0);
		f.health.github.stopped = true;
		f.telemetry.record({ code: "dispatcher_failed", source: "system" });
		const second = await snapshotFrom(panel.url);
		assert.equal(second.health.worker, "connected");
		assert.equal(second.health.github.stopped, true);
		assert.equal(second.events[0].code, "dispatcher_failed");
		assert.ok(
			!(await (await fetch(`${panel.url}/panel.js`)).text()).includes(
				"innerHTML",
			),
		);
	} finally {
		await panel.close();
		f.cleanup();
	}
});

class Element {
	textContent = "";
	value = "";
	dataset = {};
	children: Element[] = [];
	listeners = new Map<string, () => void>();
	replaceChildren() {
		this.children = [];
	}
	append(child: Element) {
		this.children.push(child);
	}
	addEventListener(event: string, cb: () => void) {
		this.listeners.set(event, cb);
	}
}

test("client renders true stopped health, filters groups, and labels stale data after disconnect", {
	timeout: 2000,
}, () => {
	const f = fixture();
	const nodes = new Map<string, Element>();
	const element = (id: string) => {
		if (!nodes.has(id)) nodes.set(id, new Element());
		return nodes.get(id) as Element;
	};
	const callbacks = new Map<string, (event: { data: string }) => void>();
	let error: () => void = () => {};
	class Source {
		addEventListener(
			type: string,
			callback: (event: { data: string }) => void,
		) {
			callbacks.set(type, callback);
		}
		set onerror(callback: () => void) {
			error = callback;
		}
		close() {}
	}
	try {
		element("severity").value = "all";
		runInNewContext(
			readFileSync(new URL("../src/panel-client.js", import.meta.url), "utf8"),
			{
				document: {
					getElementById: element,
					createElement: () => new Element(),
				},
				EventSource: Source,
				window: { addEventListener: () => {} },
				setInterval: () => 0,
				clearInterval: () => {},
				Date,
			},
		);
		f.health.github.stopped = true;
		f.telemetry.record({
			code: "job_state",
			source: "github",
			repo: f.repo,
			id: randomUUID(),
			state: "blocked",
		});
		f.telemetry.record({ code: "relay_connected", source: "system" });
		callbacks.get("snapshot")?.({
			data: JSON.stringify(f.telemetry.snapshot()),
		});
		assert.match(element("github").textContent, /STOPPED/);
		assert.match(element("worker").textContent, /connected/);
		assert.match(element("freshness").textContent, /Live local/);
		assert.equal(element("events").children.length, 2);
		element("severity").value = "blocked";
		element("severity").listeners.get("change")?.();
		assert.equal(element("events").children.length, 1);
		error();
		assert.match(element("freshness").textContent, /not current/);
		callbacks.get("snapshot")?.({
			data: JSON.stringify(f.telemetry.snapshot()),
		});
		assert.match(element("freshness").textContent, /Live local/);
	} finally {
		f.cleanup();
	}
});
