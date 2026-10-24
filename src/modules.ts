/** Declarative webhook contracts, byte-exact authentication and bounded event mapping. */
import { z } from "zod";

export const moduleIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const headerName = z.string().regex(/^[a-z0-9-]{1,100}$/);
const headerSource = z
	.object({
		from: z.literal("header"),
		name: headerName,
		field: z
			.string()
			.regex(/^[a-zA-Z0-9_-]+$/)
			.optional(),
	})
	.strict();
const bodySource = z
	.object({
		from: z.literal("body"),
		pointer: z
			.string()
			.max(500)
			.refine((value) => value === "" || value.startsWith("/")),
	})
	.strict();
const constantSource = z
	.object({
		from: z.literal("constant"),
		value: z.union([
			z.string().max(4096),
			z.number().finite(),
			z.boolean(),
			z.null(),
		]),
	})
	.strict();
export const valueSourceSchema = z.discriminatedUnion("from", [
	headerSource,
	bodySource,
	constantSource,
]);
export type ValueSource = z.infer<typeof valueSourceSchema>;
const signingPart = z.discriminatedUnion("from", [
	headerSource,
	z.object({ from: z.literal("raw-body") }).strict(),
	z.object({ from: z.literal("literal"), value: z.string().max(100) }).strict(),
]);
export const moduleSchema = z
	.object({
		id: moduleIdSchema,
		version: z.literal(1),
		enabled: z.boolean(),
		task: moduleIdSchema,
		signature: z
			.object({
				algorithm: z.enum(["SHA-256", "SHA-512"]),
				header: headerName,
				field: z
					.string()
					.regex(/^[a-zA-Z0-9_-]+$/)
					.optional(),
				prefix: z.string().max(100).default(""),
				encoding: z.enum(["hex", "base64"]),
				parts: z.array(signingPart).min(1).max(12),
				timestamp: z
					.object({
						source: headerSource,
						toleranceSeconds: z.number().int().min(1).max(86400),
					})
					.strict()
					.optional(),
			})
			.strict(),
		eventId: z.union([headerSource, bodySource]),
		filters: z
			.array(
				z
					.object({
						source: valueSourceSchema,
						equals: z.union([z.string(), z.number(), z.boolean(), z.null()]),
					})
					.strict(),
			)
			.max(32)
			.default([]),
		inputs: z
			.record(
				z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
				valueSourceSchema,
			)
			.refine((value) => Object.keys(value).length <= 64),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (
			value.signature.parts.filter((part) => part.from === "raw-body")
				.length !== 1
		)
			ctx.addIssue({ code: "custom", message: "Sign exactly one raw body" });
		const headerSources = [
			value.eventId,
			...Object.values(value.inputs),
			...value.filters.map((filter) => filter.source),
		].filter((source) => source.from === "header");
		for (const source of headerSources) {
			if (
				source.from === "header" &&
				!value.signature.parts.some(
					(part) =>
						part.from === "header" &&
						part.name === source.name &&
						part.field === source.field,
				)
			)
				ctx.addIssue({
					code: "custom",
					message: "Mapped headers and event IDs must be signed",
				});
		}
		const timestamp = value.signature.timestamp;
		if (
			timestamp &&
			!value.signature.parts.some(
				(part) =>
					part.from === "header" &&
					part.name === timestamp.source.name &&
					part.field === timestamp.source.field,
			)
		)
			ctx.addIssue({ code: "custom", message: "Timestamp must be signed" });
	});
export type WebhookModule = z.infer<typeof moduleSchema>;
export const moduleEventSchema = z
	.object({
		id: z.string().min(1).max(200),
		kind: z.literal("module"),
		module: moduleIdSchema,
		task: moduleIdSchema,
		inputs: z.record(z.string(), z.json()),
	})
	.strict();
export type ModuleEvent = z.infer<typeof moduleEventSchema>;

/** Read comma-separated signature components without evaluating provider-controlled expressions. */
export function headerValues(
	headers: Headers,
	name: string,
	field?: string,
): string[] {
	const value = headers.get(name);
	if (value === null) return [];
	if (!field) return [value];
	return value
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.startsWith(`${field}=`))
		.map((part) => part.slice(field.length + 1));
}
/** Resolve own JSON properties only; JSON Pointer escaping follows RFC 6901. */
export function extractValue(
	source: ValueSource,
	headers: Headers,
	body: unknown,
): unknown {
	if (source.from === "constant") return source.value;
	if (source.from === "header")
		return headerValues(headers, source.name, source.field)[0];
	let value = body;
	if (source.pointer === "") return value;
	for (const key of source.pointer
		.slice(1)
		.split("/")
		.map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))) {
		if (!value || typeof value !== "object" || !Object.hasOwn(value, key))
			return undefined;
		value = Reflect.get(value, key);
	}
	return value;
}
/** Verify the raw bytes, including any configured timestamp, before parsing JSON. */
export async function verifyModuleSignature(
	module: WebhookModule,
	headers: Headers,
	body: Uint8Array,
	secret: string,
	now = Date.now(),
): Promise<boolean> {
	const signature = module.signature;
	if (signature.timestamp) {
		const timestamps = headerValues(
			headers,
			signature.timestamp.source.name,
			signature.timestamp.source.field,
		);
		if (timestamps.length !== 1 || !/^\d{1,13}$/.test(timestamps[0]))
			return false;
		if (
			Math.abs(now / 1000 - Number(timestamps[0])) >
			signature.timestamp.toleranceSeconds
		)
			return false;
	}
	const encoder = new TextEncoder();
	const parts: Uint8Array[] = [];
	for (const part of signature.parts) {
		if (part.from === "raw-body") parts.push(body);
		else if (part.from === "literal") parts.push(encoder.encode(part.value));
		else {
			const values = headerValues(headers, part.name, part.field);
			if (values.length !== 1) return false;
			parts.push(encoder.encode(values[0]));
		}
	}
	const bytes = new Uint8Array(
		parts.reduce((length, part) => length + part.byteLength, 0),
	);
	let offset = 0;
	for (const part of parts) {
		bytes.set(part, offset);
		offset += part.byteLength;
	}
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: signature.algorithm },
		false,
		["verify"],
	);
	// A bounded set supports provider key rotation without unbounded verification work.
	const candidates = headerValues(headers, signature.header, signature.field);
	if (candidates.length > 8) return false;
	for (const candidate of candidates) {
		if (!candidate.startsWith(signature.prefix)) continue;
		const encoded = candidate.slice(signature.prefix.length);
		let decoded: Uint8Array;
		if (signature.encoding === "hex") {
			const length = signature.algorithm === "SHA-256" ? 64 : 128;
			if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(encoded)) continue;
			decoded = Uint8Array.from(encoded.match(/../g) ?? [], (value) =>
				Number.parseInt(value, 16),
			);
		} else {
			if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) continue;
			try {
				decoded = Uint8Array.from(atob(encoded), (value) =>
					value.charCodeAt(0),
				);
			} catch {
				continue;
			}
		}
		if (
			await crypto.subtle.verify(
				"HMAC",
				key,
				decoded as Uint8Array<ArrayBuffer>,
				bytes,
			)
		)
			return true;
	}
	return false;
}
/** Minimize and namespace a verified event before durable delivery. */
export async function mapModuleEvent(
	module: WebhookModule,
	headers: Headers,
	body: unknown,
): Promise<ModuleEvent | null> {
	if (
		module.filters.some(
			(filter) => extractValue(filter.source, headers, body) !== filter.equals,
		)
	)
		return null;
	const sourceId = extractValue(module.eventId, headers, body);
	if (
		(typeof sourceId !== "string" && typeof sourceId !== "number") ||
		String(sourceId).length === 0 ||
		String(sourceId).length > 1000
	)
		throw new Error("Invalid event ID");
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(String(sourceId)),
	);
	const hash = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	const inputs: Record<string, unknown> = Object.create(null);
	for (const [name, source] of Object.entries(module.inputs)) {
		const value = extractValue(source, headers, body);
		if (value === undefined) throw new Error("Missing mapped input");
		inputs[name] = value;
	}
	const event = moduleEventSchema.parse({
		id: `module:${module.id}:${hash}`,
		kind: "module",
		module: module.id,
		task: module.task,
		inputs,
	});
	// Leave transport headroom beneath the Mac's 16 KiB WebSocket frame bound.
	if (new TextEncoder().encode(JSON.stringify(event)).length > 8192)
		throw new Error("Mapped event too large");
	return event;
}
