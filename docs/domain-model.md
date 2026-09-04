# Domain model

## Hierarchy

```text
Product
├── Components
├── Areas
├── Repositories
└── Work items
    ├── Attachments
    ├── Comments and events
    └── Execution runs
```

A product is the user-facing application. A component is a buildable or independently changeable technical unit. An area is a flat functional classification. A repository is a logical code location and does not contain machine-local absolute paths.

For Hermes Go, Android and macOS are components of one product, not separate products.

## Work-item identity

Each product owns an uppercase prefix and a monotonic sequence. The visible key is `<PREFIX>-<SEQUENCE>`, for example `HG-128`.

The database also owns an opaque internal ID. External clients use the visible key whenever practical.

## Source and affected components

- `sourceComponentId` records where feedback was observed.
- `affectedComponentIds` records what must be changed or verified.

An Android report may later affect Android, macOS, shared-core, and server components without creating a second top-level work item.

## Work-item types

Every captured record is a work item with one of five types: `idea`, `requirement`, `bug`, `task`, or `note`. A type may change as the item becomes clearer; its stable key and timeline remain unchanged.

## Work-item state machine

```text
inbox
  -> ready
  -> in_progress
  -> on_hold
  -> pending_verification
  -> done
```

Verification failure returns a work item to `ready` and appends a reopen event. `cancelled` is a human-controlled side state.

The implementation in `packages/domain` is authoritative. REST and MCP handlers must call it rather than duplicating transition logic.

## Execution runs

Work-item and execution states are separate. A work item may contain multiple failed, interrupted, or successful runs. Each run stores its mode, trigger source, agent kind, timestamps, report, and lease history.

The MVP supports `agent_pull`. Future trigger sources (`web_dispatch`, `android_dispatch`, and `scheduler`) are reserved in the domain model without implementing dispatch.
