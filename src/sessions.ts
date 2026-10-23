/** Observe Codex lifecycle logs with filesystem events; never poll GitHub or restart an active turn. */

import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	closeSync,
	existsSync,
	type FSWatcher,
	openSync,
	readSync,
	statSync,
	watch,
} from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.ts";

export type Owner = {
	id: string;
	repos: Set<string>;
	active: boolean;
	uncertain: boolean;
	cwd?: string;
	internal?: boolean;
};
export class Sessions extends EventEmitter {
	readonly owners = new Map<string, Owner>();
	private files = new Map<
		string,
		{ offset: number; remainder: string; owner: Owner }
	>();
	private watcher?: FSWatcher;
	private origins = new Map<string, string | null>();
	private config: Config;
	constructor(config: Config) {
		super();
		this.config = config;
	}

	start(): void {
		const root = join(this.config.codexHome, "sessions");
		if (!existsSync(root))
			throw new Error(
				"Codex session directory missing; cannot establish repository ownership",
			);
		// Watch before the initial snapshot so session changes during bootstrap are not lost.
		this.watcher = watch(root, { recursive: true }, (_event, file) => {
			if (file?.toString().endsWith(".jsonl"))
				this.ingest(join(root, file.toString()));
		});
		this.watcher.on("error", (error) => this.emit("unsafe", error));
		const database = join(this.config.codexHome, "state_5.sqlite");
		if (!existsSync(database))
			throw new Error(
				"Codex state database unavailable; refusing an incomplete ownership snapshot",
			);
		const db = new DatabaseSync(database, { readOnly: true });
		try {
			const rows = db
				.prepare(
					"SELECT rollout_path FROM threads WHERE archived=0 ORDER BY updated_at DESC",
				)
				.all() as {
				rollout_path: string;
			}[];
			for (const row of rows) this.ingest(row.rollout_path, true);
		} finally {
			db.close();
		}
	}

	/** Parse lifecycle fields only; user prompts, tool output and credentials are never logged. */
	ingest(file: string, initial = false): void {
		if (!existsSync(file)) return;
		const size = statSync(file).size;
		let state = this.files.get(file);
		if (!state) {
			const fd = openSync(file, "r");
			const head = Buffer.alloc(Math.min(size, 256 * 1024));
			readSync(fd, head, 0, head.length, 0);
			closeSync(fd);
			const line = head.toString().split("\n")[0];
			let meta: {
				id?: string;
				cwd?: string;
				runtime_workspace_roots?: string[];
			};
			try {
				meta = JSON.parse(line).payload;
			} catch {
				return;
			}
			if (!meta.id) return;
			const owner: Owner = {
				id: meta.id,
				repos: new Set(),
				active: false,
				uncertain: false,
				cwd: meta.cwd,
				internal: Boolean(
					meta.cwd?.startsWith(join(this.config.stateDir, "work") + sep),
				),
			};
			for (const path of [meta.cwd, ...(meta.runtime_workspace_roots ?? [])])
				if (path) this.addPath(owner, path);
			// A bounded tail avoids loading long conversations. Missing lifecycle evidence means busy/unknown.
			state = {
				offset: Math.max(0, size - 2 * 1024 * 1024),
				remainder: "",
				owner,
			};
			owner.uncertain = state.offset > 0;
			this.files.set(file, state);
			this.owners.set(owner.id, owner);
		}
		if (size < state.offset) {
			state.offset = 0;
			state.remainder = "";
			state.owner.uncertain = true;
		}
		const fd = openSync(file, "r");
		const bytes = Buffer.alloc(Math.min(size - state.offset, 4 * 1024 * 1024));
		readSync(fd, bytes, 0, bytes.length, state.offset);
		closeSync(fd);
		state.offset += bytes.length;
		const lines = (state.remainder + bytes.toString()).split("\n");
		state.remainder = lines.pop() ?? "";
		for (const line of lines) this.consume(state.owner, line);
		this.resolveWorktree(state.owner);
		if (!initial) this.emit("changed");
	}

	refresh(): void {
		for (const file of this.files.keys()) this.ingest(file, true);
	}

	private resolveWorktree(owner: Owner, path = owner.cwd): void {
		if (!owner.active || !path || owner.internal) return;
		if (this.origins.has(path)) {
			const repo = this.origins.get(path);
			if (repo) owner.repos.add(repo);
			return;
		}
		this.origins.set(path, null);
		try {
			const origin = execFileSync(
				"git",
				["-C", path, "remote", "get-url", "origin"],
				{
					encoding: "utf8",
					timeout: 1000,
					stdio: ["ignore", "pipe", "ignore"],
				},
			).trim();
			const match = origin.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
			if (
				match &&
				this.config.repositories.some((repo) => repo.repo === match[1])
			) {
				owner.repos.add(match[1]);
				this.origins.set(path, match[1]);
			}
		} catch {
			/* A non-repository session cannot establish a repository owner through Git. */
		}
	}

	private addPath(owner: Owner, path: string): void {
		if (!isAbsolute(path)) return;
		const absolute = resolve(path);
		for (const repository of this.config.repositories) {
			const root = resolve(repository.path);
			if (absolute === root || absolute.startsWith(root + sep))
				owner.repos.add(repository.repo);
		}
	}

	private consume(owner: Owner, line: string): void {
		let record: { type?: string; payload?: Record<string, unknown> };
		try {
			record = JSON.parse(line);
		} catch {
			return;
		}
		const payload = record.payload ?? {};
		if (record.type === "event_msg") {
			if (payload.type === "task_started") {
				owner.active = true;
				owner.uncertain = false;
			}
			if (
				["task_complete", "task_completed", "turn_aborted"].includes(
					String(payload.type),
				)
			) {
				owner.active = false;
				owner.uncertain = false;
			}
		}
		if (record.type === "turn_context" && typeof payload.cwd === "string") {
			owner.cwd = payload.cwd;
			this.addPath(owner, payload.cwd);
			this.resolveWorktree(owner, payload.cwd);
		}
		if (
			record.type === "response_item" &&
			["function_call", "custom_tool_call"].includes(String(payload.type))
		) {
			const input =
				payload.type === "custom_tool_call" ? payload.input : payload.arguments;
			if (typeof input !== "string") return;
			for (const repository of this.config.repositories)
				if (input.includes(repository.path)) owner.repos.add(repository.repo);
			try {
				const args = JSON.parse(input) as {
					workdir?: string;
					cwd?: string;
				};
				for (const path of [args.workdir, args.cwd])
					if (path) {
						this.addPath(owner, path);
						this.resolveWorktree(owner, path);
					}
			} catch {
				// Custom exec tools contain source instead of JSON. Only literal working directories count.
				for (const match of input.matchAll(
					/(?:workdir|cwd)\s*:\s*["'](\/[^"'\n]+)["']/g,
				)) {
					this.addPath(owner, match[1]);
					this.resolveWorktree(owner, match[1]);
				}
			}
		}
	}

	forRepo(repo: string): Owner[] {
		return [...this.owners.values()].flatMap((owner) => {
			if (owner.internal || !(owner.active || owner.uncertain)) return [];
			if (owner.repos.has(repo)) return [owner];
			// An active projectless turn has not established its scope yet. Never guess its target.
			return owner.repos.size === 0 ? [{ ...owner, uncertain: true }] : [];
		});
	}
	close(): void {
		this.watcher?.close();
	}
}

/** Send to a shared live app-server only; absence never falls back to concurrent exec resume. */
export async function forward(
	config: Config,
	owner: Owner,
	message: string,
): Promise<boolean> {
	const child = spawn(config.codexBin, ["app-server", "proxy"], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	const pending = new Map<
		number,
		{
			resolve: (result: Record<string, unknown>) => void;
			reject: (error: Error) => void;
		}
	>();
	let sequence = 0;
	const lines = createInterface({ input: child.stdout });
	const call = (method: string, params: unknown = {}) =>
		new Promise<Record<string, unknown>>((resolve, reject) => {
			const id = ++sequence;
			pending.set(id, { resolve, reject });
			child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
		});
	lines.on("line", (line) => {
		try {
			const response = JSON.parse(line);
			const waiter = pending.get(response.id);
			if (!waiter) return;
			pending.delete(response.id);
			if (response.error)
				waiter.reject(new Error("App-server rejected request"));
			else waiter.resolve(response.result);
		} catch {
			/* Non-protocol output cannot authorize a delivery. */
		}
	});
	child.on("error", () => {
		for (const waiter of pending.values())
			waiter.reject(new Error("App-server unavailable"));
	});
	child.on("exit", () => {
		for (const waiter of pending.values())
			waiter.reject(new Error("App-server disconnected"));
	});
	const timer = setTimeout(() => child.kill(), 5000);
	let steering = false;
	child.stdin.on("error", () => {
		for (const waiter of pending.values())
			waiter.reject(new Error("App-server input unavailable"));
	});
	try {
		await call("initialize", {
			clientInfo: { name: "codex_github_bridge", version: "0.1.0" },
		});
		child.stdin.write(
			`${JSON.stringify({ method: "initialized", params: {} })}\n`,
		);
		const result = await call("thread/read", {
			threadId: owner.id,
			includeTurns: false,
		});
		const thread = result.thread as {
			status: { type: string };
			turns?: { id: string; status: string }[];
		};
		if (thread.status.type !== "active") return false;
		const turns = await call("thread/turns/list", {
			threadId: owner.id,
			limit: 1,
			itemsView: "notLoaded",
		});
		const turn = (turns.data as { id: string; status: string }[])?.[0];
		if (turn?.status !== "inProgress") return false;
		steering = true;
		await call("turn/steer", {
			threadId: owner.id,
			expectedTurnId: turn.id,
			input: [{ type: "text", text: message }],
		});
		return true;
	} catch (error) {
		if (steering) throw error;
		return false;
	} finally {
		clearTimeout(timer);
		lines.close();
		child.kill();
	}
}
