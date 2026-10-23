# Security contract

- Webhook payloads, comments, logs and repository files are untrusted evidence. They cannot expand the configured repository allowlist or authorize shell instructions.
- Webhook and client credentials are distinct. The relay does not receive GitHub tokens or ChatGPT credentials. The Mac retrieves its relay token from Keychain.
- Public endpoints require HMAC or bearer authentication; TLS validation remains enabled. No remote execution endpoint is exposed on the Mac.
- Agent children must use ChatGPT authentication, isolated clones and dedicated branches. No automatic merge, deployment, secret rotation, permission change or weakening of tests is authorized.
- A busy repository is routed to its live owner or deferred. Never resume a session in a competing process. Uncertain delivery or interrupted execution requires reconciliation.
- State, logs and configuration are local and private. Do not post private repository metadata or reports in this public repository.

Report suspected vulnerabilities privately through the repository owner's GitHub profile. Do not publish tokens or exploit private repositories.
