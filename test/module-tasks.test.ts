/** Check real local execution, task-file reload, idempotency and repository coordination. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import { configSchema } from "../src/config.ts";
import { ModuleStore, ModuleTasks } from "../src/module-tasks.ts";
import type { ModuleEvent } from "../src/modules.ts";

test("registered argv receives JSON stdin, reloads local task policy and defers occupied repositories", {
	timeout: 10000,
}, async () => {
	const root = mkdtempSync(join(tmpdir(), "bridge-task-"));
	const cwd = join(root, "repo");
	execFileSync("git", ["init", cwd], { stdio: "ignore" });
	const file = join(root, "tasks.json");
	const output = join(root, "received.json");
	const repo = `owner/${randomUUID()}`;
	const config = configSchema.parse({
		relayUrl: "https://relay.example.com",
		clientTokenEntry: "test/client/token",
		credsBin: "creds",
		codexBin: "codex",
		ghBin: "gh",
		stateDir: root,
		codexHome: root,
		repositories: [{ repo, path: cwd }],
		reviewAuthors: ["bot"],
		tasksFile: file,
	});
	const db = new DatabaseSync(":memory:");
	const store = new ModuleStore(db);
	let owner = 1,
		githubBusy = false;
	const tasks = new ModuleTasks(config, store, {
		owners: () => owner,
		githubBusy: () => githubBusy,
		githubCount: () => 0,
		checkoutBusy: async () => false,
		released: () => {},
	});
	const event: ModuleEvent = {
		id: `module:${randomUUID()}`,
		kind: "module",
		module: "source",
		task: "record",
		inputs: { message: `$(touch ${join(root, "injected")})` },
	};
	const task = {
		id: "record",
		module: "source",
		executable: process.execPath,
		args: [
			"-e",
			'let data="";process.stdin.on("data",chunk=>data+=chunk);process.stdin.on("end",()=>require("node:fs").writeFileSync(process.argv[1],data));',
			output,
		],
		cwd,
		repo,
		timeoutMs: 3000,
		enabled: true,
	};
	try {
		writeFileSync(file, JSON.stringify({ version: 1, tasks: [task] }));
		assert.equal(store.receive(event), true);
		assert.equal(store.receive(event), false);
		await tasks.drain();
		assert.equal(store.list()[0].state, "deferred");
		assert.equal(tasks.running.size, 0);
		owner = 0;
		githubBusy = true;
		await tasks.drain();
		assert.equal(tasks.running.size, 0);
		githubBusy = false;
		writeFileSync(
			file,
			JSON.stringify({ version: 1, tasks: [{ ...task, enabled: false }] }),
		);
		await tasks.drain();
		assert.equal(store.list()[0].detail, "Task execution disabled");
		writeFileSync(file, JSON.stringify({ version: 1, tasks: [task] }));
		await tasks.drain();
		const child = tasks.running.get(repo)?.child;
		assert.ok(child);
		await once(child, "close");
		assert.equal(store.list()[0].state, "completed");
		assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), event);
		writeFileSync(
			file,
			JSON.stringify({
				version: 1,
				tasks: [{ ...task, args: ["-e", "process.exit(7)"] }],
			}),
		);
		store.receive({ ...event, id: `module:${randomUUID()}` });
		await tasks.drain();
		const failed = tasks.running.get(repo)?.child;
		assert.ok(failed);
		await once(failed, "close");
		assert.equal(store.list()[1].state, "blocked");
		store.receive({ ...event, id: `module:${randomUUID()}` });
		await tasks.drain();
		assert.equal(tasks.running.size, 0);
		assert.equal(tasks.busy(repo), true);
	} finally {
		tasks.stop();
		db.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("shutdown quarantines an active task before closing its database and terminates its process group", {
	timeout: 10000,
}, async () => {
	const root = mkdtempSync(join(tmpdir(), "bridge-stop-"));
	const tasksFile = join(root, "tasks.json");
	const config = configSchema.parse({
		relayUrl: "https://relay.example.com",
		clientTokenEntry: "test/client/token",
		credsBin: "creds",
		codexBin: "codex",
		ghBin: "gh",
		stateDir: root,
		codexHome: root,
		repositories: [{ repo: "owner/repository", path: root }],
		reviewAuthors: ["bot"],
		tasksFile,
	});
	const task = {
		id: "shutdown",
		module: "source",
		executable: process.execPath,
		args: [
			"-e",
			'process.stdin.resume();process.stdin.on("end",()=>setInterval(()=>{},1000));',
		],
		cwd: root,
		timeoutMs: 5000,
		enabled: true,
	};
	writeFileSync(tasksFile, JSON.stringify({ version: 1, tasks: [task] }));
	const db = new DatabaseSync(":memory:");
	const store = new ModuleStore(db);
	const tasks = new ModuleTasks(config, store, {
		owners: () => 0,
		githubBusy: () => false,
		githubCount: () => 0,
		checkoutBusy: async () => false,
		released: () => {},
	});
	try {
		store.receive({
			id: `module:${randomUUID()}`,
			kind: "module",
			module: task.module,
			task: task.id,
			inputs: {},
		});
		await tasks.drain();
		const child = tasks.running.get(`task:${task.id}`)?.child;
		assert.ok(child?.pid);
		const closed = once(child, "close");
		tasks.stop();
		assert.equal(store.list()[0].state, "blocked");
		db.close();
		await closed;
		assert.equal(tasks.running.size, 0);
		const pid = child.pid;
		assert.ok(pid);
		assert.throws(() => process.kill(-pid, 0));
	} finally {
		tasks.stop();
		if (db.isOpen) db.close();
		rmSync(root, { recursive: true, force: true });
	}
});
