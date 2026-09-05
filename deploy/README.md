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

The read-only MCP endpoint uses the same account system as the website. On first
connection, the AI client opens the MissionGo sign-in page, then stores a
time-limited OAuth grant. MissionGo rechecks that grant and the account's
product scope on every read; the AI client never receives the password.
Back up the entire directory configured by `MISSIONGO_DATA_PATH`; it contains
both the database and uploaded files.

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
