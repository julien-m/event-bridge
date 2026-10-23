/** Maintain push delivery, native filesystem subscriptions and a single local dispatcher. */
import { type FSWatcher, mkdirSync, watch } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";
import type { Config } from "./config.ts";
import { readSecret } from "./config.ts";
import { Dispatcher } from "./dispatcher.ts";
import { signalSchema } from "./events.ts";
import { command } from "./github.ts";
import { ModuleStore, ModuleTasks } from "./module-tasks.ts";
import { moduleEventSchema } from "./modules.ts";
import { startPanel } from "./panel.ts";
import { Sessions } from "./sessions.ts";
import { Store } from "./store.ts";
import {
	BoundedJournal,
	type Observation,
	readQueueSummary,
	Telemetry,
} from "./telemetry.ts";

export function startDaemon(config: Config): () => void {
	process.umask(0o077);
	mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
	// SQLite owns the process lock; the OS releases it on crashes without stale PID heuristics.
	const lock = new DatabaseSync(join(config.stateDir, "daemon-lock.sqlite"));
	lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
	const store = new Store(join(config.stateDir, "inbox.sqlite"));
	store.recoverInterrupted();
	const sessions = new Sessions(config);
	const moduleStore = new ModuleStore(store.db);
	moduleStore.recover();
	let moduleTasks: ModuleTasks | undefined;
	const dispatcher = new Dispatcher(
		config,
		store,
		sessions,
		undefined,
		(repo) => moduleTasks?.busy(repo) ?? false,
		() => moduleTasks?.running.size ?? 0,
	);
	moduleTasks = new ModuleTasks(config, moduleStore, {
		owners: (repo) => sessions.forRepo(repo).length,
		refreshOwners: () => sessions.refresh(),
		githubBusy: (repo) =>
			dispatcher.running.has(repo) || store.hasBlocked(repo),
		githubCount: () => dispatcher.running.size,
		checkoutBusy: async (path) =>
			(
				await command(
					"git",
					["status", "--porcelain", "--untracked-files=normal"],
					path,
				)
			).trim().length > 0,
		released: () => dispatcher.wake(),
		failed: (event) =>
			log(
				event === "task_configuration_invalid"
					? event
					: "module_dispatcher_failed",
			),
		changed: () => telemetry.changed(),
	});
	const currentModuleTasks = moduleTasks;
	let stopping = false;
	let unsafe = false;
	let ownershipUnsafe = false;
	let worker: "connecting" | "connected" | "disconnected" = "connecting";
	let ownershipCheckedAt: number | null = null;
	const telemetry = new Telemetry(
		new BoundedJournal(join(config.stateDir, "logs")),
		config.repositories.map((repo) => repo.repo),
		() => ({
			process: stopping ? "stopping" : "running",
			enabled: config.enabled,
			worker,
			ownership: ownershipUnsafe
				? "unsafe"
				: ownershipCheckedAt === null
					? "starting"
					: "watching",
			ownershipCheckedAt,
			owners: [...sessions.owners.values()].filter(
				(owner) => !owner.internal && (owner.active || owner.uncertain),
			).length,
			github: dispatcher.status(),
			modules: currentModuleTasks.status(),
		}),
		() => readQueueSummary(store.db),
	);
	const log = (code: Observation["code"], detail: Partial<Observation> = {}) =>
		telemetry.record({ ...detail, code, source: detail.source ?? "system" });
	store.onChange = (id, state, repo) =>
		log("job_state", { source: "github", id, state, repo });
	moduleStore.onChange = (id, state, module, repo) =>
		log("job_state", { source: "module", id, state, module, repo });
	dispatcher.on("status", () => telemetry.changed());
	let panel: Awaited<ReturnType<typeof startPanel>> | undefined;
	if (config.observability) {
		void startPanel(telemetry, config.observability.port)
			.then((started) => {
				if (stopping) void started.close();
				else panel = started;
			})
			.catch(() => log("panel_failed"));
	}
	let socket: WebSocket | undefined;
	let retry: NodeJS.Timeout | undefined;
	let debounce: NodeJS.Timeout | undefined;
	let failures = 0;
	const watchers: FSWatcher[] = [];
	const wake = () => {
		clearTimeout(debounce);
		debounce = setTimeout(() => {
			if (!unsafe) {
				dispatcher.stopConflicts();
				moduleTasks?.stopConflicts();
			}
		}, 250);
	};
	sessions.on("changed", () => {
		ownershipCheckedAt = Date.now();
		telemetry.changed();
		wake();
	});
	sessions.on("unsafe", () => {
		unsafe = true;
		ownershipUnsafe = true;
		dispatcher.stop();
		moduleTasks?.stop();
		log("ownership_watch_failed");
	});
	dispatcher.on("error", () => {
		unsafe = true;
		dispatcher.stop();
		moduleTasks?.stop();
		log("dispatcher_failed");
	});
	dispatcher.on("outcome", () => {
		moduleTasks?.wake();
	});
	sessions.start();
	ownershipCheckedAt = Date.now();
	telemetry.changed();
	for (const repository of config.repositories) {
		const watcher = watch(
			repository.path,
			{ recursive: true },
			(_event, file) => {
				// Build output is irrelevant; source and Git lifecycle changes wake deferred work once.
				if (
					file
						?.toString()
						.split(/[\\/]/)
						.some((part) =>
							["node_modules", "target", "dist", ".cache"].includes(part),
						)
				)
					return;
				wake();
			},
		);
		watcher.on("error", () => {
			unsafe = true;
			ownershipUnsafe = true;
			dispatcher.stop();
			moduleTasks?.stop();
			log("repository_watch_failed");
		});
		watchers.push(watcher);
	}
	if (config.tasksFile) {
		const file = basename(config.tasksFile);
		const watcher = watch(dirname(config.tasksFile), (_event, changed) => {
			if (!changed || changed.toString() === file) wake();
		});
		watcher.on("error", () => {
			moduleTasks?.stop();
			log("tasks_watch_failed");
		});
		watchers.push(watcher);
	}
	const connect = () => {
		if (stopping) return;
		worker = "connecting";
		telemetry.changed();
		const url = new URL("/connect", config.relayUrl);
		url.protocol = "wss:";
		socket = new WebSocket(url, {
			headers: {
				Authorization: `Bearer ${readSecret(config, config.clientTokenEntry)}`,
			},
			handshakeTimeout: 10000,
			maxPayload: 16384,
		});
		socket.on("open", () => {
			failures = 0;
			worker = "connected";
			log("relay_connected");
			dispatcher.wake();
			moduleTasks?.wake();
		});
		socket.on("message", (bytes) => {
			try {
				const message = JSON.parse(bytes.toString());
				if (!message || typeof message !== "object" || Array.isArray(message))
					throw new Error("Invalid event envelope");
				if (typeof message.acknowledged === "string") {
					log("ack_confirmed", { id: message.acknowledged });
					return;
				}
				if (message.kind === "module") {
					const event = moduleEventSchema.parse(message);
					const inserted = moduleStore.receive(event);
					log("event_received", {
						source: "module",
						id: event.id,
						module: event.module,
					});
					socket?.send(JSON.stringify({ ack: event.id }), (error) => {
						if (!error)
							log("ack_sent", {
								source: "module",
								id: event.id,
								module: event.module,
							});
						else log("relay_connection_error");
					});
					if (inserted && !unsafe) moduleTasks?.wake();
					return;
				}
				const signal = signalSchema.parse(message);
				if (!config.repositories.some((repo) => repo.repo === signal.repo))
					throw new Error("Repository outside local allowlist");
				// Acknowledge only after the local WAL has committed, including duplicate receipts.
				const inserted = store.receive(signal);
				log("event_received", {
					source: "github",
					id: signal.id,
					repo: signal.repo,
				});
				socket?.send(JSON.stringify({ ack: signal.id }), (error) => {
					if (!error)
						log("ack_sent", {
							source: "github",
							id: signal.id,
							repo: signal.repo,
						});
					else log("relay_connection_error");
				});
				if (inserted) {
					if (!unsafe) dispatcher.wake();
				}
			} catch {
				log("event_rejected");
				socket?.close(1008, "Invalid event");
			}
		});
		socket.on("error", () => log("relay_connection_error"));
		socket.on("close", () => {
			worker = "disconnected";
			log("relay_disconnected");
			if (stopping) return;
			// Reconnection after a transport failure is a one-shot backoff, never a GitHub scan.
			const delay = Math.min(60000, 1000 * 2 ** Math.min(failures++, 6));
			retry = setTimeout(connect, delay);
		});
	};
	connect();
	dispatcher.wake();
	moduleTasks.wake();
	log("started");
	return () => {
		stopping = true;
		log("stopped");
		void panel?.close().catch(() => log("panel_failed"));
		clearTimeout(retry);
		clearTimeout(debounce);
		socket?.close();
		dispatcher.stop();
		moduleTasks?.stop();
		sessions.close();
		for (const watcher of watchers) watcher.close();
		store.close();
		lock.close();
	};
}
