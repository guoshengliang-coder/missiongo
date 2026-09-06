# MissionGo Android Feedback SDK

The Android SDK captures a small, explicit feedback snapshot from a host app and submits it through a product-scoped MissionGo SDK token.

**Integrating this SDK into a host app?** Read [`INTEGRATION.md`](INTEGRATION.md) — it is the
self-contained contract, published for host developers and coding agents at
`<origin>/downloads/missiongo-android-sdk/INTEGRATION.md`. Everything below is for people
working on the SDK itself.

The current `0.2.0` release includes:

- Android application, version, OS, device, locale, time-zone, ABI, and display-density collection;
- host-provided screen, context, log, breadcrumb, and exception data;
- bounded in-memory logs that preserve host-provided diagnostic text;
- idempotent server drafts and idempotent work-item finalization;
- a draft-scoped 15-minute Web session and `openFeedback(Activity)` H5 editor;
- H5 image, video, and log attachment upload with partial-failure retry;
- bounded exponential retry for transient network, 408, 429, and 5xx failures;
- 24-hour app-private, no-backup recovery snapshots for the interactive editor;
- submitted, cancelled, and terminal-failure callbacks;
- WorkManager-backed headless delivery with connected-network constraints;
- origin-scoped IndexedDB recovery for explicitly selected H5 attachments;
- a sample APK, a publishable release AAR, and static Maven distribution from the website.

The interactive editor and queued headless submissions can recover after process recreation. Queue status notifications and optional screen capture remain later milestones.

## Build

```bash
./gradlew :missiongo-feedback:testDebugUnitTest
./gradlew :missiongo-feedback:assembleRelease
./gradlew :sample:assembleDebug
./gradlew :missiongo-validation-app:assembleDebug
./gradlew :missiongo-validation-app:assembleRelease
./gradlew :missiongo-feedback:publishToMavenLocal
```

The release AAR is written below `missiongo-feedback/build/outputs/aar/`. Generated build output is ignored by Git.

Remote private Maven publication is enabled only when `missiongoMavenUrl` (or `MISSIONGO_MAVEN_URL`) is supplied. Credentials come from similarly named Gradle properties or environment variables and must never be committed.

## Local sample configuration

Keep real configuration outside the repository:

```properties
# ~/.gradle/gradle.properties
missiongoSampleEndpoint=https://missiongo.example.invalid
missiongoSampleToken=mg_sdk_replace_with_a_locally_issued_token
```

See [the host integration guide](INTEGRATION.md), [the maintainer-facing walkthrough](../../docs/android-sdk/getting-started.md) and [data collection rules](../../docs/android-sdk/data-collection.md).

The repository-level MissionGo validation host lives in [`apps/android`](../../apps/android). It uses a direct Gradle project dependency on `:missiongo-feedback`; see the [validation checklist](../../docs/android-sdk/validation-app.md).
