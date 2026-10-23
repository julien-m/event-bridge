# Local observation validation

## Scope and activation

This change adds code for an optional loopback panel and bounded operational journals. It does not deploy a Worker, change credentials/WAF, modify private runtime configuration, restart the installed service or prove production activation. Read [the activation instructions](../README.md#local-observation-panel) before an intentional service restart.

## Contracts exercised locally

- A real Dispatcher and ModuleTasks retain stopped/invalid states even with transport marked connected.
- Unknown fields, raw IDs and unconfigured repository values cannot enter the journal or panel. Repeated equivalent events group; at most 100 groups remain in memory.
- A reduced journal byte budget exercises real rotation and verifies three files, per-file bounds, private permissions and parseable JSONL; production uses the same logic with 10 MiB per file.
- An actual legacy SQLite fixture migrates through the writer, retains receipt IDs and states, and distinguishes unknown historical dates. A DatabaseSync read-only connection reads only aggregates without changing schema.
- A real loopback HTTP server rejects non-GET methods, foreign Host/Origin and unsupported routes. Reconnected SSE clients receive current health; the route never returns CLI status or raw job bodies.
- The browser client renders stopped dispatchers, filters blocked rows and labels a disconnected feed as stale. Text nodes are used throughout.

The full local test suite includes the existing Worker/HMAC/WebSocket integration and task shutdown/ownership tests. Neither test delivery nor a successful agent exit is evidence of a corrected repository defect.

## Separate known limits

- Worker transport status describes the local WebSocket, not a fresh remote application probe. The relay pending count is deliberately unavailable here.
- Counters, recent groups and latest lifecycle observations reset on daemon restart. Durable queue state and deduplication do not.
- Existing raw service logs and final repair report artifacts are preserved; only new operational journals follow the three-file bound. Final reports remain private reconciliation artifacts and are never published through the panel.
- Existing conditional CODEX_HOME mismatch remains: login precheck uses chatgptEnvironment without the configured CODEX_HOME, repair execution uses config.codexHome, and app-server proxy inherits its environment. This requires a separate scoped correction and validation.
- The credential rotation remains blocked separately by Keychain access; this observability task does not change or bypass it. Merge remains separate from code publication on the existing PR branch.

## Local result

`npm run check` and the complete `npm test` suite passed: 25 tests in five files, including the existing local Worker integration. The independent review found that journal-directory creation could abort daemon startup; a failing regression reproduced it, and journal I/O now stays inside the degraded-observation boundary. Chrome rendering and the blocked filter were verified using temporary synthetic data; that preview was closed after capture.

Browser validation also exercised navigation from another origin: the root document permits a top-level navigation, while cross-site event-stream requests remain rejected. These headers are tested with node:http because Node fetch rewrites browser-controlled headers.

A low-priority cleanup limitation remains: an incomplete non-SSE HTTP request can delay the asynchronous panel close until the HTTP deadline. The installed CLI already exits explicitly on shutdown; this change does not claim a strict graceful-close deadline.
