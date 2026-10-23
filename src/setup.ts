/** Discover explicit local repositories and deploy a private-configured push relay. */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { configSchema, defaultConfigPath } from "./config.ts";

const projectsRoot = resolve(process.argv[2] ?? join(homedir(), "projects"));
const configPath = resolve(process.argv[3] ?? defaultConfigPath);
const locate = (name: string) =>
	execFileSync("/usr/bin/which", [name], { encoding: "utf8" }).trim();
const credsBin = locate("creds"),
	ghBin = locate("gh"),
	codexBin = locate("codex");
const secret = (entry: string, create = false): string => {
	const result = spawnSync(credsBin, ["get", entry, "--no-newline"], {
		encoding: "utf8",
		timeout: 10000,
	});
	if (result.status === 0) return result.stdout.trim();
	if (result.status !== 2 || !create)
		throw new Error(`Credential unavailable: ${entry}`);
	const value = randomBytes(32).toString("hex");
	const saved = spawnSync(credsBin, ["set", entry], {
		input: value,
		encoding: "utf8",
		timeout: 10000,
	});
	if (saved.status !== 0) throw new Error(`Cannot store credential: ${entry}`);
	return value;
};
const owner = execFileSync(ghBin, ["api", "user", "--jq", ".login"], {
	encoding: "utf8",
	timeout: 15000,
}).trim();
const repositories: { repo: string; path: string }[] = [];
for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
	const path = join(projectsRoot, entry.name);
	if (!entry.isDirectory() || !existsSync(join(path, ".git", "config")))
		continue;
	const remote = spawnSync("git", ["-C", path, "remote", "get-url", "origin"], {
		encoding: "utf8",
		timeout: 3000,
	});
	const match = remote.stdout
		?.trim()
		.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
	if (!match || match[1].split("/")[0] !== owner) continue;
	// Git remotes may retain a previous repository name. GET follows GitHub redirects;
	// use the canonical identity for signed payloads and hook mutations alike.
	const remoteRepository = JSON.parse(
		execFileSync(
			ghBin,
			["api", `repos/${match[1]}`, "--jq", "{full_name, archived, disabled}"],
			{ encoding: "utf8", timeout: 15000 },
		),
	) as { full_name: string; archived: boolean; disabled: boolean };
	if (
		remoteRepository.archived ||
		remoteRepository.disabled ||
		remoteRepository.full_name.split("/")[0] !== owner ||
		repositories.some((repo) => repo.repo === remoteRepository.full_name)
	)
		continue;
	repositories.push({
		repo: remoteRepository.full_name,
		path: realpathSync(path),
	});
}
if (!repositories.length)
	throw new Error("No owned GitHub repositories discovered");
const reviewAuthors = [
	"chatgpt-codex-connector[bot]",
	"chatgpt-codex-connector",
];
const clientEntry = "codex-github-bridge/prod/client-token";
const webhookEntry = "codex-github-bridge/prod/webhook-secret";
const clientToken = secret(clientEntry, true),
	webhookSecret = secret(webhookEntry, true);
const env = {
	...process.env,
	CLOUDFLARE_ACCOUNT_ID: secret("cloudflare/account/id"),
	CLOUDFLARE_API_TOKEN: secret("cloudflare/wrangler/api-key"),
	WRANGLER_SEND_METRICS: "false",
	CI: "true",
};
const wrangler = resolve("node_modules/.bin/wrangler");
const deploy = spawnSync(wrangler, ["deploy"], {
	env,
	encoding: "utf8",
	timeout: 180000,
	maxBuffer: 4 * 1024 * 1024,
});
if (deploy.status !== 0)
	throw new Error(`Worker deploy failed: ${deploy.stderr}`);
const relayUrl = deploy.stdout.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0];
if (!relayUrl) throw new Error("Deployment did not return a workers.dev URL");
const bindings = {
	WEBHOOK_SECRET: webhookSecret,
	CLIENT_TOKEN: clientToken,
	ALLOWED_REPOS: JSON.stringify(repositories.map((repo) => repo.repo)),
	REVIEW_AUTHORS: JSON.stringify(reviewAuthors),
};
const provision = spawnSync(wrangler, ["secret", "bulk"], {
	env,
	input: JSON.stringify(bindings),
	encoding: "utf8",
	timeout: 60000,
	maxBuffer: 2 * 1024 * 1024,
});
if (provision.status !== 0)
	throw new Error(`Worker secrets failed: ${provision.stderr}`);
const stateDir = join(
	homedir(),
	"Library",
	"Application Support",
	"codex-github-bridge",
);
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
if (existsSync(configPath))
	writeFileSync(`${configPath}.backup`, readFileSync(configPath), {
		mode: 0o600,
	});
const config = configSchema.parse({
	relayUrl,
	clientTokenEntry: clientEntry,
	credsBin,
	ghBin,
	codexBin,
	stateDir,
	codexHome: process.env.CODEX_HOME ?? join(homedir(), ".codex"),
	repositories,
	reviewAuthors,
});
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
	mode: 0o600,
});
console.log(
	JSON.stringify(
		{ deployed: true, relayUrl, configPath, repositories: repositories.length },
		null,
		2,
	),
);
