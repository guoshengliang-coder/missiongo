# Domain model

## Hierarchy

```text
Product
├── Components
├── Areas
├── Repositories
└── Tasks
    ├── Attachments
    ├── Comments and events
    └── Execution runs
```

A product is the user-facing application. A component is a buildable or independently changeable technical unit. An area is a flat functional classification. A repository is a logical code location and does not contain machine-local absolute paths.

For Hermes Go, Android and macOS are components of one product, not separate products.

## Task identity

Each product owns an uppercase prefix and a monotonic sequence. The visible key is `<PREFIX>-<SEQUENCE>`, for example `HG-128`.

The database also owns an opaque internal ID. External clients use the visible key whenever practical.

## Source and affected components

- `sourceComponentId` records where feedback was observed.
- `affectedComponentIds` records what must be changed or verified.

An Android report may later affect Android, macOS, shared-core, and server components without creating a second top-level task.

## Task state machine

```text
pending
  -> in_progress
  -> waiting_for_human
  -> ready_for_verification
  -> completed
```

Verification failure returns a task to `pending` and appends a reopen event. `cancelled` is a human-controlled side state.

The implementation in `packages/domain` is authoritative. REST and MCP handlers must call it rather than duplicating transition logic.

## Execution runs

Task and execution states are separate. A task may contain multiple failed, interrupted, or successful runs. Each run stores its mode, trigger source, agent kind, timestamps, report, and lease history.

The MVP supports `agent_pull`. Future trigger sources (`web_dispatch`, `android_dispatch`, and `scheduler`) are reserved in the domain model without implementing dispatch.
