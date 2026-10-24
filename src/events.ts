/** Validate and minimize GitHub signals before they enter either durable queue. */
import { z } from "zod";

export const repoName = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
export const signalSchema = z.object({
	id: z.string().min(1).max(200),
	repo: repoName,
	kind: z.enum(["review", "ci"]),
	resourceId: z.number().int().positive(),
	pull: z.number().int().positive().optional(),
	sha: z.string().regex(/^[0-9a-f]{40}$/),
	branch: z.string().min(1).max(255),
	url: z.string().url(),
});
export type Signal = z.infer<typeof signalSchema>;
const obj = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

/** Select actionable event types without persisting review text or workflow logs. */
export function normalizeEvent(
	event: string,
	payload: unknown,
	_delivery: string,
	allowedRepos: string[],
	reviewAuthors: string[],
): Signal | null {
	const data = obj(payload);
	const repository = obj(data.repository);
	const repo = repository.full_name;
	if (typeof repo !== "string" || !allowedRepos.includes(repo)) return null;
	if (event === "workflow_run") {
		const run = obj(data.workflow_run);
		if (data.action !== "completed" || run.conclusion !== "failure")
			return null;
		return signalSchema.parse({
			id: `ci:${repo}:${run.id}:${run.run_attempt}`,
			repo,
			kind: "ci",
			resourceId: run.id,
			sha: run.head_sha,
			branch: run.head_branch,
			url: run.html_url,
		});
	}
	const review = obj(data.review);
	const comment = obj(data.comment);
	const pr = obj(data.pull_request);
	const source = event === "pull_request_review" ? review : comment;
	if (!reviewAuthors.includes(String(obj(source.user).login))) return null;
	if (
		event === "pull_request_review" &&
		(data.action !== "submitted" ||
			!/codex-code-review-finding|\bP[0-3]\b/.test(String(source.body)))
	)
		return null;
	if (event === "pull_request_review_comment" && data.action !== "created")
		return null;
	if (!["pull_request_review", "pull_request_review_comment"].includes(event))
		return null;
	// Review submissions need a scoped API read: findings are usually separate inline comments.
	if (
		event.endsWith("_comment") &&
		!/codex-code-review-finding|\bP[0-3]\b/.test(String(source.body))
	)
		return null;
	const head = obj(pr.head);
	return signalSchema.parse({
		id: `review:${repo}:${event.endsWith("_comment") ? source.pull_request_review_id : source.id}:${head.sha}`,
		repo,
		kind: "review",
		resourceId: event.endsWith("_comment")
			? source.pull_request_review_id
			: source.id,
		pull: pr.number,
		sha: head.sha,
		branch: head.ref,
		url: pr.html_url,
	});
}

/** Compare GitHub's SHA-256 HMAC without accepting absent or malformed signatures. */
export async function verifySignature(
	body: Uint8Array,
	signature: string | null,
	secret: string,
): Promise<boolean> {
	if (!signature || !/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);
	const bytes = Uint8Array.from(signature.slice(7).match(/../g) ?? [], (hex) =>
		Number.parseInt(hex, 16),
	);
	return crypto.subtle.verify(
		"HMAC",
		key,
		bytes,
		body as Uint8Array<ArrayBuffer>,
	);
}
