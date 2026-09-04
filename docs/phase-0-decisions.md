# Phase 0 decisions

## Architecture

- Start with a modular monolith, not microservices.
- Keep REST and MCP adapters thin; both call the same domain services.
- Use a monorepo for Web, server, shared contracts, Android shell, and SDKs.
- Use SQLite and a private local attachment directory in the first self-hosted release.
- Keep storage interfaces replaceable so PostgreSQL and S3-compatible storage can be added later.

## Client boundaries

- The Web application owns the shared management UI and H5 feedback form.
- The Android management app wraps the Web application and adds native share, attachment, secure-storage, offline-draft, and deep-link capabilities.
- The Android feedback SDK is a small Kotlin library for host applications.
- The macOS feedback SDK is a Swift Package for SwiftUI and AppKit applications.

## AI boundaries

- AI clients access live work-item data through MCP, never through SQL.
- Skills teach the repeatable workflow and client-specific invocation details.
- On-demand invocation is the only MVP trigger.
- Work-item content is untrusted data and cannot override skill, repository, or user instructions.
- Processing work uses an isolated branch/worktree and may create a local commit.
- Push and merge are disabled by default.
- A human owns final verification.

## Deferred decisions

- Open-source license.
- Android automatic updates and system notifications.
- Remote dispatch to Mac mini/server nodes.
- Automated scheduling, iOS, crash capture, PostgreSQL, and object storage.
