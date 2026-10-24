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
	onChange?: (id: string, state: JobState, repo: string) => void;
	constructor(path: string, readOnly = false) {
		this.db = new DatabaseSync(path, { readOnly });
		if (readOnly) return;
		this.db.exec(
			"PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, repo TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', thread TEXT, updated INTEGER NOT NULL); CREATE UNIQUE INDEX IF NOT EXISTS one_runner_per_repo ON jobs(repo) WHERE state='running';",
		);
		// Add metadata only in the writer; historical first receipt times stay unknown.
		if (
			!this.db
				.prepare("PRAGMA table_info(jobs)")
				.all()
				.some((row) => row.name === "received")
		)
			this.db.exec("ALTER TABLE jobs ADD COLUMN received INTEGER");
		this.db.exec(
			"CREATE INDEX IF NOT EXISTS jobs_observation_state_receipt ON jobs(state,received)",
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
		const inserted =
			this.db
				.prepare(
					"INSERT OR IGNORE INTO jobs(id,repo,body,state,updated,received) VALUES(?,?,?,'queued',?,?)",
				)
				.run(
					signal.id,
					signal.repo,
					JSON.stringify(signal),
					Date.now(),
					Date.now(),
				).changes === 1;
		if (inserted) this.onChange?.(signal.id, "queued", signal.repo);
		return inserted;
	}
	set(
		id: string,
		state: JobState,
		detail = "",
		thread: string | null = null,
	): void {
		// Filesystem wakes can repeat a decision; only real changes advance history.
		const summary = detail.slice(0, 2000);
		const result = this.db
			.prepare(
				"UPDATE jobs SET state=?,detail=?,thread=?,updated=? WHERE id=? AND (state IS NOT ? OR detail IS NOT ? OR thread IS NOT ?)",
			)
			.run(state, summary, thread, Date.now(), id, state, summary, thread);
		if (!result.changes) return;
		const row = this.db.prepare("SELECT repo FROM jobs WHERE id=?").get(id);
		if (row) this.onChange?.(id, state, String(row.repo));
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
	/** Query quarantine without materializing private job bodies. */
	hasBlocked(repo: string): boolean {
		return (
			this.db
				.prepare("SELECT 1 FROM jobs WHERE repo=? AND state='blocked' LIMIT 1")
				.get(repo) !== undefined
		);
	}
	close(): void {
		this.db.close();
	}
}
