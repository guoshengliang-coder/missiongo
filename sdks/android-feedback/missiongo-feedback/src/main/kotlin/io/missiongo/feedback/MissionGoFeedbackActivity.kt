package io.missiongo.feedback

import android.annotation.SuppressLint
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
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
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/** Internal activity hosting only the configured MissionGo origin. */
public class MissionGoFeedbackActivity : ComponentActivity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var webView: WebView? = null
    /** The origin the editor was opened on; the bridge only answers pages from it. */
    private var editorOrigin: Uri? = null
    private var launchId: String? = null
    private var completed = false
    private var lastFailure: MissionGoException? = null
    private var loadingOverlay: View? = null
    private val filePicker = WebViewFilePicker(this, "从图库选择图片或视频", "选择日志或其他文件")

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
        editorOrigin = origin
        val sessionToken = requireNotNull(session.token)
        val editor = WebView(this).apply {
            setBackgroundColor(themeColor(android.R.attr.colorBackground))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = true
            settings.setSupportMultipleWindows(false)
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            // The form is a page on the configured endpoint, and this is how it
            // offers to clear the gallery copies of what it just uploaded.
            addJavascriptInterface(MediaBridge(), "MissionGoAndroid")
            webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(
                    webView: WebView,
                    filePathCallback: ValueCallback<Array<Uri>>,
                    fileChooserParams: FileChooserParams,
                ): Boolean {
                    return filePicker.onShowFileChooser(filePathCallback, fileChooserParams)
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

    // Resolved from the theme rather than written as a literal, so the pre-H5 screens follow
    // the light/dark variant the system picked (see res/values-night/themes.xml).
    private fun themeColor(attribute: Int): Int {
        val resolved = android.util.TypedValue()
        theme.resolveAttribute(attribute, resolved, true)
        return if (resolved.resourceId != 0) {
            @Suppress("DEPRECATION")
            resources.getColor(resolved.resourceId, theme)
        } else {
            resolved.data
        }
    }

    private fun loadingContent(): LinearLayout {
        val density = resources.displayMetrics.density
        val spacing = (12 * density).toInt()
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(spacing * 2, spacing * 2, spacing * 2, spacing * 2)
            setBackgroundColor(themeColor(android.R.attr.colorBackground))
            addView(ProgressBar(this@MissionGoFeedbackActivity), LinearLayout.LayoutParams(
                (44 * density).toInt(),
                (44 * density).toInt(),
            ).apply { gravity = Gravity.CENTER_HORIZONTAL })
            addView(TextView(this@MissionGoFeedbackActivity).apply {
                text = "正在打开反馈页面…"
                textSize = 16f
                setTextColor(themeColor(android.R.attr.textColorPrimary))
                gravity = Gravity.CENTER
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                gravity = Gravity.CENTER_HORIZONTAL
                topMargin = spacing
            })
            addView(TextView(this@MissionGoFeedbackActivity).apply {
                text = "正在安全地准备运行环境和反馈表单"
                textSize = 12f
                setTextColor(themeColor(android.R.attr.textColorSecondary))
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
                FeedbackResult.Failed(
                    failure.code,
                    failure.message ?: "Could not submit feedback.",
                    failure.retryable,
                ),
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

    /**
     * Exposed to the form as `MissionGoAndroid`. addJavascriptInterface hands
     * this to every document the WebView loads, so both calls check that the
     * page asking is the endpoint the SDK was configured with.
     */
    private inner class MediaBridge {
        @JavascriptInterface
        fun supportsMediaDeletion(): Boolean = filePicker.supportsMediaDeletion()

        @JavascriptInterface
        fun deletePickedMedia() {
            runOnUiThread {
                if (!isConfiguredPage()) {
                    Log.w(LOG_TAG, "Ignored a delete request from ${webView?.url}")
                    return@runOnUiThread
                }
                filePicker.deletePickedMedia { deleted ->
                    if (deleted) Toast.makeText(this@MissionGoFeedbackActivity, "已从手机删除上传的截图", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    private fun isConfiguredPage(): Boolean {
        val endpoint = editorOrigin ?: return false
        val current = webView?.url?.let(Uri::parse) ?: return false
        return current.scheme == endpoint.scheme && current.host == endpoint.host && current.port == endpoint.port
    }

    override fun onDestroy() {
        scope.cancel()
        filePicker.dispose()
        destroyWebView()
        super.onDestroy()
    }

    private companion object {
        const val LOG_TAG = "MissionGoFeedback"
    }
}
