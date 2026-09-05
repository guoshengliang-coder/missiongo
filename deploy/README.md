# MissionGo production deployment

This deployment runs two isolated containers:

- `web` serves the single-page application and proxies same-origin API requests.
- `server` owns the SQLite database and attachment storage.

Create a private environment file outside the repository with these values:

```dotenv
MISSIONGO_PUBLIC_ORIGIN=https://missiongo.example.com
MISSIONGO_BIND_PORT=8788
MISSIONGO_DATA_PATH=/path/to/missiongo-data
ADMIN_API_TOKEN=replace-with-a-random-secret
ADMIN_ACCOUNT_ID=replace-with-a-stable-random-id
ADMIN_USERNAME=replace-with-the-initial-admin-username
ADMIN_PASSWORD_SCRYPT=replace-with-a-scrypt-password-digest
SESSION_SECRET=replace-with-a-long-random-secret
# Optional: comma-separated product IDs. Omit to let the initial administrator read all products.
ADMIN_AUTHORIZED_PRODUCT_IDS=
# Optional: peers allowed to set X-Forwarded-For. Defaults to loopback,uniquelocal.
TRUST_PROXY=
```

Generate `ADMIN_PASSWORD_SCRYPT` locally from the repository root. The prompt
does not echo the password and the plaintext password is never written to disk:

```sh
npm run admin:hash-password
```

Generate `ADMIN_ACCOUNT_ID`, `ADMIN_API_TOKEN`, and `SESSION_SECRET` with a
cryptographically secure random generator. Keep the complete environment file
outside the repository and restrict its filesystem permissions.

Start or update the service from the `deploy` directory:

```sh
docker compose --env-file /path/to/private.env up -d --build
```

The host reverse proxy should terminate HTTPS and proxy the public hostname to
`http://127.0.0.1:${MISSIONGO_BIND_PORT}`. Keep the bound port on loopback so
the application containers are not directly exposed to the Internet.

### Security headers

The server sends `X-Content-Type-Options`, `X-Frame-Options`, and
`Referrer-Policy` itself, so they survive replacing the bundled web container
with a different reverse proxy.

Content-Security-Policy and HSTS stay with the proxy that terminates TLS. The
bundled `nginx-container.conf` relaxes `form-action` under `/oauth/` so the
sign-in page can redirect back to an AI client's local callback; a second CSP
header emitted by the application would be intersected with that one and break
the OAuth flow. If you replace the web container, carry that per-path CSP over,
and set HSTS on the host proxy.

### Client addresses behind the proxy

MissionGo rate-limits sign-in attempts per client address, so it has to know
which peers may set `X-Forwarded-For`. `TRUST_PROXY` controls that and defaults
to `loopback,uniquelocal`, which covers the container network and a reverse
proxy running on the same host.

Set `TRUST_PROXY` to `false` when the server is reached directly, and to the
specific addresses or CIDR ranges of your proxies when they sit on public
addresses. Do not set it to `true` on a public address: that trusts
`X-Forwarded-For` from every peer, so any client can forge its own address and
get an unlimited number of password attempts. Numeric hop counts are rejected,
because Fastify treats them as trusting nothing at all.

The read-only MCP endpoint uses the same account system as the website. On first
connection, the AI client opens the MissionGo sign-in page, then stores a
time-limited OAuth grant. MissionGo rechecks that grant and the account's
product scope on every read; the AI client never receives the password.
## Backup and restore

The database and the attachment directory are two halves of one dataset and
have to be captured together. Do not copy `missiongo.sqlite` with `cp`: it runs
in WAL mode, so a plain copy can miss everything still in the `-wal` file. Use
the bundled script, which takes a checkpointed snapshot with `VACUUM INTO`,
copies the attachments, and records a manifest with a checksum and row counts:

```sh
npm run backup -- --out /path/to/backups
```

It is safe to run against a live server. It also cross-checks the two halves and
warns about attachment rows whose file is missing. For a guaranteed-consistent
archive, stop the server first.

To restore, stop the server and point the script at one backup directory. It
verifies the checksum, refuses to overwrite live data unless `--force` is given,
and confirms afterwards that every attachment row has its file:

```sh
npm run restore -- --from /path/to/backups/missiongo-20260101T000000Z --force
```

Both scripts read `DATABASE_PATH` and `ATTACHMENTS_PATH` from the environment,
and accept `--database` and `--attachments` to override them. Run a restore into
a scratch directory after any upgrade that changes the schema, so the drill is
rehearsed before an incident rather than during one.

## Publish the internal Android build

Before building or updating the Web container, publish the latest internal APK:

```sh
npm run publish:android-internal
docker compose --env-file /path/to/private.env up -d --build web
```

The website download button uses the fixed path
`/downloads/missiongo-android-latest.apk`. The generated APK is intentionally
ignored by Git. It is included in the Web image built from the local checkout,
so run the publish command again whenever the Android SDK or validation host changes.
