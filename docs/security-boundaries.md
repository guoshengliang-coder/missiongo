# Security boundaries

## Secret policy

Never commit:

- real domains, IP addresses, or ports;
- database credentials or paths containing private machine details;
- MCP, SDK, session, GitHub, or AI-provider tokens;
- Android keystores, Apple certificates, provisioning profiles, or signing passwords;
- local repository paths;
- production logs, screenshots, attachments, or database snapshots.

Tracked examples must use blank values or reserved/example values only.

## Token classes

- Admin session: full management access.
- SDK token: submit-only and scoped to one product/component.
- MCP agent token: scoped read/claim/write actions for selected products.
- Future node token: bound to one worker machine and its capabilities.

Long-lived tokens are stored hashed. Plaintext is shown only at creation time and can be revoked.

## Untrusted feedback

Descriptions, comments, logs, OCR, filenames, images, and videos can contain malicious instructions. They must be labeled and handled as data. Neither the service nor a skill may let them override system, user, repository, or safety instructions.

## Attachment safety

- Generate storage names server-side.
- Enforce size, count, MIME, and extension allowlists.
- Prevent path traversal and direct public directory access.
- Serve through authenticated endpoints or short-lived URLs.
- Escape user filenames in all rendered views.

## Audit events

Record authentication failures, token lifecycle events, task claims, lease expiry, state changes, verification, exports, and attachment access suitable for incident review.
