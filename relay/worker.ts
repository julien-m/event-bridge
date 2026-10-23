/** Authenticated webhook inbox with durable delivery over an outbound Mac WebSocket. */
import { DurableObject } from "cloudflare:workers";
import { normalizeEvent, verifySignature } from "../src/events";

interface Bindings extends RelayEnv {
	WEBHOOK_SECRET: string;
	CLIENT_TOKEN: string;
	ALLOWED_REPOS: string;
	REVIEW_AUTHORS: string;
}

export class Inbox extends DurableObject<Bindings> {
	constructor(ctx: DurableObjectState, env: Bindings) {
		super(ctx, env);
		ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, body TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0)",
		);
	}

	async fetch(request: Request): Promise<Response> {
		const path = new URL(request.url).pathname;
		if (path === "/connect") {
			if (request.headers.get("Upgrade") !== "websocket")
				return new Response("WebSocket required", { status: 426 });
			// A single installation owns this inbox; replacement never creates two consumers.
			for (const socket of this.ctx.getWebSockets())
				socket.close(1012, "Replaced by a new connection");
			const [client, server] = Object.values(new WebSocketPair());
			this.ctx.acceptWebSocket(server);
			server.serializeAttachment({ sent: [] });
			this.flush(server);
			return new Response(null, { status: 101, webSocket: client });
		}
		if (path === "/status") {
			const pending = this.ctx.storage.sql
				.exec<{ count: number }>(
					"SELECT COUNT(*) AS count FROM events WHERE acknowledged=0",
				)
				.one().count;
			return Response.json({
				pending,
				connected: this.ctx.getWebSockets().length > 0,
			});
		}
		const body = await request.text();
		const signal = JSON.parse(body) as { id: string };
		const pending = this.ctx.storage.sql
			.exec<{ count: number }>(
				"SELECT COUNT(*) AS count FROM events WHERE acknowledged=0",
			)
			.one().count;
		if (pending >= Number(this.env.MAX_PENDING))
			return new Response("Inbox full", { status: 503 });
		this.ctx.storage.sql.exec(
			"INSERT OR IGNORE INTO events(id,body) VALUES (?,?)",
			signal.id,
			body,
		);
		for (const socket of this.ctx.getWebSockets()) this.flush(socket);
		return Response.json({ accepted: true });
	}

	private flush(socket: WebSocket): void {
		// Bounded batches are replenished by acknowledgements; disconnected Macs retain their backlog.
		const events = this.ctx.storage.sql
			.exec<{ body: string }>(
				"SELECT body FROM events WHERE acknowledged=0 ORDER BY rowid LIMIT 50",
			)
			.toArray();
		const sent = new Set<string>(
			(socket.deserializeAttachment() as { sent: string[] }).sent,
		);
		for (const event of events) {
			const id = (JSON.parse(event.body) as { id: string }).id;
			if (sent.has(id)) continue;
			socket.send(event.body);
			sent.add(id);
		}
		socket.serializeAttachment({ sent: [...sent] });
	}

	webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
		if (typeof message !== "string" || message.length > 500) {
			socket.close(1008, "Invalid acknowledgement");
			return;
		}
		try {
			const ack = JSON.parse(message) as { ack?: unknown };
			if (typeof ack.ack !== "string") {
				socket.close(1008, "Invalid acknowledgement");
				return;
			}
			this.ctx.storage.sql.exec(
				"UPDATE events SET acknowledged=1 WHERE id=?",
				ack.ack,
			);
			const sent = (
				socket.deserializeAttachment() as { sent: string[] }
			).sent.filter((id) => id !== ack.ack);
			socket.serializeAttachment({ sent });
			socket.send(JSON.stringify({ acknowledged: ack.ack }));
			this.flush(socket);
		} catch {
			socket.close(1008, "Invalid acknowledgement");
		}
	}

	webSocketClose(socket: WebSocket, code: number): void {
		socket.close(code, "Connection closed");
	}
}

export default {
	async fetch(request: Request, env: Bindings): Promise<Response> {
		const path = new URL(request.url).pathname;
		const inbox = env.INBOX.getByName("installation");
		if (["/connect", "/status"].includes(path)) {
			const token = request.headers
				.get("Authorization")
				?.replace(/^Bearer /, "");
			if (!token || token.length !== env.CLIENT_TOKEN.length)
				return new Response("Unauthorized", { status: 401 });
			// HMAC verification gives a constant-time comparison without exposing a timing oracle.
			const key = await crypto.subtle.importKey(
				"raw",
				new TextEncoder().encode(env.CLIENT_TOKEN),
				{ name: "HMAC", hash: "SHA-256" },
				false,
				["sign", "verify"],
			);
			const signature = await crypto.subtle.sign(
				"HMAC",
				key,
				new TextEncoder().encode(token),
			);
			if (
				!(await crypto.subtle.verify(
					"HMAC",
					key,
					signature,
					new TextEncoder().encode(env.CLIENT_TOKEN),
				))
			)
				return new Response("Unauthorized", { status: 401 });
			return inbox.fetch(request);
		}
		if (path !== "/github" || request.method !== "POST")
			return new Response("Not found", { status: 404 });
		const chunks: Uint8Array[] = [];
		let size = 0;
		const reader = request.body?.getReader();
		if (!reader) return new Response("Missing body", { status: 400 });
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > Number(env.MAX_BODY_BYTES)) {
				await reader.cancel();
				return new Response("Too large", { status: 413 });
			}
			chunks.push(value);
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.length;
		}
		if (
			!(await verifySignature(
				bytes,
				request.headers.get("X-Hub-Signature-256"),
				env.WEBHOOK_SECRET,
			))
		)
			return new Response("Invalid signature", { status: 401 });
		if (request.headers.get("X-GitHub-Event") === "ping")
			return Response.json({ pong: true });
		try {
			const signal = normalizeEvent(
				request.headers.get("X-GitHub-Event") ?? "",
				JSON.parse(new TextDecoder().decode(bytes)),
				request.headers.get("X-GitHub-Delivery") ?? "",
				JSON.parse(env.ALLOWED_REPOS),
				JSON.parse(env.REVIEW_AUTHORS),
			);
			if (!signal) return Response.json({ ignored: true });
			return inbox.fetch(
				new Request("https://inbox/enqueue", {
					method: "POST",
					body: JSON.stringify(signal),
				}),
			);
		} catch {
			return new Response("Invalid event", { status: 400 });
		}
	},
} satisfies ExportedHandler<Bindings>;
