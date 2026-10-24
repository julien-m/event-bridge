/** Exercise the shared Unix WebSocket transport without opening real Codex threads. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createSocketServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import { WebSocketServer } from "ws";
import { forward } from "../src/app-server.ts";
import { configSchema } from "../src/config.ts";
import { Sessions } from "../src/sessions.ts";

test("shared control transport confirms steering, checks ownership, and quarantines lost receipts", {
	timeout: 10000,
}, async () => {
	const root = mkdtempSync(join(tmpdir(), "bridge-control-"));
	const path = join(root, "control.sock");
	const http = createServer();
	const server = new WebSocketServer({ server: http });
	const owner = {
		id: randomUUID(),
		repos: new Set<string>(),
		active: true,
		uncertain: false,
	};
	const turnId = randomUUID();
	let steers = 0;
	let loseReceipt = false;
	server.on("connection", (socket) =>
		socket.on("message", (bytes) => {
			const request = JSON.parse(bytes.toString());
			if (!request.id) return;
			let result: unknown = {};
			if (request.method === "thread/read")
				result = { thread: { id: owner.id, status: { type: "active" } } };
			if (request.method === "thread/turns/list")
				result = { data: [{ id: turnId, status: "inProgress" }] };
			if (request.method === "turn/steer") {
				assert.equal(request.params.threadId, owner.id);
				assert.equal(request.params.expectedTurnId, turnId);
				steers++;
				if (loseReceipt) {
					socket.terminate();
					return;
				}
			}
			socket.send(JSON.stringify({ id: request.id, result }));
		}),
	);
	try {
		await new Promise<void>((resolve) => http.listen(path, resolve));
		chmodSync(path, 0o600);
		const config = configSchema.parse({
			relayUrl: "https://relay.example",
			clientTokenEntry: "test/dev/token",
			credsBin: process.execPath,
			codexBin: process.execPath,
			ghBin: process.execPath,
			stateDir: root,
			codexHome: root,
			controlSocket: path,
			repositories: [{ repo: "owner/repo", path: root }],
			reviewAuthors: ["bot"],
		});
		assert.equal(
			await forward(config, owner, "Review finding", () => false),
			false,
		);
		assert.equal(steers, 0);
		assert.equal(await forward(config, owner, "Review finding"), true);
		assert.equal(steers, 1);
		loseReceipt = true;
		await assert.rejects(
			forward(config, owner, "Another finding"),
			/uncertain/,
		);
		assert.equal(steers, 2);
		assert.equal(
			await forward(
				{ ...config, controlSocket: join(root, "absent.sock") },
				owner,
				"No server",
			),
			false,
		);
		assert.equal(steers, 2);
	} finally {
		for (const socket of server.clients) socket.terminate();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await new Promise<void>((resolve) => http.close(() => resolve()));
		rmSync(root, { recursive: true, force: true });
	}
});

test("creating a missing control directory and real socket wakes unsent deliveries", {
	timeout: 10000,
}, async () => {
	const root = mkdtempSync(join(tmpdir(), "eb-watch-"));
	const directory = join(root, "ctl");
	const socketPath = join(directory, "s");
	mkdirSync(join(root, "sessions"));
	const db = new DatabaseSync(join(root, "state_5.sqlite"));
	db.exec(
		"CREATE TABLE threads(rollout_path TEXT, archived INTEGER, updated_at INTEGER)",
	);
	db.close();
	const config = configSchema.parse({
		relayUrl: "https://relay.example",
		clientTokenEntry: "test/dev/token",
		credsBin: process.execPath,
		codexBin: process.execPath,
		ghBin: process.execPath,
		stateDir: root,
		controlSocket: socketPath,
		codexHome: root,
		repositories: [{ repo: "owner/repo", path: root }],
		reviewAuthors: ["bot"],
	});
	const sessions = new Sessions(config);
	const server = createSocketServer();
	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(), 1000);
	try {
		sessions.start();
		const previous = sessions.transportVersion;
		const changed = once(sessions, "changed", { signal: deadline.signal });
		mkdirSync(directory);
		await Promise.all([
			changed,
			new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(socketPath, resolve);
			}),
		]);
		assert.ok(sessions.transportVersion > previous);
	} finally {
		clearTimeout(timer);
		sessions.close();
		if (server.listening)
			await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(root, { recursive: true, force: true });
	}
});
