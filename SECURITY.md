# Security contract

- Webhook payloads, comments, logs and repository files are untrusted evidence. They cannot expand the configured repository allowlist or authorize shell instructions.
- Webhook and client credentials are distinct. The relay does not receive GitHub tokens or ChatGPT credentials. The Mac retrieves its relay token from Keychain.
- Public endpoints require HMAC or bearer authentication; TLS validation remains enabled. No remote execution endpoint is exposed on the Mac.
- Agent children must use ChatGPT authentication, isolated clones and dedicated branches. No automatic merge, deployment, secret rotation, permission change or weakening of tests is authorized.
- A busy repository is routed to its live owner or deferred. Never resume a session in a competing process. Uncertain delivery or interrupted execution requires reconciliation.
- Module policy contains no executable code. Provider secrets are separately encrypted in the durable registry; list responses never disclose them. Every mapped header must be signed. Administration, transport and generic edge ingress use distinct credentials.
- Generic task commands are authorized in the private local registry only. Webhook inputs travel as JSON on stdin, with shared repository ownership/concurrency guards and interruption quarantine.
- Local task definitions and execution logs stay private on the Mac; explicitly mapped webhook inputs and encrypted provider credentials are persisted by the Cloudflare relay.
- The optional observation listener binds only to 127.0.0.1, accepts GET only, rejects foreign Host/Origin values and exposes only an explicit minimized projection. It grants no execution or recovery controls.
- Observation logs rotate independently from durable receipts; raw error text, agent stdout/stderr, payloads and credentials are not journal fields.
- Machine configuration, local execution state and logs stay private. Do not post private repository metadata, provider payloads or reports in this public repository.

Report suspected vulnerabilities privately through the repository owner's GitHub profile. Do not publish tokens or exploit private repositories.
