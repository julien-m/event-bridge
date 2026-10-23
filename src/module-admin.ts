/** Upload declarative module policy using separate transport and administration credentials. */
import { readFileSync } from "node:fs";
import { type Config, readSecret } from "./config.ts";
import { tasksSchema } from "./module-tasks.ts";
import { moduleSchema } from "./modules.ts";

/** Perform one bounded administration operation; uncertain writes are reconciled with modules-get. */
export async function administerModules(
	config: Config,
	operation: string,
	args: string[],
): Promise<unknown> {
	if (operation === "tasks-check") {
		if (!config.tasksFile) throw new Error("Configure tasksFile first");
		const tasks = tasksSchema.parse(
			JSON.parse(readFileSync(config.tasksFile, "utf8")),
		);
		return {
			tasks: tasks.tasks.map((task) => ({
				id: task.id,
				module: task.module,
				enabled: task.enabled,
			})),
		};
	}
	const headers: Record<string, string> = {
		Authorization: `Bearer ${readSecret(config, config.clientTokenEntry)}`,
		"X-Bridge-Admin": readSecret(
			config,
			config.adminTokenEntry ?? "event-bridge/prod/admin-token",
		),
	};
	let body: string | undefined;
	if (operation === "modules-put") {
		if (!args[0] || !args[2] || !/^\d+$/.test(args[2]))
			throw new Error(
				"modules-put requires MODULE_JSON SECRET_ENTRY_OR_DASH EXPECTED_REVISION",
			);
		const module = moduleSchema.parse(
			JSON.parse(readFileSync(args[0], "utf8")),
		);
		if (!config.tasksFile)
			throw new Error("Configure tasksFile before registration");
		const tasks = tasksSchema.parse(
			JSON.parse(readFileSync(config.tasksFile, "utf8")),
		);
		if (
			!tasks.tasks.some(
				(task) => task.id === module.task && task.module === module.id,
			)
		)
			throw new Error("Module task is not registered locally");
		body = JSON.stringify({
			module,
			expectedRevision: Number(args[2]),
			...(args[1] === "-" ? {} : { secret: readSecret(config, args[1]) }),
		});
		headers["Content-Type"] = "application/json";
	}
	const response = await fetch(new URL("/admin/modules", config.relayUrl), {
		method: body ? "PUT" : "GET",
		headers,
		body,
		signal: AbortSignal.timeout(15000),
		redirect: "error",
	});
	if (!response.ok)
		throw new Error(
			`Module administration HTTP ${response.status}; inspect modules-get before retrying an uncertain write`,
		);
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Missing response");
	const chunks: Uint8Array[] = [];
	let length = 0;
	while (true) {
		const part = await reader.read();
		if (part.done) break;
		length += part.value.byteLength;
		if (length > 4 * 1024 * 1024) {
			await reader.cancel();
			throw new Error("Administration response too large");
		}
		chunks.push(part.value);
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const part of chunks) {
		bytes.set(part, offset);
		offset += part.byteLength;
	}
	return JSON.parse(new TextDecoder().decode(bytes));
}
