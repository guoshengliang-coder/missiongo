package io.missiongo.feedback

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceError
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/** Internal activity hosting only the configured MissionGo origin. */
public class MissionGoFeedbackActivity : ComponentActivity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var webView: WebView? = null
    private var launchId: String? = null
    private var completed = false
    private var lastFailure: MissionGoException? = null
    private var loadingOverlay: View? = null
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private val fileChooserLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val uris = if (result.resultCode == RESULT_OK) {
            result.data?.clipData?.let { clips ->
                Array(clips.itemCount) { clips.getItemAt(it).uri }
            } ?: result.data?.data?.let { arrayOf(it) }
        } else {
            null
        }
        completeFileSelection(uris)
    }
    private val singleMediaPicker = registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        completeFileSelection(uri?.let { arrayOf(it) })
    }
    private val multipleMediaPicker = registerForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(10)) { uris ->
        completeFileSelection(uris.takeIf { it.isNotEmpty() }?.toTypedArray())
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                cancelAndFinish()
            }
        })
        launchId = intent.getStringExtra("launchId")
        val available = runCatching { MissionGo.hasFeedbackLaunch(launchId) }.getOrDefault(false)
        if (!available) {
            showUnrecoverableError("The feedback draft could not be restored. Please open feedback again.")
            return
        }
        startEditor()
    }

    private fun startEditor() {
        val id = launchId ?: return
        destroyWebView()
        showLoading()
        scope.launch {
            runCatching { MissionGo.prepareFeedbackEditor(id) }
                .onSuccess { session ->
                    lastFailure = null
                    if (session.submittedItemKey != null) {
                        completeSubmission(session.draftId, session.submittedItemKey)
                        showSubmitted(session.submittedItemKey)
                    } else {
                        showEditor(session)
                    }
                }
                .onFailure { failure ->
                    val missionGoFailure = failure as? MissionGoException
                        ?: MissionGoException("unexpected_error", failure.message ?: "Could not open MissionGo feedback.", failure)
                    lastFailure = missionGoFailure
                    showRetryableError(missionGoFailure.message ?: "Could not open MissionGo feedback.")
                }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun showEditor(session: io.missiongo.feedback.internal.FeedbackEditorSession) {
        val origin = Uri.parse(session.endpoint)
        val sessionToken = requireNotNull(session.token)
        val editor = WebView(this).apply {
            setBackgroundColor(Color.WHITE)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = true
            settings.setSupportMultipleWindows(false)
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(
                    webView: WebView,
                    filePathCallback: ValueCallback<Array<Uri>>,
                    fileChooserParams: FileChooserParams,
                ): Boolean {
                    fileChooserCallback?.onReceiveValue(null)
                    fileChooserCallback = filePathCallback
                    return launchFileChooser(fileChooserParams)
                }
            }
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val target = request.url
                    if (target.scheme == "missiongo-feedback" && target.host == "close") {
                        finish()
                        return true
                    }
                    return target.scheme != origin.scheme || target.host != origin.host || target.port != origin.port
                }

                override fun onPageFinished(view: WebView, url: String) {
                    loadingOverlay?.visibility = View.GONE
                    val page = Uri.parse(url)
                    if (page.path == "/sdk/feedback/complete") {
                        page.getQueryParameter("item")?.takeIf(String::isNotBlank)?.let { itemKey ->
                            completeSubmission(session.draftId, itemKey)
                        }
                    }
                }

                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                    if (request.isForMainFrame) {
                        lastFailure = MissionGoException("webview_load_failed", error.description.toString())
                        showRetryableError(error.description.toString())
                    }
                }
            }
        }
        webView = editor
        val overlay = loadingContent()
        loadingOverlay = overlay
        setContentView(FrameLayout(this).apply {
            addView(editor, FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ))
            addView(overlay, FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ))
        })

        val secure = if (origin.scheme == "https") "; Secure" else ""
        val cookie = "missiongo_feedback_session=$sessionToken; Path=/api/v1/sdk; Max-Age=900; HttpOnly; SameSite=Strict$secure"
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setCookie(session.endpoint, cookie) {
                flush()
                editor.loadUrl("${session.endpoint}/sdk/feedback?draft=${Uri.encode(session.draftId)}")
            }
        }
    }

    private fun showLoading() {
        setContentView(loadingContent())
    }

    private fun loadingContent(): LinearLayout {
        val density = resources.displayMetrics.density
        val spacing = (12 * density).toInt()
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(spacing * 2, spacing * 2, spacing * 2, spacing * 2)
            setBackgroundColor(Color.rgb(243, 241, 235))
            addView(ProgressBar(this@MissionGoFeedbackActivity), LinearLayout.LayoutParams(
                (44 * density).toInt(),
                (44 * density).toInt(),
            ).apply { gravity = Gravity.CENTER_HORIZONTAL })
            addView(TextView(this@MissionGoFeedbackActivity).apply {
                text = "正在打开反馈页面…"
                textSize = 16f
                setTextColor(Color.rgb(23, 32, 51))
                gravity = Gravity.CENTER
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                gravity = Gravity.CENTER_HORIZONTAL
                topMargin = spacing
            })
            addView(TextView(this@MissionGoFeedbackActivity).apply {
                text = "正在安全地准备运行环境和反馈表单"
                textSize = 12f
                setTextColor(Color.rgb(109, 116, 129))
                gravity = Gravity.CENTER
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                gravity = Gravity.CENTER_HORIZONTAL
                topMargin = spacing / 2
            })
        }
    }

    private fun completeSubmission(draftId: String, itemKey: String) {
        if (completed) return
        completed = true
        launchId?.let { MissionGo.completeFeedbackLaunch(it, FeedbackResult.Submitted(FeedbackSubmission(draftId, itemKey))) }
    }

    private fun showSubmitted(itemKey: String) {
        setContentView(TextView(this).apply {
            text = "Feedback submitted\n$itemKey"
            textSize = 18f
            setPadding(48, 48, 48, 48)
        })
    }

    private fun showRetryableError(message: String) {
        destroyWebView()
        val padding = (24 * resources.displayMetrics.density).toInt()
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(padding, padding, padding, padding)
            addView(TextView(this@MissionGoFeedbackActivity).apply { text = message })
            addView(Button(this@MissionGoFeedbackActivity).apply {
                text = "Retry"
                setOnClickListener { startEditor() }
            }, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            addView(Button(this@MissionGoFeedbackActivity).apply {
                text = "Close"
                setOnClickListener { finishWithFailure() }
            }, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        })
    }

    private fun showUnrecoverableError(message: String) {
        setContentView(TextView(this).apply {
            text = message
            setPadding(48, 48, 48, 48)
        })
    }

    private fun finishWithFailure() {
        val id = launchId
        val failure = lastFailure
        if (id != null && failure != null) {
            MissionGo.completeFeedbackLaunch(
                id,
                FeedbackResult.Failed(failure.code, failure.message ?: "Could not submit feedback."),
            )
        }
        finish()
    }

    private fun cancelAndFinish() {
        if (!completed) {
            launchId?.let { MissionGo.completeFeedbackLaunch(it, FeedbackResult.Cancelled) }
        }
        finish()
    }

    private fun launchFileChooser(params: WebChromeClient.FileChooserParams): Boolean {
        val acceptedTypes = params.acceptTypes
            .flatMap { it.split(',') }
            .map(String::trim)
            .filter(String::isNotBlank)
        val acceptsImages = acceptedTypes.any { it.startsWith("image/") }
        val acceptsVideos = acceptedTypes.any { it.startsWith("video/") }
        val acceptsOnlyMedia = acceptedTypes.isNotEmpty() && acceptedTypes.all {
            it.startsWith("image/") || it.startsWith("video/")
        }

        return try {
            if (acceptsOnlyMedia) {
                launchMediaPicker(acceptsImages, acceptsVideos, params.mode)
            } else if (acceptsImages || acceptsVideos) {
                AlertDialog.Builder(this)
                    .setItems(arrayOf("从图库选择图片或视频", "选择日志或其他文件")) { _, choice ->
                        runCatching {
                            if (choice == 0) {
                                launchMediaPicker(acceptsImages, acceptsVideos, params.mode)
                            } else {
                                launchDocumentPicker(acceptedTypes, params.mode)
                            }
                        }.onFailure { completeFileSelection(null) }
                    }
                    .setOnCancelListener { completeFileSelection(null) }
                    .show()
            } else {
                launchDocumentPicker(acceptedTypes, params.mode)
            }
            true
        } catch (_: ActivityNotFoundException) {
            completeFileSelection(null)
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
        fileChooserLauncher.launch(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = mimeTypes.firstOrNull() ?: "*/*"
            if (mimeTypes.size > 1) putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes.toTypedArray())
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE)
        })
    }

    private fun completeFileSelection(uris: Array<Uri>?) {
        fileChooserCallback?.onReceiveValue(uris)
        fileChooserCallback = null
    }

    private fun destroyWebView() {
        loadingOverlay = null
        webView?.apply {
            stopLoading()
            clearHistory()
            webChromeClient = null
            removeAllViews()
            destroy()
        }
        webView = null
    }

    override fun onDestroy() {
        scope.cancel()
        completeFileSelection(null)
        destroyWebView()
        super.onDestroy()
    }
}
