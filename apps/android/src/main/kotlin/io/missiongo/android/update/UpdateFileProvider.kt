package io.missiongo.android.update

import androidx.core.content.FileProvider

/**
 * The FileProvider the update download is shared through (AND-258).
 *
 * A subclass rather than `androidx.core.content.FileProvider` directly: the
 * feedback SDK already declares that class with its own authority
 * (`${applicationId}.missiongofeedback.fileprovider`), and the manifest merger
 * treats two providers with the same `android:name` as one entry to reconcile.
 * It refuses the app's authority outright rather than declaring a second
 * provider. A distinct class has its own name, so both providers coexist and
 * neither the SDK's camera hand-off nor this installer hand-off can weaken the
 * other's paths.
 */
class UpdateFileProvider : FileProvider()
