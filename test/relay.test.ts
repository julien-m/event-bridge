/** Exercise the actual Worker runtime, SQLite Durable Object and authenticated push protocol. */
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { test } from "vitest";

test("signed offline events survive disconnects, reject unauthorized clients and deduplicate replays", {
	timeout: 10000,
}, async () => {
	const secret = randomBytes(32).toString("hex");
	const token = randomBytes(32).toString("hex");
	const repo = `owner/repo-${randomUUID()}`;
	const runtime = new Miniflare(
		convertV4MiniflareOptions({
			workers: [
				{
					modules: true,
					scriptPath: resolve(".build/relay/worker.js"),
					compatibilityDate: "2026-10-23",
					compatibilityFlags: ["nodejs_compat"],
					durableObjects: { INBOX: { className: "Inbox", useSQLite: true } },
					bindings: {
						WEBHOOK_SECRET: secret,
						CLIENT_TOKEN: token,
						ALLOWED_REPOS: JSON.stringify([repo]),
						REVIEW_AUTHORS: JSON.stringify(["review-bot"]),
						MAX_PENDING: "100",
						MAX_BODY_BYTES: "1048576",
					},
				},
			],
		}),
	);
	try {
		const body = JSON.stringify({
			action: "completed",
			repository: { full_name: repo },
			workflow_run: {
				id: 1,
				run_attempt: 1,
				conclusion: "failure",
				head_sha: randomBytes(20).toString("hex"),
				head_branch: "test",
				html_url: `https://github.com/${repo}/actions/runs/1`,
			},
		});
		const headers = {
			"X-GitHub-Event": "workflow_run",
			"X-GitHub-Delivery": randomUUID(),
			"X-Hub-Signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
		};
		assert.equal(
			(
				await runtime.dispatchFetch("https://relay/github", {
					method: "POST",
					body,
				})
			).status,
			401,
		);
		assert.equal(
			(
				await runtime.dispatchFetch("https://relay/github", {
					method: "POST",
					body,
					headers,
				})
			).status,
			200,
		);
		assert.equal(
			(
				await runtime.dispatchFetch("https://relay/github", {
					method: "POST",
					body,
					headers,
				})
			).status,
			200,
		);
		assert.equal(
			(await runtime.dispatchFetch("https://relay/status")).status,
			401,
		);
		const auth = { Authorization: `Bearer ${token}` };
		assert.equal(
			(
				(await (
					await runtime.dispatchFetch("https://relay/status", { headers: auth })
				).json()) as { pending: number }
			).pending,
			1,
		);
		const upgrade = await runtime.dispatchFetch("https://relay/connect", {
			headers: { ...auth, Upgrade: "websocket" },
		});
		assert.equal(upgrade.status, 101);
		const socket = upgrade.webSocket;
		assert.ok(socket);
		socket.accept();
		const event = await new Promise<{ id: string }>((done) =>
			socket.addEventListener(
				"message",
				(message) => done(JSON.parse(String(message.data))),
				{ once: true },
			),
		);
		const confirmed = new Promise<void>((done) =>
			socket.addEventListener(
				"message",
				(message) => {
					if (JSON.parse(String(message.data)).acknowledged === event.id)
						done();
				},
				{ once: true },
			),
		);
		socket.send(JSON.stringify({ ack: event.id }));
		await confirmed;
		socket.close(1000);
		const status = (await (
			await runtime.dispatchFetch("https://relay/status", { headers: auth })
		).json()) as { pending: number };
		assert.equal(status.pending, 0);
		await runtime.dispatchFetch("https://relay/github", {
			method: "POST",
			body,
			headers,
		});
		assert.equal(
			(
				(await (
					await runtime.dispatchFetch("https://relay/status", { headers: auth })
				).json()) as { pending: number }
			).pending,
			0,
		);
	} finally {
		await runtime.dispose();
	}
});
