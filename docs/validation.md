# Validation

The automated suite verifies HMAC integrity, repository and author filtering, durable deduplication, non-mutating status reads, active-owner delivery, unreachable-owner deferral, dirty/ambiguous ownership, preparation/session-start races, interrupted-worker quarantine, external-clone and native custom-tool ownership, stale-event suppression, lifecycle release, subscription-only invocation, and the actual local Workers/SQLite/WebSocket delivery protocol.

Live installation receipts are stored outside this repository. Public validation does not include account identifiers, enrolled repository names, machine paths, webhook secrets or private event content.

## Limits

- Direct steering requires the existing owner's shared Codex app-server control socket. Desktop-only sessions without that socket are deferred.
- Filesystem and lifecycle evidence cannot establish ownership for arbitrary external editors. Dirty Git state remains an additional guard.
- An agent exit code alone does not prove a fix or deployment. Read its report and draft PR checks.
- Transport reconnects retry delivery. Blocked model executions and uncertain sends are never automatically replayed.

Local validation: `npm run check` and the complete `npm test` suite pass. Independent review reproduced and then verified all ownership fixes, with no remaining Current findings in that review. The hosted relay was deployed and installation receipts stay in private state.

Live checks also confirmed a ChatGPT-authenticated Codex response, relay rejection of an invalid signature (401), successful signed delivery (200), duplicate suppression in the Mac inbox, and an obsolete failed run being ignored after GitHub revalidation. The relay reported a connected Mac with no pending delivery. No automatic repair or successful fix is inferred from that deliberately obsolete event.

Edge migration checks confirmed a signed provider ping (200), an authenticated connected Mac (200), absent and invalid client credentials blocked at the edge (403), and both legacy and renamed workers.dev routes unavailable (404). The Worker rename preserved the exact existing SQLite Durable Object namespace. Existing rules for other hostnames were preserved. The runtime has no 403 response path, distinguishing these edge rejections from Worker authentication failures.
