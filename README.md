# MissionGo

> From idea to shipped.

MissionGo is a personal, self-hosted work hub for independent developers. It captures ideas, requirements, bugs, tasks, and notes from Web, Android, and macOS development builds, then lets coding agents read and process a work item by ID through MCP. Agents write structured analysis, code-change evidence, and test results back to the item. A human performs final verification.

## Current status

The core server foundation is now runnable. The repository currently contains:

- the core work-item state machine;
- typed MCP contract definitions;
- domain and security decisions;
- an initial REST API contract;
- a Fastify server backed by SQLite;
- Product, Component, Work Item, and Timeline persistence;
- tests for persistence, validation, authentication, and the highest-risk transition rules.

No Web UI, Android app, feedback SDK, attachment upload, or MCP transport has been implemented yet.

## Confirmed MVP scope

- Single-user and self-hosted.
- Multiple products, components, areas, and repositories.
- Responsive Web management UI plus an Android native shell.
- Android feedback SDK and Swift macOS feedback package.
- On-demand AI processing through a remote MCP server and reusable skills.
- SQLite metadata storage and a local attachment directory.
- AI creates isolated local changes and commits but does not push or merge by default.
- AI stops at `pending_verification`; a human moves the work item to `done`.

## Workspace commands

Node.js 22.13 or newer is required. Node.js 24 LTS or newer is recommended.

```bash
npm install
npm test
npm run typecheck
npm run build
npm run dev:server
```

The development server defaults to `127.0.0.1:8787` and stores data in `./data/missiongo.sqlite`. Copy `.env.example` to `.env` to override local settings. A non-loopback bind is rejected unless `ADMIN_API_TOKEN` is configured.

## Security

Copy `.env.example` to a local `.env`. Never commit real deployment coordinates or secrets. See [docs/security-boundaries.md](docs/security-boundaries.md).

## License

MissionGo is licensed under the [Apache License 2.0](LICENSE).

## Planning documents

- [Product requirements and technical plan](docs/product-and-technical-plan.md)
- [Phase 0 decisions](docs/phase-0-decisions.md)
- [Domain model](docs/domain-model.md)
- [MCP contract](docs/mcp-contract.md)
- [REST API draft](docs/openapi.yaml)
