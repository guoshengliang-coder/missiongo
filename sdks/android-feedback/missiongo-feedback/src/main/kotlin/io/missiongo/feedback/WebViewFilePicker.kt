package io.missiongo.feedback

import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.ContentUris
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import java.io.File
import java.security.MessageDigest
import android.util.Log
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import androidx.activity.ComponentActivity
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider

/**
 * The file chooser a WebView asks for, plus an offer to clear the screenshots
 * afterwards.
 *
 * Both MissionGo screens are a WebView that uploads screenshots, so both needed
 * the same chooser and both had their own copy of it. Construct this as a field
 * of the activity: it registers activity results, which has to happen before the
 * activity is started.
 */
class WebViewFilePicker(
    private val activity: ComponentActivity,
    private val galleryChoiceLabel: String,
    private val fileChoiceLabel: String,
) {
    private var callback: ValueCallback<Array<Uri>>? = null
    @Volatile private var pickedMedia: List<Uri> = emptyList()
    private var deletionListener: ((Boolean) -> Unit)? = null

    // Where the camera is writing right now. ACTION_IMAGE_CAPTURE reports success
    // with an empty result and puts the photo at the Uri it was handed, so the
    // destination has to survive until the result comes back.
    private var pendingCapture: Pair<Uri, File>? = null

    private val cameraLauncher =
        activity.registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val capture = pendingCapture
            pendingCapture = null
            // Not fromGallery: this photo was written into our own cache, so there
            // is no gallery copy to offer to clear -- and nothing to delete.
            if (result.resultCode == Activity.RESULT_OK && capture != null && capture.second.length() > 0) {
                complete(arrayOf(capture.first), fromGallery = false)
            } else {
                capture?.second?.delete()
                complete(null, fromGallery = false)
            }
        }

    private val documentLauncher =
        activity.registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val uris = if (result.resultCode == Activity.RESULT_OK) {
                result.data?.clipData?.let { clips -> Array(clips.itemCount) { clips.getItemAt(it).uri } }
                    ?: result.data?.data?.let { arrayOf(it) }
            } else {
                null
            }
            complete(uris, fromGallery = false)
        }
    private val singleMediaPicker =
        activity.registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
            complete(uri?.let { arrayOf(it) }, fromGallery = true)
        }
    private val multipleMediaPicker =
        activity.registerForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(MAX_MEDIA)) { uris ->
            complete(uris.takeIf { it.isNotEmpty() }?.toTypedArray(), fromGallery = true)
        }
    private val deleteConfirmation =
        activity.registerForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { result ->
            val deleted = result.resultCode == Activity.RESULT_OK
            if (deleted) pickedMedia = emptyList()
            deletionListener?.invoke(deleted)
            deletionListener = null
        }
    private val mediaPermissions =
        activity.registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
            if (granted.values.any { it }) requestDeletion() else finishDeletion(false)
        }

    /** Hands the chooser to the page. Returns false when nothing could be opened. */
    fun onShowFileChooser(
        filePathCallback: ValueCallback<Array<Uri>>,
        params: WebChromeClient.FileChooserParams,
    ): Boolean {
        callback?.onReceiveValue(null)
        callback = filePathCallback

        val acceptedTypes = params.acceptTypes
            .flatMap { it.split(',') }
            .map(String::trim)
            .filter(String::isNotBlank)
        val acceptsImages = acceptedTypes.any { it.startsWith("image/") }
        val acceptsVideos = acceptedTypes.any { it.startsWith("video/") }
        val acceptsOnlyMedia = acceptedTypes.isNotEmpty() && acceptedTypes.all {
            it.startsWith("image/") || it.startsWith("video/")
        }

        // What the page actually asked for. A "take a photo" button is
        // <input capture>, and reading acceptTypes alone made image/* mean the
        // photo picker -- so the camera button opened the gallery. Falls through
        // to the pickers below when there is no camera to open. See AND-31.
        if (params.isCaptureEnabled && acceptsImages && launchCamera()) return true

        return try {
            if (acceptsOnlyMedia) {
                launchMediaPicker(acceptsImages, acceptsVideos, params.mode)
            } else if (acceptsImages || acceptsVideos) {
                AlertDialog.Builder(activity)
                    .setItems(arrayOf(galleryChoiceLabel, fileChoiceLabel)) { _, choice ->
                        runCatching {
                            if (choice == 0) launchMediaPicker(acceptsImages, acceptsVideos, params.mode)
                            else launchDocumentPicker(acceptedTypes, params.mode)
                        }.onFailure { complete(null, fromGallery = false) }
                    }
                    .setOnCancelListener { complete(null, fromGallery = false) }
                    .show()
            } else {
                launchDocumentPicker(acceptedTypes, params.mode)
            }
            true
        } catch (_: ActivityNotFoundException) {
            complete(null, fromGallery = false)
            false
        }
    }

    /**
     * True when this build can offer to remove the gallery copies at all. The
     * delete request arrived in API 30, and the host app has to declare the
     * media permissions itself: the SDK will not force them on an app that has
     * no use for the offer. Safe to call from any thread.
     */
    fun supportsMediaDeletion(): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && declaredPermissions().isNotEmpty()

    /**
     * Asks the system to delete the gallery copies of what was just uploaded.
     * The user confirms in a system dialog, and nothing is deleted without it.
     */
    fun deletePickedMedia(onDone: (Boolean) -> Unit) {
        if (!supportsMediaDeletion() || pickedMedia.isEmpty()) {
            onDone(false)
            return
        }
        deletionListener = onDone
        val missing = declaredPermissions().filter {
            activity.checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED
        }
        // Reading the store is what makes the match below possible, so without it
        // there is no safe way to tell which row a picked file is.
        if (missing.isEmpty()) requestDeletion() else mediaPermissions.launch(missing.toTypedArray())
    }

    /** Drops any pending callback. Call from the activity's onDestroy. */
    fun dispose() {
        // A capture the activity did not live long enough to receive. The file is
        // empty and nothing else knows about it.
        pendingCapture?.second?.delete()
        pendingCapture = null
        callback?.onReceiveValue(null)
        callback = null
        deletionListener = null
    }

    private fun requestDeletion() {
        val targets = pickedMedia.mapNotNull(::mediaStoreUriFor)
        if (targets.isEmpty()) {
            Log.w(TAG, "None of the picked files could be matched to a gallery entry.")
            finishDeletion(false)
            return
        }
        try {
            val request = MediaStore.createDeleteRequest(activity.contentResolver, targets)
            deleteConfirmation.launch(IntentSenderRequest.Builder(request.intentSender).build())
        } catch (error: Exception) {
            Log.w(TAG, "The system refused a delete request: ${error.message}")
            finishDeletion(false)
        }
    }

    private fun finishDeletion(deleted: Boolean) {
        deletionListener?.invoke(deleted)
        deletionListener = null
    }

    /**
     * The photo picker hands back a one-off read grant, not a gallery row, and
     * nothing maps one to the other. The id in the last path segment is the only
     * lead, and it cannot be trusted on its own, so the candidate row is accepted
     * only when it holds byte for byte the file that was actually read: deleting
     * the wrong photo is not a mistake worth risking for a convenience.
     *
     * Names cannot do this job — the picker renames what it hands over to
     * "<id>.png" precisely so the real filename stays private.
     */
    private fun mediaStoreUriFor(picked: Uri): Uri? {
        if (picked.authority == MediaStore.AUTHORITY && picked.pathSegments.firstOrNull() == "external") return picked
        val id = runCatching { ContentUris.parseId(picked) }.getOrNull() ?: return null
        val identity = identityOf(picked) ?: return null
        val collection = if (activity.contentResolver.getType(picked)?.startsWith("video/") == true) {
            MediaStore.Video.Media.EXTERNAL_CONTENT_URI
        } else {
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        }
        val candidate = ContentUris.withAppendedId(collection, id)
        return if (identityOf(candidate) == identity) candidate else null
    }

    private fun identityOf(uri: Uri): String? = runCatching {
        val digest = MessageDigest.getInstance("SHA-256")
        var total = 0L
        activity.contentResolver.openInputStream(uri)?.use { stream ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = stream.read(buffer)
                if (read <= 0) break
                total += read
                digest.update(buffer, 0, read)
                // A video can be large, and the whole point is to identify the
                // file, not to checksum it: the head plus the length is already
                // far past coincidence.
                if (total >= MAX_IDENTITY_BYTES) break
            }
        } ?: return@runCatching null
        if (total == 0L) null else "$total/" + digest.digest().joinToString("") { "%02x".format(it) }
    }.getOrNull()

    private fun declaredPermissions(): List<String> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return emptyList()
        val declared = runCatching {
            activity.packageManager
                .getPackageInfo(activity.packageName, PackageManager.GET_PERMISSIONS)
                .requestedPermissions
                ?.toSet()
                ?: emptySet()
        }.getOrDefault(emptySet())
        return MEDIA_PERMISSIONS.filter { it in declared }
    }

    /**
     * Opens the camera onto a file of our own. Returns false when it could not
     * be started, so the caller can fall back to the pickers -- a device with no
     * camera app should still be able to attach a screenshot.
     *
     * The photo lands in the app's cache rather than the gallery: the SDK's whole
     * offer to clear gallery copies exists because uploads should not leave a
     * trail in the user's photos, and a capture that goes straight to the report
     * never creates one.
     */
    private fun launchCamera(): Boolean {
        val target = runCatching {
            val directory = File(activity.cacheDir, CAPTURE_DIRECTORY).apply { mkdirs() }
            val file = File(directory, "capture-${System.currentTimeMillis()}.jpg")
            val authority = "${activity.packageName}.$FILE_PROVIDER_SUFFIX"
            FileProvider.getUriForFile(activity, authority, file) to file
        }.getOrElse { error ->
            // Almost always the provider missing from a host that overrode the
            // merged manifest. Worth a line, because the symptom downstream is
            // just "the camera button opens the gallery".
            Log.w(TAG, "No camera destination could be prepared: ${error.message}")
            return false
        }

        val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
            .putExtra(MediaStore.EXTRA_OUTPUT, target.first)
            // The camera app is a different process and needs to be let in to the
            // file explicitly; the contract does not do this for us.
            .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        return try {
            pendingCapture = target
            cameraLauncher.launch(intent)
            true
        } catch (_: ActivityNotFoundException) {
            pendingCapture = null
            target.second.delete()
            false
        }
    }

    private fun launchMediaPicker(acceptsImages: Boolean, acceptsVideos: Boolean, mode: Int) {
        val mediaType = when {
            acceptsImages && acceptsVideos -> ActivityResultContracts.PickVisualMedia.ImageAndVideo
            acceptsVideos -> ActivityResultContracts.PickVisualMedia.VideoOnly
            else -> ActivityResultContracts.PickVisualMedia.ImageOnly
        }
        val request = PickVisualMediaRequest(mediaType)
        if (mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
            multipleMediaPicker.launch(request)
        } else {
            singleMediaPicker.launch(request)
        }
    }

    private fun launchDocumentPicker(acceptedTypes: List<String>, mode: Int) {
        val mimeTypes = acceptedTypes.filter { '/' in it && !it.startsWith("image/") && !it.startsWith("video/") }
        documentLauncher.launch(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = mimeTypes.firstOrNull() ?: "*/*"
            if (mimeTypes.size > 1) putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes.toTypedArray())
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE)
        })
    }

    private fun complete(uris: Array<Uri>?, fromGallery: Boolean) {
        pickedMedia = if (fromGallery) uris?.toList().orEmpty() else emptyList()
        callback?.onReceiveValue(uris)
        callback = null
    }

    private companion object {
        const val TAG = "MissionGoFeedback"
        const val MAX_MEDIA = 10
        // Must match the authority and the cache-path in the SDK's manifest and
        // res/xml/missiongo_feedback_file_paths.xml.
        const val FILE_PROVIDER_SUFFIX = "missiongofeedback.fileprovider"
        const val CAPTURE_DIRECTORY = "missiongo-captures"
        const val MAX_IDENTITY_BYTES = 8L * 1024 * 1024
        val MEDIA_PERMISSIONS = listOf(
            "android.permission.READ_MEDIA_IMAGES",
            "android.permission.READ_MEDIA_VIDEO",
        )
    }
}
