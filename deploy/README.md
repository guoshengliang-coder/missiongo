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

### Release-directory deployments

A long-lived deployment is easier to roll back if each version is its own
directory and a `current` symlink names the live one. `scripts/deploy.sh`
automates that, run from a workstation checkout rather than on the server:

```sh
./scripts/deploy.sh --host <ssh host> --env-file /etc/missiongo/production.env
```

It pushes a timestamped snapshot, backs up the database and attachments,
rebuilds, moves the symlink, publishes the Android APK, and reports container
status. The backup runs in a throwaway `node` container, so the server needs
neither Node nor a copy of these scripts already in place.

`rsync` does not read `.gitignore`, and does not read `.git/info/exclude` at
all, so the script lists its excludes explicitly. Keep local-only notes under
`.private/`, which it and `.dockerignore` both exclude.

Add `--verify <url>` to confirm afterwards that the new build is live and that a
forged `X-Forwarded-For` cannot reset the sign-in rate limit. It makes 11 failed
sign-in attempts, so aim it where that burns the caller's own bucket rather than
one shared by real visitors. Behind a CDN that rewrites `X-Forwarded-For` to the
real visitor address the public hostname does that; behind one that only appends,
use the origin, with `--verify-host` to supply the hostname.

### Publishing the Android download

The host proxy serves `/downloads/missiongo-android-latest.apk` from its own
directory rather than from the release snapshot, so that path outlives any one
release. The script publishes into it: it copies the APK to
`MissionGo-Android-<versionName>-<versionCode>.apk`, compares the sha256 of the
published file against the local build, and only then repoints
`missiongo-android-latest.apk` by creating a temporary link and renaming it over
the live one, so a download in flight never finds the link missing. A digest
that does not match removes the copy, leaves the link on the previous build, and
fails the deploy.

Published names carry the version, so `--keep` prunes them with a version-aware
sort — `0.1.10` ranks above `0.1.9` rather than below it — and the live APK is
never removed.

The download itself has a fixed name, so nothing in the file says which version
it holds. `npm run publish:android-internal` records that beside it in
`missiongo-android-latest.release`, and the deploy reads it. Publishing refuses
to guess: an APK with no metadata, or metadata whose sha256 no longer matches
the APK because something rebuilt it directly, stops the deploy **before**
anything is pushed, with `npm run publish:android-internal` as the fix.

`--downloads-dir` names that directory, defaulting to `/srv/missiongo/releases`.
Pass `--no-publish-apk` for a deployment that serves the download from the image
instead.

The APK itself is git-ignored, so a fresh clone cannot supply it. When the
checkout carries none, publishing is skipped with a note and the previous build
stays downloadable; run `npm run publish:android-internal` first to ship a new
one.

### Restricting the origin to a CDN

A CDN protects nothing if the origin also answers on its own address. Anyone who
learns it can bypass the CDN, and `CF-Connecting-IP` and similar headers become
forgeable, so they cannot be trusted to identify the visitor.

Allow only the CDN's published ranges plus loopback in the host proxy's server
block for this site, and have it replace `X-Forwarded-For` with the header the
CDN sets to the real visitor address rather than appending to it. Sign-in rate
limiting then counts per visitor instead of per CDN edge, and a forged entry
never reaches the application. Refresh the ranges when the CDN publishes changes.

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
so run the publish command again whenever the Android SDK or validation host
changes.

When deploying with `scripts/deploy.sh`, publish the APK before the deploy: the
script ships whatever the checkout holds and publishes it to the host download
directory, so a stale APK ships as the public download just as readily as a
fresh one.
