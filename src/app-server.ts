/** Deliver only to the existing shared Codex server; never load a competing session. */
import { statSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import WebSocket from "ws";
import type { Config } from "./config.ts";
import type { Owner } from "./sessions.ts";

export function controlSocketPath(config: Config): string {
	return (
		config.controlSocket ??
		join(config.codexHome, "app-server-control", "app-server-control.sock")
	);
}

/** False means no mutation was attempted; errors after sending require reconciliation. */
export async function forward(
	config: Config,
	owner: Owner,
	message: string,
	stillOwner: () => boolean = () => true,
): Promise<boolean> {
	const path = controlSocketPath(config);
	try {
		const socket = statSync(path);
		if (
			!socket.isSocket() ||
			socket.uid !== process.getuid?.() ||
			socket.mode & 0o077
		)
			return false;
	} catch {
		return false; /* Missing shared server cannot authorize a session resume. */
	}
	// The control socket carries WebSocket frames, not the stdio JSONL protocol.
	const socket = new WebSocket("ws://localhost/", {
		createConnection: () => connect(path),
		handshakeTimeout: 2000,
		maxPayload: 1024 * 1024,
	});
	let sequence = 0;
	let sending = false;
	const pending = new Map<
		number,
		{
			resolve: (result: Record<string, unknown>) => void;
			reject: (error: Error) => void;
		}
	>();
	const fail = () => {
		for (const entry of pending.values())
			entry.reject(new Error("Shared Codex control unavailable"));
		pending.clear();
	};
	socket.on("error", fail);
	socket.on("close", fail);
	socket.on("message", (bytes) => {
		try {
			const response = JSON.parse(bytes.toString());
			const entry = pending.get(response.id);
			if (!entry) return;
			pending.delete(response.id);
			if (
				response.error ||
				!response.result ||
				typeof response.result !== "object"
			)
				entry.reject(new Error("Shared Codex request rejected"));
			else entry.resolve(response.result);
		} catch {
			fail();
			socket.terminate();
		}
	});
	const timer = setTimeout(() => {
		fail();
		socket.terminate();
	}, 5000);
	const call = (
		method: string,
		params: unknown,
	): Promise<Record<string, unknown>> =>
		new Promise((resolve, reject) => {
			const id = ++sequence;
			pending.set(id, { resolve, reject });
			socket.send(JSON.stringify({ id, method, params }), (error) => {
				if (error) {
					pending.delete(id);
					reject(new Error("Shared Codex write failed"));
				}
			});
		});
	try {
		await new Promise<void>((resolve, reject) => {
			socket.once("open", resolve);
			socket.once("error", () =>
				reject(new Error("Shared Codex connection failed")),
			);
			socket.once("close", () =>
				reject(new Error("Shared Codex connection closed")),
			);
		});
		await call("initialize", {
			clientInfo: { name: "event_bridge", version: "0.1.0" },
		});
		socket.send(JSON.stringify({ method: "initialized", params: {} }));
		const result = await call("thread/read", {
			threadId: owner.id,
			includeTurns: false,
		});
		const thread = result.thread as { id: string; status: { type: string } };
		if (thread?.id !== owner.id || thread.status?.type !== "active")
			return false;
		const turns = await call("thread/turns/list", {
			threadId: owner.id,
			limit: 1,
			itemsView: "notLoaded",
		});
		const turn = (turns.data as { id: string; status: string }[])?.[0];
		if (turn?.status !== "inProgress" || !stillOwner()) return false;
		// From this point a lost response is uncertain, even if the server rejects.
		sending = true;
		await call("turn/steer", {
			threadId: owner.id,
			expectedTurnId: turn.id,
			input: [{ type: "text", text: message }],
		});
		return true;
	} catch {
		if (sending)
			throw new Error("Codex delivery uncertain; reconcile before retry");
		return false;
	} finally {
		clearTimeout(timer);
		socket.terminate();
	}
}
