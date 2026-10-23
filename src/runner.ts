/** Run one repair in a disposable clone using existing ChatGPT authentication only. */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { Signal } from "./events.ts";
import { command, taskPrompt } from "./github.ts";

export function chatgptEnvironment(): NodeJS.ProcessEnv {
	// Explicitly omit API credentials and provider overrides from unattended children.
	const env: NodeJS.ProcessEnv = {};
	for (const key of [
		"HOME",
		"USER",
		"LOGNAME",
		"PATH",
		"TMPDIR",
		"LANG",
		"SHELL",
		"SSH_AUTH_SOCK",
		"SSL_CERT_FILE",
		"NODE_EXTRA_CA_CERTS",
	]) {
		if (process.env[key]) env[key] = process.env[key];
	}
	return env;
}

export function codexArguments(output: string): string[] {
	return [
		"-a",
		"never",
		"-c",
		'forced_login_method="chatgpt"',
		"-c",
		'model_provider="openai"',
		"-c",
		'model_reasoning_effort="high"',
		"exec",
		"--json",
		"--sandbox",
		"workspace-write",
		"-c",
		"sandbox_workspace_write.network_access=true",
		"--output-last-message",
		output,
		"-",
	];
}

export class PreparationCancelled extends Error {
	constructor() {
		super("Repository became occupied before Codex launch");
	}
}

export async function runRepair(
	config: Config,
	signal: Signal,
	onSpawn: (child: ChildProcess) => void,
	beforeSpawn: () => Promise<boolean>,
): Promise<string> {
	const auth = spawnSync(config.codexBin, ["login", "status"], {
		env: chatgptEnvironment(),
		encoding: "utf8",
		timeout: 10000,
	});
	if (
		auth.status !== 0 ||
		!`${auth.stdout}${auth.stderr}`
			.toLowerCase()
			.includes("logged in using chatgpt")
	)
		throw new Error("ChatGPT subscription login required");
	const fingerprint = createHash("sha256")
		.update(signal.id)
		.digest("hex")
		.slice(0, 20);
	const work = join(config.stateDir, "work");
	mkdirSync(work, { recursive: true, mode: 0o700 });
	const root = mkdtempSync(join(work, `${fingerprint}-`));
	const reports = join(config.stateDir, "reports");
	mkdirSync(reports, { recursive: true, mode: 0o700 });
	// Clone from canonical GitHub identity, never mutate the user's checkout or PR branch.
	await command(config.ghBin, [
		"repo",
		"clone",
		signal.repo,
		root,
		"--",
		"--no-checkout",
	]);
	await command("git", ["fetch", "origin", signal.sha], root);
	await command(
		"git",
		["switch", "-c", `${config.branchPrefix}${fingerprint}`, signal.sha],
		root,
	);
	if (!(await beforeSpawn())) {
		rmSync(root, { recursive: true, force: true });
		throw new PreparationCancelled();
	}
	const output = join(reports, `${fingerprint}.txt`);
	// Raw agent stdout/stderr can contain prompts and secrets; only safe lifecycle events are journaled.
	const env = { ...chatgptEnvironment(), CODEX_HOME: config.codexHome };
	const child = spawn(config.codexBin, codexArguments(output), {
		cwd: root,
		env,
		detached: true,
		stdio: ["pipe", "ignore", "ignore"],
	});
	onSpawn(child);
	child.stdin?.end(taskPrompt(signal));
	const kill = () => {
		if (child.pid)
			try {
				process.kill(-child.pid, "SIGTERM");
			} catch {
				/* Already exited. */
			}
	};
	const timer = setTimeout(kill, config.jobTimeoutMs);
	let hardStop: NodeJS.Timeout | undefined;
	child.once("spawn", () => {
		hardStop = setTimeout(() => {
			if (child.pid)
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					/* Already exited. */
				}
		}, config.jobTimeoutMs + 5000);
	});
	try {
		await new Promise<void>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code, signal) =>
				code === 0
					? resolve()
					: reject(
							new Error(
								`Codex stopped (${code ?? signal}); inspect local report before retry`,
							),
						),
			);
		});
		return readFileSync(output, "utf8").slice(0, 2000);
	} finally {
		clearTimeout(timer);
		if (hardStop) clearTimeout(hardStop);
	}
}
