/** Local administration: launchd installation, queue inspection and explicit recovery. */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfigPath, loadConfig, readSecret } from "./config.ts";
import { startDaemon } from "./daemon.ts";
import { Store } from "./store.ts";

const args = process.argv.slice(2);
const operation = args[0];
const configPath = args[1] ?? defaultConfigPath;
const config = loadConfig(configPath);
const escapeXml = (text: string) =>
	text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

if (operation === "start") {
	const stop = startDaemon(config);
	for (const signal of ["SIGINT", "SIGTERM"] as const)
		process.once(signal, () => {
			stop();
			process.exit(0);
		});
} else if (operation === "status") {
	const store = new Store(join(config.stateDir, "inbox.sqlite"));
	try {
		console.log(JSON.stringify({ jobs: store.list() }, null, 2));
	} finally {
		store.close();
	}
} else if (operation === "retry") {
	const id = args[2];
	if (!id || args[3] !== "--reconciled")
		throw new Error(
			"retry requires an event ID and --reconciled after independently confirming no old repair process or external action remains",
		);
	const store = new Store(join(config.stateDir, "inbox.sqlite"));
	try {
		const job = store.list().find((job) => job.id === id);
		if (job?.state !== "blocked")
			throw new Error("Only a reconciled blocked event can be retried");
		store.set(id, "queued", "Explicitly retried after human reconciliation");
	} finally {
		store.close();
	}
	console.log("Event queued; restart the service to wake it.");
} else if (operation === "install") {
	process.umask(0o077);
	mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
	const label = "com.codex.github-bridge";
	const plist = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
	mkdirSync(dirname(plist), { recursive: true });
	const entry = fileURLToPath(new URL("./cli.ts", import.meta.url));
	const path = process.env.PATH ?? "/usr/bin:/bin";
	// launchd keeps one event listener alive; no StartInterval or calendar schedule is installed.
	const xml = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${[process.execPath, entry, "start", resolve(configPath)].map((v) => `<string>${escapeXml(v)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer><key>EnvironmentVariables</key><dict><key>PATH</key><string>${escapeXml(path)}</string></dict><key>StandardOutPath</key><string>${escapeXml(join(config.stateDir, "service.log"))}</string><key>StandardErrorPath</key><string>${escapeXml(join(config.stateDir, "service-error.log"))}</string></dict></plist>`;
	writeFileSync(plist, xml, { mode: 0o600 });
	chmodSync(plist, 0o600);
	const domain = `gui/${process.getuid?.()}`;
	execFileSync("launchctl", ["bootstrap", domain, plist], {
		stdio: "pipe",
		timeout: 10000,
	});
	console.log(JSON.stringify({ installed: true, label, plist }));
} else if (operation === "hooks") {
	const secret = readSecret(
		config,
		args[2] ?? "codex-github-bridge/prod/webhook-secret",
	);
	const endpoint = new URL("/github", config.relayUrl).href;
	const events = [
		"workflow_run",
		"pull_request_review",
		"pull_request_review_comment",
	];
	const receipts: { repo: string; id: number }[] = [];
	for (const repository of config.repositories) {
		const hooks = JSON.parse(
			execFileSync(config.ghBin, ["api", `repos/${repository.repo}/hooks`], {
				encoding: "utf8",
				timeout: 30000,
			}),
		) as { id: number; config: { url: string } }[];
		const existing = hooks.find((hook) => hook.config.url === endpoint);
		const path = `repos/${repository.repo}/hooks${existing ? `/${existing.id}` : ""}`;
		const input = JSON.stringify({
			name: "web",
			active: true,
			events,
			config: {
				url: endpoint,
				content_type: "json",
				insecure_ssl: "0",
				secret,
			},
		});
		const result = JSON.parse(
			execFileSync(
				config.ghBin,
				["api", "--method", existing ? "PATCH" : "POST", path, "--input", "-"],
				{ input, encoding: "utf8", timeout: 30000 },
			),
		) as {
			id: number;
			active: boolean;
			events: string[];
			config: { url: string };
		};
		if (
			!result.active ||
			result.config.url !== endpoint ||
			!events.every((event) => result.events.includes(event))
		)
			throw new Error(`Hook readback failed for ${repository.repo}`);
		receipts.push({ repo: repository.repo, id: result.id });
		writeFileSync(
			join(config.stateDir, "hooks.json"),
			JSON.stringify(receipts, null, 2),
			{ mode: 0o600 },
		);
	}
	writeFileSync(
		join(config.stateDir, "hooks.json"),
		JSON.stringify(receipts, null, 2),
		{ mode: 0o600 },
	);
	console.log(
		JSON.stringify({ hooks_installed: receipts.length, receipts }, null, 2),
	);
} else {
	console.log(
		"Usage: node src/cli.ts <start|install|status|hooks|retry> [config-path] [webhook-secret-entry|event-id]",
	);
}
