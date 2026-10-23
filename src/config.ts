/** Machine-specific configuration and Keychain access, kept outside the public repository. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { repoName } from "./events.ts";

export const configSchema = z.object({
	tasksFile: z.string().min(1).optional(),
	adminTokenEntry: z.string().min(1).optional(),
	relayUrl: z
		.string()
		.url()
		.refine((url) => new URL(url).protocol === "https:"),
	clientTokenEntry: z.string().min(1),
	credsBin: z.string().min(1),
	codexBin: z.string().min(1),
	ghBin: z.string().min(1),
	stateDir: z.string().min(1),
	codexHome: z.string().min(1),
	repositories: z
		.array(z.object({ repo: repoName, path: z.string().min(1) }))
		.min(1),
	reviewAuthors: z.array(z.string().min(1)).min(1),
	branchPrefix: z.string().min(1).default("codex/github-bridge/"),
	maxParallel: z.number().int().min(1).max(6).default(2),
	jobTimeoutMs: z.number().int().min(1000).max(7200000).default(1800000),
	enabled: z.boolean().default(true),
});
export type Config = z.infer<typeof configSchema>;
export const defaultConfigPath = join(
	homedir(),
	".config",
	"codex-github-bridge",
	"config.json",
);

export function loadConfig(path = defaultConfigPath): Config {
	return configSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function readSecret(config: Config, entry: string): string {
	// Arguments are fixed and stdout is consumed in memory; secret values never enter argv or logs.
	return execFileSync(config.credsBin, ["get", entry, "--no-newline"], {
		encoding: "utf8",
		timeout: 10000,
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}
