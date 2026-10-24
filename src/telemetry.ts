/** Minimized operational events, bounded local journals and read-only queue projections. */
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

// These bounds implement the approved local retention budget, independently of durable deduplication.
export const JOURNAL_BYTES = 10 * 1024 * 1024;
export const RECENT_EVENTS = 100;
const codes = z.enum([
	"started",
	"stopped",
	"panel_failed",
	"relay_connected",
	"relay_disconnected",
	"relay_connection_error",
	"event_received",
	"ack_sent",
	"ack_confirmed",
	"event_rejected",
	"job_state",
	"ownership_watch_failed",
	"repository_watch_failed",
	"tasks_watch_failed",
	"dispatcher_failed",
	"module_dispatcher_failed",
	"task_configuration_invalid",
]);
const states = z.enum([
	"queued",
	"deferred",
	"forwarding",
	"forwarded",
	"running",
	"completed",
	"ignored",
	"blocked",
]);
const source = z.enum(["github", "module", "system"]);
const recordSchema = z.object({
	code: codes,
	source,
	id: z.string().max(1024).optional(),
	repo: z.string().max(200).optional(),
	module: z
		.string()
		.regex(/^[a-z][a-z0-9-]{0,63}$/)
		.optional(),
	state: states.optional(),
});
export type Observation = z.infer<typeof recordSchema>;
export interface SafeEvent extends Omit<Observation, "id"> {
	id?: string;
	at: number;
	level: "info" | "error";
	count: number;
	firstAt: number;
}
export interface DispatcherHealth {
	stopped: boolean;
	draining: boolean;
	lastStartedAt: number | null;
	lastFinishedAt: number | null;
	running: number;
	configurationValid?: boolean | null;
	registered?: number;
	activeTasks?: number;
}
export interface RuntimeHealth {
	process: "running" | "stopping";
	enabled: boolean;
	worker: "connecting" | "connected" | "disconnected";
	ownership: "starting" | "watching" | "unsafe";
	ownershipCheckedAt: number | null;
	owners: number;
	github: DispatcherHealth;
	modules: DispatcherHealth;
}
export interface QueueSummary {
	source: "github" | "module";
	state: string;
	count: number;
	oldestReceivedAt: number | null;
	unknownAge: number;
}
export interface PanelSnapshot {
	at: number;
	startedAt: number;
	health: RuntimeHealth;
	queue: QueueSummary[];
	queueAvailable: boolean;
	journalAvailable: boolean;
	last: Partial<
		Record<
			| "received"
			| "ackSent"
			| "ackConfirmed"
			| "result"
			| "error"
			| "connection",
			SafeEvent
		>
	>;
	counters: Partial<Record<Observation["code"], number>>;
	events: SafeEvent[];
}

/** Own only three journal files; callers provide already minimized records. */
export class BoundedJournal {
	private readonly path: string;
	private readonly maxBytes: number;
	constructor(directory: string, maxBytes = JOURNAL_BYTES) {
		this.maxBytes = maxBytes;
		this.path = join(directory, "events.jsonl");
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 512)
			throw new Error("Invalid journal bound");
	}
	append(event: SafeEvent): void {
		// I/O happens inside Telemetry.record's failure boundary, never during daemon initialization.
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const line = `${JSON.stringify(event)}\n`;
		if (Buffer.byteLength(line) > this.maxBytes)
			throw new Error("Observation exceeds journal bound");
		if (
			existsSync(this.path) &&
			statSync(this.path).size + Buffer.byteLength(line) > this.maxBytes
		) {
			rmSync(`${this.path}.2`, { force: true });
			if (existsSync(`${this.path}.1`))
				renameSync(`${this.path}.1`, `${this.path}.2`);
			renameSync(this.path, `${this.path}.1`);
		}
		appendFileSync(this.path, line, { mode: 0o600 });
	}
}

/** Uses the daemon's existing writer connection; never opens or migrates a database. */
export function readQueueSummary(db: DatabaseSync): QueueSummary[] {
	return (["jobs", "module_jobs"] as const).flatMap((table) => {
		const rows = db
			.prepare(
				`SELECT state, COUNT(*) AS count, MIN(received) AS oldestReceivedAt, SUM(received IS NULL) AS unknownAge FROM ${table} GROUP BY state`,
			)
			.all();
		return rows
			.filter((row) => states.safeParse(row.state).success)
			.map((row) => ({
				source: table === "jobs" ? ("github" as const) : ("module" as const),
				state: String(row.state),
				count: Number(row.count),
				oldestReceivedAt:
					row.oldestReceivedAt === null ? null : Number(row.oldestReceivedAt),
				unknownAge: Number(row.unknownAge),
			}));
	});
}

/** Publish safe projections only. Observation failures never change execution or ACK decisions. */
export class Telemetry extends EventEmitter {
	private readonly startedAt: number;
	private events: SafeEvent[] = [];
	private counters: PanelSnapshot["counters"] = {};
	private last: PanelSnapshot["last"] = {};
	private journalAvailable = true;
	private readonly journal: BoundedJournal;
	private readonly repositories: readonly string[];
	private readonly health: () => RuntimeHealth;
	private readonly queue: () => QueueSummary[];
	private readonly now: () => number;
	constructor(
		journal: BoundedJournal,
		repositories: readonly string[],
		health: () => RuntimeHealth,
		queue: () => QueueSummary[],
		now: () => number = Date.now,
	) {
		super();
		this.journal = journal;
		this.repositories = repositories;
		this.health = health;
		this.queue = queue;
		this.now = now;
		this.startedAt = now();
	}
	record(input: Observation): void {
		// Construct a new allowlisted object; extra fields and all raw IDs are discarded.
		const parsed = recordSchema.safeParse(input);
		if (!parsed.success) return;
		const value = parsed.data;
		const at = this.now();
		const event: SafeEvent = {
			code: value.code,
			source: value.source,
			state: value.state,
			id:
				value.id === undefined
					? undefined
					: createHash("sha256").update(value.id).digest("hex").slice(0, 20),
			repo:
				value.repo && this.repositories.includes(value.repo)
					? value.repo
					: undefined,
			module: value.module,
			at,
			firstAt: at,
			count: 1,
			level:
				value.code.endsWith("failed") ||
				value.code.endsWith("error") ||
				value.code === "event_rejected" ||
				value.code === "task_configuration_invalid" ||
				value.state === "blocked"
					? "error"
					: "info",
		};
		this.counters[event.code] = (this.counters[event.code] ?? 0) + 1;
		const prior = this.events.at(-1);
		// Consecutive equivalent transitions are grouped in the panel, while journal entries stay precise.
		if (
			prior &&
			at - prior.at < 60000 &&
			["code", "source", "state", "id", "repo", "module"].every(
				(key) => Reflect.get(prior, key) === Reflect.get(event, key),
			)
		) {
			event.firstAt = prior.firstAt;
			event.count = prior.count + 1;
			this.events.pop();
		}
		this.events.push(event);
		if (this.events.length > RECENT_EVENTS) this.events.shift();
		if (event.code === "relay_connected") this.last.connection = event;
		if (event.code === "event_received") this.last.received = event;
		if (event.code === "ack_sent") this.last.ackSent = event;
		if (event.code === "ack_confirmed") this.last.ackConfirmed = event;
		if (
			event.code === "job_state" &&
			["completed", "forwarded", "ignored", "blocked"].includes(
				event.state ?? "",
			)
		)
			this.last.result = event;
		if (event.level === "error") this.last.error = event;
		try {
			this.journal.append({ ...event, count: 1, firstAt: at });
		} catch {
			this.journalAvailable = false; /* Surface a safe fault flag without leaking filesystem errors. */
		}
		this.changed();
	}
	changed(): void {
		this.emit("changed");
	}
	snapshot(): PanelSnapshot {
		let queue: QueueSummary[] = [];
		let queueAvailable = true;
		try {
			queue = this.queue();
		} catch {
			queueAvailable = false; /* Database failures must not become a false empty healthy queue. */
		}
		return {
			at: this.now(),
			startedAt: this.startedAt,
			health: this.health(),
			queue,
			queueAvailable,
			journalAvailable: this.journalAvailable,
			last: structuredClone(this.last),
			counters: { ...this.counters },
			events: this.events.map((event) => ({ ...event })).reverse(),
		};
	}
}
