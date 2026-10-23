/** Persist module receipts and run only locally registered tasks under shared ownership guards. */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Config } from "./config.ts";
import {
	type ModuleEvent,
	moduleEventSchema,
	moduleIdSchema,
} from "./modules.ts";
import { chatgptEnvironment } from "./runner.ts";

export const tasksSchema = z
	.object({
		version: z.literal(1),
		tasks: z
			.array(
				z
					.object({
						id: moduleIdSchema,
						module: moduleIdSchema,
						executable: z.string().refine(isAbsolute),
						args: z.array(z.string().max(4096)).max(100).default([]),
						cwd: z.string().refine(isAbsolute),
						repo: z.string().optional(),
						timeoutMs: z.number().int().min(100).max(7200000),
						enabled: z.boolean(),
					})
					.strict(),
			)
			.max(128),
	})
	.strict()
	.refine(
		(value) =>
			new Set(value.tasks.map((task) => task.id)).size === value.tasks.length,
		"Duplicate task ID",
	);
export type LocalTask = z.infer<typeof tasksSchema>["tasks"][number];
type TaskState = "queued" | "deferred" | "running" | "completed" | "blocked";
export type ModuleJob = ModuleEvent & {
	state: TaskState;
	detail: string;
	resource: string;
};

export class ModuleStore {
	private readonly db: DatabaseSync;
	onChange?: (
		id: string,
		state: TaskState,
		module: string,
		resource: string,
	) => void;
	constructor(db: DatabaseSync, readOnly = false) {
		this.db = db;
		if (readOnly) return;
		db.exec(
			"CREATE TABLE IF NOT EXISTS module_jobs(id TEXT PRIMARY KEY,body TEXT NOT NULL,state TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',resource TEXT NOT NULL DEFAULT ''); CREATE UNIQUE INDEX IF NOT EXISTS one_module_task_per_resource ON module_jobs(resource) WHERE state='running'; CREATE INDEX IF NOT EXISTS module_jobs_resource_state ON module_jobs(resource,state)",
		);
		// The daemon writer owns additive migrations; old receipt times stay explicitly unknown.
		for (const column of ["received", "updated"])
			if (
				!db
					.prepare("PRAGMA table_info(module_jobs)")
					.all()
					.some((row) => row.name === column)
			)
				db.exec(`ALTER TABLE module_jobs ADD COLUMN ${column} INTEGER`);
		db.exec(
			"CREATE INDEX IF NOT EXISTS module_observation_state_receipt ON module_jobs(state,received)",
		);
	}
	receive(event: ModuleEvent): boolean {
		const inserted =
			this.db
				.prepare(
					"INSERT OR IGNORE INTO module_jobs(id,body,state,received,updated) VALUES(?,?,'queued',?,?)",
				)
				.run(event.id, JSON.stringify(event), Date.now(), Date.now())
				.changes === 1;
		if (inserted) this.onChange?.(event.id, "queued", event.module, "");
		return inserted;
	}
	hasBlocked(resource: string): boolean {
		return (
			this.db
				.prepare(
					"SELECT 1 FROM module_jobs WHERE resource=? AND state='blocked' LIMIT 1",
				)
				.get(resource) !== undefined
		);
	}
	list(pendingOnly = false): ModuleJob[] {
		return (
			this.db
				.prepare(
					pendingOnly
						? "SELECT * FROM module_jobs WHERE state IN ('queued','deferred') ORDER BY rowid LIMIT 10000"
						: "SELECT * FROM module_jobs ORDER BY rowid",
				)
				.all() as {
				body: string;
				state: TaskState;
				detail: string;
				resource: string;
			}[]
		).map((row) => ({
			...moduleEventSchema.parse(JSON.parse(row.body)),
			state: row.state,
			detail: row.detail,
			resource: row.resource,
		}));
	}
	set(id: string, state: TaskState, detail = "", resource = ""): void {
		this.db
			.prepare(
				"UPDATE module_jobs SET state=?,detail=?,resource=?,updated=? WHERE id=?",
			)
			.run(state, detail.slice(0, 2000), resource, Date.now(), id);
		const row = this.db
			.prepare(
				"SELECT json_extract(body,'$.module') AS module FROM module_jobs WHERE id=?",
			)
			.get(id);
		if (row) this.onChange?.(id, state, String(row.module), resource);
	}
	recover(): void {
		this.db
			.prepare(
				"UPDATE module_jobs SET state='blocked',detail='Interrupted external action; reconcile before explicit retry' WHERE state='running'; CREATE INDEX IF NOT EXISTS module_jobs_resource_state ON module_jobs(resource,state)",
			)
			.run();
	}
}
export interface TaskGuards {
	owners: (repo: string) => number;
	refreshOwners?: () => void;
	githubBusy: (repo: string) => boolean;
	githubCount: () => number;
	checkoutBusy: (path: string) => Promise<boolean>;
	released: () => void;
	failed?: (event: string) => void;
	changed?: () => void;
}
/** A process error is uncertain and never automatically retried. */
export class ModuleTasks {
	readonly running = new Map<
		string,
		{ child: ChildProcess; cancel: () => void }
	>();
	private stopped = false;
	private lastStartedAt: number | null = null;
	private lastFinishedAt: number | null = null;
	private configurationValid: boolean | null = null;
	private registered = 0;
	private activeTasks = 0;
	status() {
		return {
			stopped: this.stopped,
			draining: this.draining,
			lastStartedAt: this.lastStartedAt,
			lastFinishedAt: this.lastFinishedAt,
			running: this.running.size,
			configurationValid: this.configurationValid,
			registered: this.registered,
			activeTasks: this.activeTasks,
		};
	}
	private draining = false;
	private again = false;
	private readonly config: Config;
	readonly store: ModuleStore;
	private readonly guards: TaskGuards;
	constructor(config: Config, store: ModuleStore, guards: TaskGuards) {
		this.config = config;
		this.store = store;
		this.guards = guards;
	}
	private tasks = (): LocalTask[] =>
		this.config.tasksFile
			? tasksSchema.parse(
					JSON.parse(readFileSync(this.config.tasksFile, "utf8")),
				).tasks
			: [];
	busy = (repo: string): boolean =>
		this.running.has(repo) || this.store.hasBlocked(repo);
	wake = (): void => {
		if (this.stopped) return;
		this.again = true;
		if (!this.draining)
			void this.drain().catch(() => {
				this.guards.failed?.("module_dispatcher_failed");
				this.stop();
			});
	};
	/** Configuration is reread on every filesystem wake; no timer or daemon restart is needed. */
	async drain(): Promise<void> {
		if (this.draining || this.stopped) return;
		this.draining = true;
		this.lastStartedAt = Date.now();
		this.guards.changed?.();
		try {
			do {
				this.again = false;
				let tasks: LocalTask[];
				try {
					tasks = this.tasks();
					this.configurationValid = true;
					this.registered = tasks.length;
					this.activeTasks = tasks.filter((task) => task.enabled).length;
				} catch {
					this.configurationValid = false;
					this.guards.failed?.("task_configuration_invalid");
					return;
				}
				for (const job of this.store.list(true)) {
					if (this.stopped) return;
					const task = tasks.find(
						(task) => task.id === job.task && task.module === job.module,
					);
					if (!task) {
						this.store.set(job.id, "blocked", "Task is not registered locally");
						continue;
					}
					const resource = task.repo ?? `task:${task.id}`;
					if (this.busy(resource) || this.guards.githubBusy(resource)) continue;
					if (!task.enabled || !this.config.enabled) {
						this.store.set(
							job.id,
							"deferred",
							"Task execution disabled",
							resource,
						);
						continue;
					}
					if (
						this.running.size + this.guards.githubCount() >=
						this.config.maxParallel
					)
						continue;
					try {
						const cwd = realpathSync(task.cwd);
						const git = spawnSync("git", ["rev-parse", "--show-toplevel"], {
							cwd,
							encoding: "utf8",
							timeout: 3000,
						});
						const repository = task.repo
							? this.config.repositories.find((repo) => repo.repo === task.repo)
							: undefined;
						if (task.repo && !repository)
							throw new Error("Task repository is not configured");
						// A checkout cannot disguise itself as an unscoped generic task and escape owner coordination.
						if (
							git.status === 0 &&
							(!repository ||
								realpathSync(repository.path) !==
									realpathSync(git.stdout.trim()))
						)
							throw new Error(
								"Git working directory requires its configured repository scope",
							);
						if (
							repository &&
							(git.status !== 0 ||
								this.guards.owners(task.repo ?? "") > 0 ||
								(await this.guards.checkoutBusy(repository.path)))
						) {
							this.store.set(
								job.id,
								"deferred",
								"Repository occupied",
								resource,
							);
							continue;
						}
						if (
							this.stopped ||
							this.busy(resource) ||
							this.guards.githubBusy(resource) ||
							this.running.size + this.guards.githubCount() >=
								this.config.maxParallel
						)
							continue;
						this.guards.refreshOwners?.();
						if (repository && this.guards.owners(task.repo ?? "") > 0) {
							this.store.set(
								job.id,
								"deferred",
								"Repository became occupied",
								resource,
							);
							continue;
						}
						this.store.set(
							job.id,
							"running",
							"Local registered task started",
							resource,
						);
						this.start(
							task,
							{
								id: job.id,
								kind: job.kind,
								module: job.module,
								task: job.task,
								inputs: job.inputs,
							},
							resource,
							cwd,
						);
					} catch {
						this.store.set(
							job.id,
							"blocked",
							"Task preparation failed; check local configuration",
							resource,
						);
					}
				}
			} while (this.again);
		} finally {
			this.draining = false;
			this.lastFinishedAt = Date.now();
			this.guards.changed?.();
		}
	}
	private start(
		task: LocalTask,
		event: ModuleEvent,
		resource: string,
		cwd: string,
	): void {
		// The executable and argv are local policy. Webhook data travels only as JSON on stdin.
		const child = spawn(task.executable, task.args, {
			cwd,
			detached: true,
			env: chatgptEnvironment(),
			stdio: ["pipe", "ignore", "ignore"],
		});
		let finished = false;
		let cancelled = false;
		let escalation: NodeJS.Timeout | undefined;
		const kill = (signal: NodeJS.Signals) => {
			if (child.pid)
				try {
					process.kill(-child.pid, signal);
				} catch {
					/* The process group has already exited. */
				}
		};
		const cancel = () => {
			cancelled = true;
			kill("SIGTERM");
			if (!escalation) {
				escalation = setTimeout(() => kill("SIGKILL"), 5000);
				escalation.unref();
			}
		};
		this.running.set(resource, { child, cancel });
		const timer = setTimeout(cancel, task.timeoutMs);
		timer.unref();
		const finish = (success: boolean) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			clearTimeout(escalation);
			// Registered commands are finite tasks; surviving descendants must not outlive their receipt.
			kill("SIGKILL");
			this.running.delete(resource);
			if (!this.stopped)
				this.store.set(
					event.id,
					success && !cancelled ? "completed" : "blocked",
					success && !cancelled
						? "Registered task exited 0"
						: "Task failed, cancelled or uncertain; reconcile before retry",
					resource,
				);
			this.guards.released();
			this.wake();
		};
		child.once("error", () => finish(false));
		child.once("close", (code) => finish(code === 0));
		child.stdin?.on("error", () => cancel());
		child.stdin?.end(`${JSON.stringify(event)}\n`);
	}
	stopConflicts(): void {
		for (const [resource, entry] of this.running)
			if (this.guards.owners(resource) > 0) entry.cancel();
		this.wake();
	}
	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.guards.changed?.();
		for (const job of this.store.list())
			if (job.state === "running")
				this.store.set(
					job.id,
					"blocked",
					"Service stopped during external action; reconcile before retry",
					job.resource,
				);
		for (const entry of this.running.values()) {
			entry.cancel();
			// launchd shutdown exits immediately; do not leave descendants waiting for an in-process timer.
			if (entry.child.pid)
				try {
					process.kill(-entry.child.pid, "SIGKILL");
				} catch {
					/* Process group already exited. */
				}
		}
	}
}
