package io.missiongo.android

import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
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
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import io.missiongo.feedback.FeedbackOptions
import io.missiongo.feedback.FeedbackPriority
import io.missiongo.feedback.FeedbackResult
import io.missiongo.feedback.FeedbackType
import io.missiongo.feedback.MissionGo
import io.missiongo.feedback.WebViewFilePicker
import android.widget.Toast

class MainActivity : ComponentActivity() {
    private lateinit var webView: WebView
    private lateinit var loadingView: LinearLayout
    private lateinit var errorView: LinearLayout
    // Registered in onCreate: activity results have to be registered before the
    // activity is started, and the labels need a context that only exists then.
    private lateinit var filePicker: WebViewFilePicker

    /**
     * How many of its own history entries the page says it can unwind. Written
     * from the JavaScript bridge thread and read when back is pressed, which is
     * why it is volatile. Starts at zero, so a page that never reports -- an
     * older build, or one that failed to load -- behaves exactly as before.
     */
    @Volatile private var backDepth = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Debug builds only: lets the WebView be inspected over adb while working
        // on the page it hosts. A release build is not debuggable, so this is off.
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
        filePicker = WebViewFilePicker(this, getString(R.string.choose_gallery), getString(R.string.choose_files))
        setContentView(buildContent())
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // The page's own levels first, and only it can walk them --
                // canGoBack() does not count history.pushState entries and
                // goBack() does not move through them. Measured on an API 36
                // emulator: two pushes gave history.length 3, canGoBack() false,
                // goBack() inert, and history.back() correct. Trusting
                // canGoBack() is what closed the app from the capture sheet and
                // from an item detail. See AND-28.
                if (backDepth > 0) {
                    webView.evaluateJavascript("history.back()", null)
                } else if (webView.canGoBack()) {
                    // Still consulted, for a real navigation away from the app's
                    // own pages -- the page's counter says nothing about those.
                    webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })

        if (savedInstanceState == null) {
            openMissionGo()
        } else {
            webView.restoreState(savedInstanceState)
        }
    }

    private fun buildContent(): View {
        val webContainer = FrameLayout(this).apply {
            setBackgroundColor(getColor(R.color.missiongo_surface))

        webView = WebView(this@MainActivity).apply {
            setBackgroundColor(getColor(R.color.missiongo_surface))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = true
            settings.setSupportZoom(false)
            settings.mediaPlaybackRequiresUserGesture = true
            settings.userAgentString = "${settings.userAgentString} MissionGoAndroid/${BuildConfig.VERSION_NAME}"

            CookieManager.getInstance().setAcceptCookie(true)
            CookieManager.getInstance().setAcceptThirdPartyCookies(this, false)

            // The page asks for the native feedback flow through this, which is
            // what lets the entry point live in the web sidebar instead of a
            // permanent bar across the bottom of every screen.
            addJavascriptInterface(FeedbackBridge(), "MissionGoAndroid")
            webViewClient = MissionGoWebViewClient()
            webChromeClient = object : WebChromeClient() {

                override fun onShowFileChooser(
                    webView: WebView,
                    filePathCallback: ValueCallback<Array<Uri>>,
                    fileChooserParams: FileChooserParams,
                ): Boolean {
                    return filePicker.onShowFileChooser(filePathCallback, fileChooserParams)
                }
            }
        }
        addView(
            webView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )

        loadingView = centeredMessage().apply {
            addView(ProgressBar(this@MainActivity))
            addView(messageText(getString(R.string.loading_message)))
        }
        addView(
            loadingView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )

        errorView = centeredMessage().apply {
            visibility = View.GONE
            addView(messageText(getString(R.string.load_error_title), 20f))
            addView(messageText(getString(R.string.load_error_message), 14f))
            addView(Button(this@MainActivity).apply {
                text = getString(R.string.retry)
                isAllCaps = false
                setOnClickListener { openMissionGo() }
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(16)
            })
        }
        addView(
            errorView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )
        }
        return webContainer
    }

    /**
     * Exposed to the page as `MissionGoAndroid`. addJavascriptInterface hands the
     * object to every document the WebView loads, so the call is only honoured
     * when the page asking is the configured MissionGo origin. The host is read
     * on the UI thread, because WebView.getUrl() may only be touched there and it
     * is the value the check depends on.
     */
    private inner class FeedbackBridge {
        @JavascriptInterface
        fun openFeedback() {
            runOnUiThread {
                if (isMissionGoPage()) openSdkFeedback()
                else Log.w(TAG, "Ignored a feedback request from ${webView.url}")
            }
        }

        /**
         * How many levels the page can unwind before back should leave the app.
         * Reported on every history change rather than asked for on the press,
         * because back is dispatched synchronously and evaluateJavascript is not.
         */
        @JavascriptInterface
        fun setBackDepth(depth: Int) {
            runOnUiThread {
                if (isMissionGoPage()) {
                    backDepth = depth.coerceAtLeast(0)
                } else {
                    Log.w(TAG, "Ignored a back-depth report from ${webView.url}")
                }
            }
        }

        /** Whether the page may offer to clear the gallery copies after uploading. */
        @JavascriptInterface
        fun supportsMediaDeletion(): Boolean = filePicker.supportsMediaDeletion()

        @JavascriptInterface
        fun deletePickedMedia() {
            runOnUiThread {
                if (!isMissionGoPage()) {
                    Log.w(TAG, "Ignored a delete request from ${webView.url}")
                    return@runOnUiThread
                }
                filePicker.deletePickedMedia { deleted ->
                    if (deleted) {
                        Toast.makeText(this@MainActivity, getString(R.string.media_deleted), Toast.LENGTH_SHORT).show()
                    }
                }
            }
        }
    }

    private fun isMissionGoPage(): Boolean {
        val home = Uri.parse(BuildConfig.MISSIONGO_ENDPOINT)
        val current = webView.url?.let(Uri::parse) ?: return false
        return current.scheme == "https" && current.host == home.host
    }

    private fun openSdkFeedback() {
        runCatching {
            MissionGo.openFeedback(
                this,
                FeedbackOptions(
                    title = "MissionGo Android 使用反馈",
                    type = FeedbackType.Bug,
                    priority = FeedbackPriority.Normal,
                    context = mapOf("hostApp" to "MissionGo", "entry" to "web_sidebar"),
                ),
            ) { result ->
                when (result) {
                    is FeedbackResult.Submitted -> Toast.makeText(
                        this,
                        getString(R.string.feedback_submitted, result.submission.itemKey),
                        Toast.LENGTH_LONG,
                    ).show()
                    is FeedbackResult.Failed -> Toast.makeText(
                        this,
                        getString(R.string.feedback_failed, result.message),
                        Toast.LENGTH_LONG,
                    ).show()
                    FeedbackResult.Cancelled -> Unit
                }
            }
        }.onFailure { error ->
            Toast.makeText(
                this,
                getString(R.string.feedback_failed, error.message ?: getString(R.string.unknown_error)),
                Toast.LENGTH_LONG,
            ).show()
        }
    }

    private fun centeredMessage(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER
        setPadding(dp(32), dp(32), dp(32), dp(32))
        setBackgroundColor(getColor(R.color.missiongo_surface))
    }

    private fun messageText(value: String, size: Float = 14f): TextView = TextView(this).apply {
        text = value
        textSize = size
        gravity = Gravity.CENTER
        setTextColor(getColor(R.color.missiongo_ink))
        setPadding(0, dp(12), 0, 0)
    }

    private fun openMissionGo() {
        errorView.visibility = View.GONE
        loadingView.visibility = View.VISIBLE
        if (!MissionGoApplication.isConfiguredEndpoint(BuildConfig.MISSIONGO_ENDPOINT)) {
            showLoadError()
            return
        }
        webView.loadUrl(BuildConfig.MISSIONGO_ENDPOINT.trimEnd('/') + "/")
    }

    private fun showLoadError() {
        loadingView.visibility = View.GONE
        errorView.visibility = View.VISIBLE
    }

    private fun openExternal(uri: Uri): Boolean = try {
        startActivity(Intent(Intent.ACTION_VIEW, uri))
        true
    } catch (_: ActivityNotFoundException) {
        false
    }

    private inner class MissionGoWebViewClient : WebViewClient() {
        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            // The count belongs to the document being replaced. The new one
            // reports as soon as it mounts; until then there is nothing to pop.
            backDepth = 0
            errorView.visibility = View.GONE
            loadingView.visibility = View.VISIBLE
        }

        /**
         * The first frame the page actually paints. This is where the native
         * loader hands over.
         *
         * It used to hide on `onPageFinished` and on progress reaching 100, both
         * of which fire while the page still has nothing on screen -- the shell
         * is drawn from JavaScript that has not run yet. The spinner therefore
         * disappeared into a blank screen, and the visitor watched nothing at all
         * until the console appeared.
         */
        override fun onPageCommitVisible(view: WebView, url: String?) {
            loadingView.visibility = View.GONE
        }

        override fun onPageFinished(view: WebView, url: String?) {
            // Not the handover -- see onPageCommitVisible. Kept as a backstop for
            // a load that finishes without ever committing a frame, so the
            // spinner cannot outlive the page.
            loadingView.visibility = View.GONE
            CookieManager.getInstance().flush()
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val uri = request.url
            val home = Uri.parse(BuildConfig.MISSIONGO_ENDPOINT)
            return if (uri.scheme in setOf("http", "https") && uri.host == home.host) {
                false
            } else {
                openExternal(uri)
            }
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) {
                Log.e(TAG, "MissionGo page failed: code=${error.errorCode}, description=${error.description}, url=${request.url}")
                showLoadError()
            }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        webView.saveState(outState)
        super.onSaveInstanceState(outState)
    }

    override fun onDestroy() {
        if (::filePicker.isInitialized) filePicker.dispose()
        webView.apply {
            stopLoading()
            webChromeClient = null
            webViewClient = WebViewClient()
            destroy()
        }
        super.onDestroy()
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private companion object {
        const val TAG = "MissionGoAndroid"
    }
}
