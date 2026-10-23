/** Transactional local inbox and durable, inspectable job outcomes. */
import { DatabaseSync } from "node:sqlite";
import type { Signal } from "./events.ts";

export type JobState =
	| "queued"
	| "deferred"
	| "forwarding"
	| "forwarded"
	| "running"
	| "completed"
	| "ignored"
	| "blocked";
export type Job = Signal & {
	state: JobState;
	detail: string;
	thread: string | null;
};

export class Store {
	readonly db: DatabaseSync;
	constructor(path: string) {
		this.db = new DatabaseSync(path);
		this.db.exec(
			"PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, repo TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', thread TEXT, updated INTEGER NOT NULL); CREATE UNIQUE INDEX IF NOT EXISTS one_runner_per_repo ON jobs(repo) WHERE state='running';",
		);
	}
	recoverInterrupted(): void {
		// An interrupted external action is uncertain, never silently replayed after a restart.
		this.db
			.prepare(
				"UPDATE jobs SET state='blocked',detail='Process restarted during an external action; reconcile before retry' WHERE state IN ('running','forwarding')",
			)
			.run();
	}
	receive(signal: Signal): boolean {
		return (
			this.db
				.prepare(
					"INSERT OR IGNORE INTO jobs(id,repo,body,state,updated) VALUES(?,?,?,'queued',?)",
				)
				.run(signal.id, signal.repo, JSON.stringify(signal), Date.now())
				.changes === 1
		);
	}
	set(
		id: string,
		state: JobState,
		detail = "",
		thread: string | null = null,
	): void {
		this.db
			.prepare("UPDATE jobs SET state=?,detail=?,thread=?,updated=? WHERE id=?")
			.run(state, detail.slice(0, 2000), thread, Date.now(), id);
	}
	list(states?: JobState[]): Job[] {
		const rows = this.db
			.prepare("SELECT * FROM jobs ORDER BY updated,id")
			.all() as {
			body: string;
			state: JobState;
			detail: string;
			thread: string | null;
		}[];
		return rows
			.filter((row) => !states || states.includes(row.state))
			.map((row) => ({
				...(JSON.parse(row.body) as Signal),
				state: row.state,
				detail: row.detail,
				thread: row.thread,
			}));
	}
	close(): void {
		this.db.close();
	}
}
