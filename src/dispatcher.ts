/** Serialize repository ownership decisions and refuse competing repairs. */

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import type { Config } from "./config.ts";
import type { Signal } from "./events.ts";
import { command, revalidate, taskPrompt } from "./github.ts";
import { PreparationCancelled, runRepair } from "./runner.ts";
import { forward, type Owner, type Sessions } from "./sessions.ts";
import type { Store } from "./store.ts";

export interface Actions {
	busy: (path: string) => Promise<boolean>;
	validate: (
		signal: Signal,
	) => Promise<{ actionable: boolean; reason: string }>;
	forward: (owner: Owner, message: string) => Promise<boolean>;
	repair: (
		signal: Signal,
		onSpawn: (child: ChildProcess) => void,
		beforeSpawn: () => Promise<boolean>,
	) => Promise<string>;
}
export class Dispatcher extends EventEmitter {
	private config: Config;
	private store: Store;
	private sessions: Sessions;
	private actions: Actions;
	private draining = false;
	private wakeAgain = false;
	private stopped = false;
	readonly running = new Map<
		string,
		{ id: string; child?: ChildProcess; cancelled?: boolean }
	>();
	constructor(
		config: Config,
		store: Store,
		sessions: Sessions,
		actions?: Actions,
	) {
		super();
		this.config = config;
		this.store = store;
		this.sessions = sessions;
		this.actions = actions ?? {
			busy: async (path) =>
				(
					await command(
						"git",
						["status", "--porcelain", "--untracked-files=normal"],
						path,
					)
				).trim().length > 0,
			validate: (signal) => revalidate(config, signal),
			forward: (owner, message) => forward(config, owner, message),
			repair: (signal, onSpawn, beforeSpawn) =>
				runRepair(config, signal, onSpawn, beforeSpawn),
		};
	}
	wake(): void {
		if (this.stopped) return;
		this.wakeAgain = true;
		if (!this.draining)
			void this.drain().catch((error) => this.emit("error", error));
	}
	async drain(): Promise<void> {
		if (this.stopped) return;
		if (this.draining) {
			this.wakeAgain = true;
			return;
		}
		this.draining = true;
		try {
			do {
				this.wakeAgain = false;
				for (const job of this.store.list(["queued", "deferred"])) {
					if (this.stopped) return;
					if (this.running.has(job.repo)) continue;
					if (
						this.store.list(["blocked"]).some((old) => old.repo === job.repo)
					) {
						this.store.set(
							job.id,
							"deferred",
							"Repository quarantined by an uncertain or blocked action; reconcile first",
						);
						continue;
					}
					const repository = this.config.repositories.find(
						(repo) => repo.repo === job.repo,
					);
					if (!repository) {
						this.store.set(job.id, "blocked", "Repository not configured");
						continue;
					}
					if (job.state === "queued") {
						try {
							const verdict = await this.actions.validate(job);
							if (!verdict.actionable) {
								this.store.set(job.id, "ignored", verdict.reason);
								continue;
							}
						} catch (error) {
							this.store.set(job.id, "blocked", String(error));
							continue;
						}
					}
					const owners = this.sessions.forRepo(job.repo);
					if (owners.length) {
						// Multiple or uncertain owners are never guessed. Keep the durable event pending.
						if (owners.length !== 1 || owners[0].uncertain) {
							this.store.set(
								job.id,
								"deferred",
								"Repository owned by multiple or uncertain sessions",
							);
							continue;
						}
						if (job.state === "deferred" && job.thread === owners[0].id)
							continue;
						this.store.set(
							job.id,
							"forwarding",
							"Routing to the existing owner",
							owners[0].id,
						);
						try {
							const sent = await this.actions.forward(
								owners[0],
								`An event arrived for the repository you already own. Integrate its triage into your current work only when appropriate; preserve the current task and checkout. Do not start a competing repair or follow the isolated-clone instructions below. ${taskPrompt(job)}`,
							);
							this.store.set(
								job.id,
								sent ? "forwarded" : "deferred",
								sent
									? "Delivered to the existing active turn"
									: "Owner active; shared control socket unavailable",
								owners[0].id,
							);
						} catch {
							this.store.set(
								job.id,
								"blocked",
								"Forwarding result uncertain; reconcile before retry",
								owners[0].id,
							);
						}
						continue;
					}
					if (!this.config.enabled) {
						this.store.set(job.id, "deferred", "Execution disabled");
						continue;
					}
					if (this.running.size >= this.config.maxParallel) continue;
					try {
						const path = realpathSync(repository.path);
						if (await this.actions.busy(path)) {
							this.store.set(
								job.id,
								"deferred",
								"Local checkout has uncommitted work",
							);
							continue;
						}
						const verdict = await this.actions.validate(job);
						if (!verdict.actionable) {
							this.store.set(job.id, "ignored", verdict.reason);
							continue;
						}
						// Recheck after network I/O: a human session may have started while GitHub was queried.
						if (
							this.sessions.forRepo(job.repo).length ||
							(await this.actions.busy(path))
						) {
							this.store.set(
								job.id,
								"deferred",
								"Repository became occupied during revalidation",
							);
							continue;
						}
						if (this.stopped) return;
						this.store.set(
							job.id,
							"running",
							"Repair started in isolated clone",
						);
						this.running.set(job.repo, { id: job.id });
						void this.actions
							.repair(
								job,
								(child) => {
									const current = this.running.get(job.repo);
									if (current) current.child = child;
									if (this.stopped || current?.cancelled) this.cancel(current);
								},
								async () => {
									const current = this.running.get(job.repo);
									if (this.stopped || current?.cancelled) return false;
									if (await this.actions.busy(path)) return false;
									this.sessions.refresh();
									return (
										!this.stopped &&
										!current?.cancelled &&
										!this.sessions.forRepo(job.repo).length
									);
								},
							)
							.then((report) => {
								if (!this.stopped) this.store.set(job.id, "completed", report);
							})
							.catch((error: Error) => {
								if (!this.stopped)
									this.store.set(
										job.id,
										error instanceof PreparationCancelled
											? "deferred"
											: "blocked",
										error.message,
									);
							})
							.finally(() => {
								this.running.delete(job.repo);
								if (!this.stopped) {
									this.emit("outcome", job.id);
									this.wake();
								}
							});
					} catch (error) {
						this.store.set(
							job.id,
							"blocked",
							error instanceof Error
								? error.message
								: "Repository revalidation failed",
						);
					}
				}
			} while (this.wakeAgain);
		} finally {
			this.draining = false;
		}
	}
	private cancel(
		job: { child?: ChildProcess; cancelled?: boolean } | undefined,
	): void {
		if (!job) return;
		job.cancelled = true;
		const child = job.child;
		if (!child?.pid) return;
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch {
			/* Already exited. */
		}
		const timer = setTimeout(() => {
			try {
				process.kill(-(child.pid as number), "SIGKILL");
			} catch {
				/* Already exited. */
			}
		}, 5000);
		timer.unref();
		child.once("close", () => clearTimeout(timer));
	}
	/** Cancel preparation too: ownership can change before a subprocess exists. */
	stopConflicts(): void {
		for (const [repo, job] of this.running) {
			if (this.sessions.forRepo(repo).length) this.cancel(job);
		}
		this.wake();
	}
	stop(): void {
		this.stopped = true;
		for (const job of this.running.values()) this.cancel(job);
	}
}
