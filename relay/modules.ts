/** Durable module administration and encrypted per-provider credentials. */

import { z } from "zod";
import {
	mapModuleEvent,
	moduleSchema,
	verifyModuleSignature,
} from "../src/modules";

export interface ModuleBindings {
	ADMIN_TOKEN?: string;
	INGRESS_TOKEN?: string;
	MODULE_SECRET_KEY?: string;
}
const updateSchema = z
	.object({
		module: moduleSchema,
		expectedRevision: z.number().int().nonnegative(),
		secret: z.string().min(16).max(4096).optional(),
	})
	.strict();
type ModuleRow = {
	id: string;
	revision: number;
	config: string;
	secret: string;
};

/** Read at most the configured bound, including requests without Content-Length. */
export async function readBounded(
	request: Request,
	limit: number,
): Promise<Uint8Array | null> {
	const reader = request.body?.getReader();
	if (!reader) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let length = 0;
	while (true) {
		const part = await reader.read();
		if (part.done) break;
		length += part.value.byteLength;
		if (length > limit) {
			await reader.cancel();
			return null;
		}
		chunks.push(part.value);
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}
/** Compare fixed bearer credentials using the Workers timing-safe primitive. */
export async function matchesSecret(
	actual: string | null,
	expected: string | undefined,
): Promise<boolean> {
	if (!actual || !expected) return false;
	const encoder = new TextEncoder();
	const left = encoder.encode(actual),
		right = encoder.encode(expected);
	if (left.byteLength !== right.byteLength) return false;
	const key = await crypto.subtle.importKey(
		"raw",
		right,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
	const signature = await crypto.subtle.sign("HMAC", key, left);
	return crypto.subtle.verify("HMAC", key, signature, right);
}

export class ModuleRegistry {
	constructor(
		private readonly storage: DurableObjectStorage,
		private readonly env: ModuleBindings,
	) {
		storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS modules(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, config TEXT NOT NULL, secret TEXT NOT NULL)",
		);
	}
	private key = async (): Promise<CryptoKey> => {
		const value = this.env.MODULE_SECRET_KEY;
		if (!value || !/^[a-f0-9]{64}$/.test(value))
			throw new Error("Module encryption unavailable");
		return crypto.subtle.importKey(
			"raw",
			Uint8Array.from(value.match(/../g) ?? [], (hex) =>
				Number.parseInt(hex, 16),
			),
			"AES-GCM",
			false,
			["encrypt", "decrypt"],
		);
	};
	private encrypt = async (id: string, secret: string): Promise<string> => {
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const encoder = new TextEncoder();
		const bytes = await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv, additionalData: encoder.encode(id) },
			await this.key(),
			encoder.encode(secret),
		);
		return JSON.stringify({
			iv: Array.from(iv),
			bytes: Array.from(new Uint8Array(bytes)),
		});
	};
	private decrypt = async (row: ModuleRow): Promise<string> => {
		const saved = JSON.parse(row.secret) as { iv: number[]; bytes: number[] };
		const bytes = await crypto.subtle.decrypt(
			{
				name: "AES-GCM",
				iv: Uint8Array.from(saved.iv),
				additionalData: new TextEncoder().encode(row.id),
			},
			await this.key(),
			Uint8Array.from(saved.bytes),
		);
		return new TextDecoder().decode(bytes);
	};
	private row = (id: string): ModuleRow | undefined =>
		this.storage.sql
			.exec<ModuleRow>("SELECT * FROM modules WHERE id=?", id)
			.toArray()[0];
	/** Admin responses never return provider secrets or ciphertext. */
	async administer(request: Request, maxBytes: number): Promise<Response> {
		if (!this.env.ADMIN_TOKEN || !this.env.MODULE_SECRET_KEY)
			return new Response("Module administration unavailable", { status: 503 });
		if (
			!(await matchesSecret(
				request.headers.get("X-Bridge-Admin"),
				this.env.ADMIN_TOKEN,
			))
		)
			return new Response("Unauthorized", { status: 401 });
		const path = new URL(request.url).pathname;
		if (path === "/admin/modules" && request.method === "GET") {
			const modules = this.storage.sql
				.exec<ModuleRow>("SELECT * FROM modules ORDER BY id LIMIT 128")
				.toArray()
				.map((row) => ({
					module: JSON.parse(row.config),
					revision: row.revision,
				}));
			return Response.json(
				{ modules },
				{ headers: { "Cache-Control": "no-store" } },
			);
		}
		if (path !== "/admin/modules" || request.method !== "PUT")
			return new Response("Not found", { status: 404 });
		const bytes = await readBounded(request, maxBytes);
		if (bytes === null) return new Response("Too large", { status: 413 });
		let update: z.infer<typeof updateSchema>;
		try {
			update = updateSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
		} catch {
			return new Response("Invalid module configuration", { status: 400 });
		}
		if (
			new TextEncoder().encode(JSON.stringify(update.module)).byteLength > 8192
		)
			return new Response("Module configuration too large", { status: 400 });
		const existing = this.row(update.module.id);
		if ((existing?.revision ?? 0) !== update.expectedRevision)
			return new Response("Revision conflict", { status: 409 });
		if (!existing && !update.secret)
			return new Response("Secret required", { status: 400 });
		if (
			!existing &&
			this.storage.sql
				.exec<{ count: number }>("SELECT COUNT(*) AS count FROM modules")
				.one().count >= 128
		)
			return new Response("Module registry full", { status: 409 });
		const encrypted = update.secret
			? await this.encrypt(update.module.id, update.secret)
			: existing?.secret;
		// Encryption yields: recheck revision synchronously with the commit to prevent lost updates.
		const committed = this.storage.transactionSync(() => {
			const current = this.row(update.module.id);
			if ((current?.revision ?? 0) !== update.expectedRevision) return false;
			if (
				!current &&
				this.storage.sql
					.exec<{ count: number }>("SELECT COUNT(*) AS count FROM modules")
					.one().count >= 128
			)
				return false;
			this.storage.sql.exec(
				"INSERT INTO modules(id,revision,config,secret) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,config=excluded.config,secret=excluded.secret",
				update.module.id,
				update.expectedRevision + 1,
				JSON.stringify(update.module),
				encrypted ?? "",
			);
			return true;
		});
		return committed
			? Response.json(
					{ module: update.module, revision: update.expectedRevision + 1 },
					{ headers: { "Cache-Control": "no-store" } },
				)
			: new Response("Revision conflict", { status: 409 });
	}
	/** Verify against a snapshot; reject a delivery if its module changes during verification. */
	async receive(
		request: Request,
		maxBytes: number,
	): Promise<
		| Response
		| { event: NonNullable<Awaited<ReturnType<typeof mapModuleEvent>>> }
	> {
		const id = new URL(request.url).pathname.slice("/webhooks/".length);
		const row = this.row(id);
		if (!row) return new Response("Not found", { status: 404 });
		const module = moduleSchema.parse(JSON.parse(row.config));
		if (!module.enabled)
			return new Response("Module disabled", { status: 410 });
		const bytes = await readBounded(request, maxBytes);
		if (bytes === null) return new Response("Too large", { status: 413 });
		if (
			!(await verifyModuleSignature(
				module,
				request.headers,
				bytes,
				await this.decrypt(row),
			))
		)
			return new Response("Invalid signature", { status: 401 });
		let event: Awaited<ReturnType<typeof mapModuleEvent>>;
		try {
			event = await mapModuleEvent(
				module,
				request.headers,
				JSON.parse(new TextDecoder().decode(bytes)),
			);
		} catch {
			return new Response("Invalid event", { status: 400 });
		}
		if (this.row(id)?.revision !== row.revision)
			return new Response("Module changed; retry delivery", { status: 409 });
		return event ? { event } : Response.json({ ignored: true });
	}
}
