# Feedback System

Working title for a personal, self-hosted feedback loop for independent developers.

The system will collect Bugs and ideas from Web, Android, and macOS development builds, then let coding agents read and process a task by ID through MCP. Agents write structured analysis, code-change evidence, and test results back to the task. A human performs final verification.

## Current status

Phase 0 is in progress. The repository currently contains:

- the core task state machine;
- typed MCP contract definitions;
- domain and security decisions;
- an initial REST API contract;
- tests for the highest-risk transition rules.

No production server, Web UI, Android app, or SDK has been implemented yet.

## Confirmed MVP scope

- Single-user and self-hosted.
- Multiple products, components, areas, and repositories.
- Responsive Web management UI plus an Android native shell.
- Android feedback SDK and Swift macOS feedback package.
- On-demand AI processing through a remote MCP server and reusable skills.
- SQLite metadata storage and a local attachment directory.
- AI creates isolated local changes and commits but does not push or merge by default.
- AI stops at `ready_for_verification`; a human closes the task.

## Workspace commands

```bash
npm install
npm test
npm run typecheck
npm run build
```

## Security

Copy `.env.example` to a local `.env`. Never commit real deployment coordinates or secrets. See [docs/security-boundaries.md](docs/security-boundaries.md).

## Planning documents

- [Product requirements and technical plan](docs/product-and-technical-plan.md)
- [Phase 0 decisions](docs/phase-0-decisions.md)
- [Domain model](docs/domain-model.md)
- [MCP contract](docs/mcp-contract.md)
- [REST API draft](docs/openapi.yaml)
