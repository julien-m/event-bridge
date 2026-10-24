/** Verify provider-independent signatures, registry isolation and actual durable delivery. */
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { test } from "vitest";
import {
	mapModuleEvent,
	moduleSchema,
	verifyModuleSignature,
} from "../src/modules.ts";

const makeModule = () =>
	moduleSchema.parse({
		id: `source-${randomBytes(5).toString("hex")}`,
		version: 1,
		enabled: true,
		task: "record-event",
		signature: {
			algorithm: "SHA-256",
			header: "x-signature",
			encoding: "hex",
			prefix: "sha256=",
			parts: [{ from: "raw-body" }],
		},
		eventId: { from: "body", pointer: "/id" },
		inputs: { message: { from: "body", pointer: "/data/message" } },
	});

test("HMAC contracts verify raw bytes, signed timestamp fields and both encodings", {
	timeout: 2000,
}, async () => {
	const secret = randomBytes(32).toString("hex");
	const raw = new TextEncoder().encode(
		JSON.stringify({ id: randomUUID(), data: { message: randomUUID() } }),
	);
	for (const [algorithm, encoding] of [
		["SHA-256", "hex"],
		["SHA-512", "base64"],
	] as const) {
		const module = makeModule();
		module.signature.algorithm = algorithm;
		module.signature.encoding = encoding;
		module.signature.prefix = "";
		const timestamp = String(Math.floor(Date.now() / 1000));
		module.signature.timestamp = {
			source: { from: "header", name: "x-signature", field: "t" },
			toleranceSeconds: 60,
		};
		module.signature.field = "v1";
		module.signature.parts = [
			{ from: "header", name: "x-signature", field: "t" },
			{ from: "literal", value: "." },
			{ from: "raw-body" },
		];
		const signature = createHmac(
			algorithm.replace("-", "").toLowerCase(),
			secret,
		)
			.update(`${timestamp}.`)
			.update(raw)
			.digest(encoding);
		const headers = new Headers({
			"x-signature": `t=${timestamp},v1=${signature}`,
		});
		assert.equal(
			await verifyModuleSignature(module, headers, raw, secret),
			true,
		);
		assert.equal(
			await verifyModuleSignature(
				module,
				headers,
				new Uint8Array([...raw, 32]),
				secret,
			),
			false,
		);
		assert.equal(
			await verifyModuleSignature(
				module,
				headers,
				raw,
				secret,
				(Number(timestamp) + 61) * 1000,
			),
			false,
		);
		assert.equal(
			moduleSchema.safeParse({
				...module,
				signature: { ...module.signature, parts: [{ from: "raw-body" }] },
			}).success,
			false,
		);
	}
	const module = makeModule();
	assert.equal(
		moduleSchema.safeParse({
			...module,
			eventId: { from: "header", name: "x-event-id" },
		}).success,
		false,
	);
	assert.equal(
		moduleSchema.safeParse({
			...module,
			inputs: { destination: { from: "header", name: "x-target" } },
		}).success,
		false,
	);
	assert.equal(
		moduleSchema.safeParse({
			...module,
			filters: [
				{ source: { from: "header", name: "x-filter" }, equals: "allowed" },
			],
		}).success,
		false,
	);
	const data = JSON.parse(new TextDecoder().decode(raw));
	const event = await mapModuleEvent(module, new Headers(), data);
	assert.equal(event?.inputs.message, data.data.message);
	assert.equal(
		(await mapModuleEvent(module, new Headers(), data))?.id,
		event?.id,
	);
	module.filters = [
		{ source: { from: "body", pointer: "/absent" }, equals: "wanted" },
	];
	assert.equal(await mapModuleEvent(module, new Headers(), data), null);
});

test("module registration is authenticated, revisioned, secret-free on read and immediately effective", {
	timeout: 10000,
}, async () => {
	const client = randomBytes(32).toString("hex"),
		admin = randomBytes(32).toString("hex"),
		secret = randomBytes(32).toString("hex");
	const module = makeModule();
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
						CLIENT_TOKEN: client,
						ADMIN_TOKEN: admin,
						INGRESS_TOKEN: client,
						MODULE_SECRET_KEY: randomBytes(32).toString("hex"),
						WEBHOOK_SECRET: secret,
						ALLOWED_REPOS: "[]",
						REVIEW_AUTHORS: "[]",
						MAX_PENDING: "100",
						MAX_BODY_BYTES: "16384",
					},
				},
			],
		}),
	);
	const auth = { Authorization: `Bearer ${client}`, "X-Bridge-Admin": admin };
	const register = (expectedRevision: number, configuration = module) =>
		runtime.dispatchFetch("https://relay/admin/modules", {
			method: "PUT",
			headers: auth,
			body: JSON.stringify({ module: configuration, secret, expectedRevision }),
		});
	try {
		assert.equal(
			(
				await runtime.dispatchFetch("https://relay/admin/modules", {
					headers: { Authorization: `Bearer ${client}` },
				})
			).status,
			401,
		);
		assert.equal((await register(0)).status, 200);
		assert.equal((await register(0)).status, 409);
		const listed = await (
			await runtime.dispatchFetch("https://relay/admin/modules", {
				headers: auth,
			})
		).text();
		assert.equal(listed.includes(secret), false);
		assert.equal(listed.includes('"revision":1'), true);
		const raw = JSON.stringify({
			id: randomUUID(),
			data: { message: randomUUID() },
		});
		const headers = {
			"X-Bridge-Ingress": client,
			"x-signature": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`,
		};
		const ingress = `https://relay/webhooks/${module.id}`;
		assert.equal(
			(await runtime.dispatchFetch(ingress, { method: "POST", body: raw }))
				.status,
			401,
		);
		assert.equal(
			(
				await runtime.dispatchFetch(ingress, {
					method: "POST",
					body: raw,
					headers,
				})
			).status,
			200,
		);
		assert.equal(
			(
				await runtime.dispatchFetch(ingress, {
					method: "POST",
					body: raw,
					headers,
				})
			).status,
			200,
		);
		const status = (await (
			await runtime.dispatchFetch("https://relay/status", { headers: auth })
		).json()) as { pending: number };
		assert.equal(status.pending, 1);
		const upgraded = await runtime.dispatchFetch("https://relay/connect", {
			headers: { ...auth, Upgrade: "websocket" },
		});
		assert.equal(upgraded.status, 101);
		assert.ok(upgraded.webSocket);
		const socket = upgraded.webSocket;
		socket.accept();
		const received = await new Promise<{
			id: string;
			module: string;
			inputs: { message: string };
		}>((done) =>
			socket.addEventListener(
				"message",
				(event) => done(JSON.parse(String(event.data))),
				{ once: true },
			),
		);
		assert.equal(received.module, module.id);
		assert.equal(received.inputs.message, JSON.parse(raw).data.message);
		const ack = new Promise<void>((done) =>
			socket.addEventListener("message", () => done(), { once: true }),
		);
		socket.send(JSON.stringify({ ack: received.id }));
		await ack;
		socket.close(1000);
		assert.equal(
			(await register(1, { ...module, enabled: false })).status,
			200,
		);
		assert.equal(
			(
				await runtime.dispatchFetch(ingress, {
					method: "POST",
					body: raw,
					headers,
				})
			).status,
			410,
		);
	} finally {
		await runtime.dispose();
	}
});
