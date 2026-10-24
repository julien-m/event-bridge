/** Serve a passive loopback-only SSE panel from minimized in-process telemetry. */
import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Telemetry } from "./telemetry.ts";

const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Event Bridge · Local status</title>
<style>body{font:16px system-ui;background:#101724;color:#e4e9f2;max-width:1100px;margin:40px auto;padding:0 24px}h1{margin-bottom:8px}p{color:#acb8cb;line-height:1.5}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}article{background:#1a2536;padding:16px;border-radius:12px}h2{font-size:18px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px ui-monospace,monospace;line-height:1.6}select{background:#1a2536;color:inherit;padding:8px;border:1px solid #708199;border-radius:4px;margin:8px}table{width:100%;border-collapse:collapse;font-size:14px}td,th{padding:12px 8px;text-align:left;border-bottom:1px solid #344257;overflow-wrap:anywhere}#freshness{color:#efc36b}small{color:#acb8cb}</style>
<script src="/panel.js" defer></script><h1>Event Bridge</h1><p>Local observation · Read only · No execution controls</p>
<p id="freshness" data-testid="panel-freshness" role="status">Connecting to local process…</p>
<div class="grid"><article><h2>Process & activation</h2><pre id="process" data-testid="panel-process"></pre></article><article><h2>Worker transport</h2><pre id="worker" data-testid="panel-worker"></pre></article><article><h2>Ownership</h2><pre id="ownership" data-testid="panel-ownership"></pre></article><article><h2>GitHub dispatcher</h2><pre id="github" data-testid="panel-github"></pre></article><article><h2>Module dispatcher</h2><pre id="modules" data-testid="panel-modules"></pre></article><article><h2>Latest observations</h2><pre id="latest" data-testid="panel-latest"></pre></article></div>
<h2>Local durable queue</h2><pre id="queue" data-testid="panel-queue"></pre><small>Pending = queued, deferred, forwarding or running. Ages use first local receipt; legacy unknown dates stay unknown. Relay queue is not queried.</small>
<h2>Recent observations</h2><p>Up to 100 groups since process start. Repeated adjacent events are grouped. Counters count individual observations.</p>
<label>View <select id="severity" data-testid="panel-filter-severity"><option value="all">All</option><option value="errors">Errors</option><option value="blocked">Blocked</option></select></label><label>Module <select id="module" data-testid="panel-filter-module"><option value="">All</option></select></label><label>Repository <select id="repo" data-testid="panel-filter-repo"><option value="">All</option></select></label>
<pre id="counters" data-testid="panel-counters"></pre><table><thead><tr><th>Time</th><th>Source / scope</th><th>Observation</th><th>Count</th></tr></thead><tbody id="events" data-testid="panel-events"></tbody></table>
<p>Forwarded means delivered to an owner. Completed means the task or agent exited successfully. Neither proves a defect was fixed or a PR validated. An open WebSocket proves transport state only.</p></html>`;

/** Bind IPv4 loopback only. A fresh full snapshot on every SSE connection repairs missed UI updates. */
export async function startPanel(
	telemetry: Telemetry,
	port: number,
): Promise<{ url: string; close: () => Promise<void> }> {
	const clients = new Set<ServerResponse>();
	const script = readFileSync(
		new URL("./panel-client.js", import.meta.url),
		"utf8",
	);
	let address = "";
	let broadcast: NodeJS.Timeout | undefined;
	let heartbeat: NodeJS.Timeout | undefined;
	const frame = () =>
		`event: snapshot\ndata: ${JSON.stringify(telemetry.snapshot())}\n\n`;
	const publish = () => {
		const data = frame();
		for (const client of clients) if (!client.write(data)) client.destroy();
	};
	const changed = () => {
		if (!clients.size || broadcast) return;
		// At most five renders per second, irrespective of incoming event volume.
		broadcast = setTimeout(() => {
			broadcast = undefined;
			publish();
		}, 200);
		broadcast.unref();
	};
	const server = createServer((request, response) => {
		const origin = `http://${address}`;
		response.setHeader("Cache-Control", "no-store");
		response.setHeader("X-Content-Type-Options", "nosniff");
		response.setHeader(
			"Content-Security-Policy",
			"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
		);
		// Host, Origin and fetch metadata reject DNS rebinding and cross-site reads; there is no CORS.
		if (
			request.headers.host !== address ||
			(request.headers.origin && request.headers.origin !== origin) ||
			(request.headers["sec-fetch-site"] === "cross-site" &&
				!(
					request.url === "/" &&
					request.headers["sec-fetch-mode"] === "navigate" &&
					request.headers["sec-fetch-dest"] === "document"
				))
		) {
			response.writeHead(403).end();
			return;
		}
		if (request.method !== "GET") {
			response.setHeader("Allow", "GET");
			response.writeHead(405).end();
			return;
		}
		if (request.url === "/") {
			response.setHeader("Content-Type", "text/html; charset=utf-8");
			response.end(page);
			return;
		}
		if (request.url === "/panel.js") {
			response.setHeader("Content-Type", "text/javascript; charset=utf-8");
			response.end(script);
			return;
		}
		if (request.url !== "/events") {
			response.writeHead(404).end();
			return;
		}
		if (clients.size >= 8) {
			response.writeHead(503).end();
			return;
		}
		response.setHeader("Content-Type", "text/event-stream");
		response.setHeader("Connection", "keep-alive");
		response.flushHeaders();
		clients.add(response);
		response.write(frame());
		if (!heartbeat) {
			// Local freshness only, active only with viewers; this never contacts GitHub or the Worker.
			heartbeat = setInterval(() => {
				for (const client of clients)
					if (!client.write(`event: heartbeat\ndata: ${Date.now()}\n\n`))
						client.destroy();
			}, 15000);
			heartbeat.unref();
		}
		response.once("close", () => {
			clients.delete(response);
			if (!clients.size) {
				clearInterval(heartbeat);
				heartbeat = undefined;
			}
		});
	});
	server.requestTimeout = 10000;
	server.headersTimeout = 10000;
	server.maxConnections = 16;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	address = `127.0.0.1:${(server.address() as AddressInfo).port}`;
	telemetry.on("changed", changed);
	return {
		url: `http://${address}`,
		close: async () => {
			telemetry.off("changed", changed);
			clearTimeout(broadcast);
			clearInterval(heartbeat);
			for (const client of clients) client.destroy();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		},
	};
}
