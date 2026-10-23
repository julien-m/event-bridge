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
import { Sessions } from "./sessions.ts";
import { Store } from "./store.ts";

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
			console.error(JSON.stringify({ at: new Date().toISOString(), event })),
	});
	const log = (event: string, detail: unknown = {}) =>
		console.log(
			JSON.stringify({ at: new Date().toISOString(), event, detail }),
		);
	let stopping = false;
	let unsafe = false;
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
	sessions.on("changed", wake);
	sessions.on("unsafe", (error) => {
		unsafe = true;
		dispatcher.stop();
		moduleTasks?.stop();
		log("ownership_watch_failed", String(error));
	});
	dispatcher.on("error", (error) => {
		unsafe = true;
		dispatcher.stop();
		moduleTasks?.stop();
		log("dispatcher_failed", String(error));
	});
	dispatcher.on("outcome", (id) => {
		log("job_outcome", { id });
		moduleTasks?.wake();
	});
	sessions.start();
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
		watcher.on("error", (error) => {
			unsafe = true;
			dispatcher.stop();
			moduleTasks?.stop();
			log("repository_watch_failed", String(error));
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
			log("relay_connected");
			dispatcher.wake();
			moduleTasks?.wake();
		});
		socket.on("message", (bytes) => {
			try {
				const message = JSON.parse(bytes.toString());
				if (!message || typeof message !== "object" || Array.isArray(message))
					throw new Error("Invalid event envelope");
				if (typeof message.acknowledged === "string") return;
				if (message.kind === "module") {
					const event = moduleEventSchema.parse(message);
					const inserted = moduleStore.receive(event);
					socket?.send(JSON.stringify({ ack: event.id }));
					if (inserted && !unsafe) moduleTasks?.wake();
					return;
				}
				const signal = signalSchema.parse(message);
				if (!config.repositories.some((repo) => repo.repo === signal.repo))
					throw new Error("Repository outside local allowlist");
				// Acknowledge only after the local WAL has committed, including duplicate receipts.
				const inserted = store.receive(signal);
				socket?.send(JSON.stringify({ ack: signal.id }));
				if (inserted) {
					log("event_received", { id: signal.id, repo: signal.repo });
					if (!unsafe) dispatcher.wake();
				}
			} catch (error) {
				log("event_rejected", String(error));
				socket?.close(1008, "Invalid event");
			}
		});
		socket.on("error", (error) => log("relay_connection_error", error.message));
		socket.on("close", () => {
			if (stopping) return;
			// Reconnection after a transport failure is a one-shot backoff, never a GitHub scan.
			const delay = Math.min(60000, 1000 * 2 ** Math.min(failures++, 6));
			retry = setTimeout(connect, delay);
		});
	};
	connect();
	dispatcher.wake();
	moduleTasks.wake();
	log("started", { repositories: config.repositories.length });
	return () => {
		stopping = true;
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
