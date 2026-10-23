# Project instructions

- Read [README.md](README.md) and [SECURITY.md](SECURITY.md) before changing behavior.
- Keep the public repository generic. Secrets, machine paths, enrolled repositories and reports stay in private runtime storage.
- Preserve event-driven delivery, durable receipt before acknowledgement and semantic deduplication.
- Never start a competing repair, infer successful delivery, or replay uncertain remote mutations.
- Run `npm run check` and the full `npm test` suite after code changes. Keep README files in English.
