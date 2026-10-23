/** Observable safety contracts for receipt, ownership, persistence and subscription execution. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { type Config, configSchema } from "../src/config.ts";
import { type Actions, Dispatcher } from "../src/dispatcher.ts";
import { normalizeEvent, type Signal, verifySignature } from "../src/events.ts";
import {
	chatgptEnvironment,
	codexArguments,
	PreparationCancelled,
} from "../src/runner.ts";
import { Sessions } from "../src/sessions.ts";
import { Store } from "../src/store.ts";

function setup() {
	const root = mkdtempSync(join(tmpdir(), "github-bridge-test-"));
	const repo = `owner/repo-${randomUUID()}`;
	const config: Config = configSchema.parse({
		relayUrl: "https://relay.example",
		clientTokenEntry: "test/dev/client",
		credsBin: process.execPath,
		codexBin: process.execPath,
		ghBin: process.execPath,
		stateDir: root,
		codexHome: root,
		repositories: [{ repo, path: root }],
		reviewAuthors: ["review-bot"],
	});
	const signal: Signal = {
		id: randomUUID(),
		repo,
		kind: "ci",
		resourceId: Math.floor(Math.random() * 100000) + 1,
		sha: randomBytes(20).toString("hex"),
		branch: "feature/check",
		url: `https://github.com/${repo}/actions`,
	};
	const store = new Store(join(root, "inbox.sqlite"));
	const sessions = new Sessions(config);
	const calls = { repair: 0, forward: 0 };
	const actions: Actions = {
		busy: async () => false,
		validate: async () => ({ actionable: true, reason: "current" }),
		forward: async () => {
			calls.forward++;
			return true;
		},
		repair: async () => {
			calls.repair++;
			return "verified";
		},
	};
	const cleanup = () => {
		sessions.close();
		store.close();
		rmSync(root, { recursive: true, force: true });
	};
	return {
		root,
		repo,
		config,
		signal,
		store,
		sessions,
		calls,
		actions,
		cleanup,
	};
}

test("only configured failed workflows and trusted review findings enter the inbox", {
	timeout: 2000,
}, () => {
	const f = setup();
	try {
		const payload = {
			action: "completed",
			repository: { full_name: f.repo },
			workflow_run: {
				id: f.signal.resourceId,
				run_attempt: 1,
				conclusion: "failure",
				head_sha: f.signal.sha,
				head_branch: f.signal.branch,
				html_url: f.signal.url,
			},
		};
		const normalized = normalizeEvent(
			"workflow_run",
			payload,
			randomUUID(),
			[f.repo],
			[],
		);
		assert.equal(normalized?.kind, "ci");
		assert.equal(
			normalizeEvent(
				"workflow_run",
				{
					...payload,
					workflow_run: { ...payload.workflow_run, conclusion: "success" },
				},
				randomUUID(),
				[f.repo],
				[],
			),
			null,
		);
		assert.equal(
			normalizeEvent("workflow_run", payload, randomUUID(), [], []),
			null,
		);
		const review = {
			action: "submitted",
			repository: { full_name: f.repo },
			pull_request: {
				number: 7,
				html_url: f.signal.url,
				head: { sha: f.signal.sha, ref: f.signal.branch },
			},
			review: {
				id: 8,
				body: "P2: confirmed issue",
				user: { login: f.config.reviewAuthors[0] },
			},
		};
		assert.equal(
			normalizeEvent(
				"pull_request_review",
				review,
				randomUUID(),
				[f.repo],
				f.config.reviewAuthors,
			)?.pull,
			review.pull_request.number,
		);
		assert.equal(
			normalizeEvent(
				"pull_request_review",
				review,
				randomUUID(),
				[f.repo],
				["other-bot"],
			),
			null,
		);
	} finally {
		f.cleanup();
	}
});

test("HMAC rejects missing, forged and altered payloads", {
	timeout: 2000,
}, async () => {
	const secret = randomBytes(32).toString("hex");
	const body = Buffer.from(JSON.stringify({ id: randomUUID() }));
	const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
	assert.equal(await verifySignature(body, signature, secret), true);
	assert.equal(await verifySignature(body, null, secret), false);
	assert.equal(
		await verifySignature(
			Buffer.concat([body, Buffer.from("x")]),
			signature,
			secret,
		),
		false,
	);
	assert.equal(await verifySignature(body, signature, randomUUID()), false);
});

test("replays remain deduplicated after reopening; status reads never alter running jobs", {
	timeout: 2000,
}, () => {
	const f = setup();
	try {
		assert.equal(f.store.receive(f.signal), true);
		f.store.set(f.signal.id, "running");
		const observer = new Store(join(f.root, "inbox.sqlite"));
		assert.equal(observer.list()[0].state, "running");
		assert.equal(observer.receive(f.signal), false);
		observer.close();
		f.store.recoverInterrupted();
		assert.equal(f.store.list()[0].state, "blocked");
	} finally {
		f.cleanup();
	}
});

test("active owner gets one message and no competing repair", {
	timeout: 2000,
}, async () => {
	const f = setup();
	try {
		f.store.receive(f.signal);
		const owner = {
			id: randomUUID(),
			repos: new Set([f.repo]),
			active: true,
			uncertain: false,
		};
		f.sessions.owners.set(owner.id, owner);
		const dispatcher = new Dispatcher(f.config, f.store, f.sessions, f.actions);
		await dispatcher.drain();
		await dispatcher.drain();
		assert.equal(f.calls.forward, 1);
		assert.equal(f.calls.repair, 0);
		assert.equal(f.store.list()[0].state, "forwarded");
	} finally {
		f.cleanup();
	}
});

test("unreachable owner is deferred without repeated forwarding or exec resume", {
	timeout: 2000,
}, async () => {
	const f = setup();
	try {
		f.store.receive(f.signal);
		const owner = {
			id: randomUUID(),
			repos: new Set([f.repo]),
			active: true,
			uncertain: false,
		};
		f.sessions.owners.set(owner.id, owner);
		f.actions.forward = async () => {
			f.calls.forward++;
			return false;
		};
		const dispatcher = new Dispatcher(f.config, f.store, f.sessions, f.actions);
		await dispatcher.drain();
		await dispatcher.drain();
		assert.equal(f.calls.forward, 1);
		assert.equal(f.calls.repair, 0);
		assert.equal(f.store.list()[0].state, "deferred");
		owner.active = false;
		await dispatcher.drain();
		await new Promise(setImmediate);
		assert.equal(f.calls.repair, 1);
	} finally {
		f.cleanup();
	}
});

test("ambiguous owners and dirty checkout both prevent repair", {
	timeout: 2000,
}, async () => {
	const f = setup();
	try {
		f.store.receive(f.signal);
		for (let index = 0; index < 3; index++) {
			const id = randomUUID();
			f.sessions.owners.set(id, {
				id,
				repos: new Set([f.repo]),
				active: true,
				uncertain: false,
			});
		}
		const dispatcher = new Dispatcher(f.config, f.store, f.sessions, f.actions);
		await dispatcher.drain();
		assert.equal(f.calls.repair, 0);
		assert.equal(f.calls.forward, 0);
		f.sessions.owners.clear();
		f.actions.busy = async () => true;
		await dispatcher.drain();
		assert.equal(f.calls.repair, 0);
		assert.match(f.store.list()[0].detail, /uncommitted/);
	} finally {
		f.cleanup();
	}
});

test("owner starting during GitHub validation prevents a new worker", {
	timeout: 2000,
}, async () => {
	const f = setup();
	try {
		f.store.receive(f.signal);
		let validations = 0;
		f.actions.validate = async () => {
			validations++;
			if (validations === 2) {
				const id = randomUUID();
				f.sessions.owners.set(id, {
					id,
					repos: new Set([f.repo]),
					active: true,
					uncertain: false,
				});
			}
			return { actionable: true, reason: "current" };
		};
		await new Dispatcher(f.config, f.store, f.sessions, f.actions).drain();
		assert.equal(f.calls.repair, 0);
		assert.equal(f.store.list()[0].state, "deferred");
	} finally {
		f.cleanup();
	}
});

test("superseded events and clean reviews never disturb their active owner", {
	timeout: 2000,
}, async () => {
	const f = setup();
	try {
		f.store.receive(f.signal);
		const id = randomUUID();
		f.sessions.owners.set(id, {
			id,
			repos: new Set([f.repo]),
			active: true,
			uncertain: false,
		});
		f.actions.validate = async () => ({
			actionable: false,
			reason: "superseded",
		});
		await new Dispatcher(f.config, f.store, f.sessions, f.actions).drain();
		assert.equal(f.calls.forward, 0);
		assert.equal(f.calls.repair, 0);
		assert.equal(f.store.list()[0].state, "ignored");
	} finally {
		f.cleanup();
	}
});

test("lifecycle log transitions release ownership without any periodic scan", {
	timeout: 2000,
}, () => {
	const f = setup();
	try {
		const id = randomUUID();
		const file = join(f.root, "session.jsonl");
		const lines = [
			{ type: "session_meta", payload: { id, cwd: f.root } },
			{ type: "event_msg", payload: { type: "task_started" } },
		];
		writeFileSync(
			file,
			`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
		);
		f.sessions.ingest(file);
		assert.equal(f.sessions.forRepo(f.repo).length, 1);
		writeFileSync(
			file,
			`${lines
				.concat({
					type: "event_msg",
					payload: { type: "task_complete" },
				} as (typeof lines)[1])
				.map((line) => JSON.stringify(line))
				.join("\n")}\n`,
		);
		f.sessions.ingest(file);
		assert.equal(f.sessions.forRepo(f.repo).length, 0);
	} finally {
		f.cleanup();
	}
});

test("subscription invocation strips API credentials and enforces ChatGPT auth", {
	timeout: 2000,
}, () => {
	const prior = process.env.OPENAI_API_KEY;
	process.env.OPENAI_API_KEY = randomUUID();
	try {
		assert.equal(chatgptEnvironment().OPENAI_API_KEY, undefined);
		assert.ok(
			codexArguments("report.txt").includes('forced_login_method="chatgpt"'),
		);
		assert.ok(codexArguments("report.txt").includes("workspace-write"));
	} finally {
		if (prior === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = prior;
	}
});

test("owner appearing during preparation cancels before process launch", {
	timeout: 2000,
}, async () => {
	const f = setup();
	try {
		f.store.receive(f.signal);
		let enter!: () => void;
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		let proceed!: () => void;
		const ready = new Promise<void>((resolve) => {
			proceed = resolve;
		});
		f.actions.repair = async (_signal, _spawn, beforeSpawn) => {
			enter();
			await ready;
			if (!(await beforeSpawn())) throw new PreparationCancelled();
			f.calls.repair++;
			return "unexpected";
		};
		const dispatcher = new Dispatcher(f.config, f.store, f.sessions, f.actions);
		await dispatcher.drain();
		await entered;
		const id = randomUUID();
		f.sessions.owners.set(id, {
			id,
			repos: new Set([f.repo]),
			active: true,
			uncertain: false,
		});
		dispatcher.stopConflicts();
		proceed();
		await new Promise(setImmediate);
		await new Promise(setImmediate);
		assert.equal(f.calls.repair, 0);
		assert.notEqual(f.store.list()[0].state, "completed");
	} finally {
		f.cleanup();
	}
});

test("interrupted or uncertain actions quarantine every new event for that repository", {
	timeout: 2000,
}, async () => {
	const f = setup();
	try {
		f.store.receive(f.signal);
		f.store.set(f.signal.id, "running");
		f.store.recoverInterrupted();
		const next = { ...f.signal, id: randomUUID() };
		f.store.receive(next);
		const dispatcher = new Dispatcher(f.config, f.store, f.sessions, f.actions);
		await dispatcher.drain();
		assert.equal(f.calls.repair, 0);
		assert.match(
			f.store.list().find((j) => j.id === next.id)?.detail ?? "",
			/quarantined/,
		);
	} finally {
		f.cleanup();
	}
});

test("projectless session moving into an external Git clone claims the configured repository", {
	timeout: 2000,
}, () => {
	const f = setup();
	const clone = mkdtempSync(join(tmpdir(), "bridge-worktree-test-"));
	try {
		execFileSync("git", ["init", clone], { stdio: "ignore" });
		execFileSync("git", [
			"-C",
			clone,
			"remote",
			"add",
			"origin",
			`https://github.com/${f.repo}.git`,
		]);
		const id = randomUUID();
		const file = join(f.root, "session.jsonl");
		writeFileSync(
			file,
			`${[
				{ type: "session_meta", payload: { id, cwd: tmpdir() } },
				{ type: "event_msg", payload: { type: "task_started" } },
			]
				.map((x) => JSON.stringify(x))
				.join("\n")}\n`,
		);
		f.sessions.ingest(file);
		assert.equal(f.sessions.forRepo(f.repo)[0]?.uncertain, true);
		appendFileSync(
			file,
			`${JSON.stringify({ type: "turn_context", payload: { cwd: clone } })}\n`,
		);
		f.sessions.ingest(file);
		assert.equal(f.sessions.forRepo(f.repo).length, 1);
	} finally {
		rmSync(clone, { recursive: true, force: true });
		f.cleanup();
	}
});

test("native custom exec working directories establish the existing owner", {
	timeout: 2000,
}, () => {
	const f = setup();
	try {
		const id = randomUUID();
		const file = join(f.root, "custom-session.jsonl");
		const records = [
			{ type: "session_meta", payload: { id, cwd: tmpdir() } },
			{ type: "event_msg", payload: { type: "task_started" } },
			{
				type: "response_item",
				payload: {
					type: "custom_tool_call",
					name: "exec",
					input: `await tools.exec_command({cmd:"git status",workdir:${JSON.stringify(f.root)}})`,
				},
			},
		];
		writeFileSync(
			file,
			`${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
		);
		f.sessions.ingest(file);
		assert.equal(f.sessions.forRepo(f.repo)[0]?.id, id);
		assert.equal(f.sessions.forRepo(f.repo)[0]?.uncertain, false);
	} finally {
		f.cleanup();
	}
});
