package io.missiongo.android

import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.res.Configuration
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
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import io.missiongo.feedback.FeedbackOptions
import io.missiongo.feedback.FeedbackPriority
import io.missiongo.feedback.FeedbackResult
import io.missiongo.feedback.FeedbackType
import io.missiongo.feedback.MissionGo
import io.missiongo.feedback.WebViewFilePicker
import io.missiongo.feedback.WebViewSupport
import io.missiongo.android.widget.WidgetRefresher
import android.content.Context
import android.widget.Toast

class MainActivity : ComponentActivity() {
    private lateinit var webView: WebView
    private lateinit var loadingView: LinearLayout
    private lateinit var errorView: LinearLayout
    private lateinit var outdatedView: LinearLayout
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

    /**
     * Kept so onResume can re-arm it. The callback stands aside for one press to
     * let the system leave the app, and a device that keeps the activity alive
     * would otherwise come back with it still disabled.
     */
    private var backCallback: OnBackPressedCallback? = null

    /**
     * Set when a widget tap loads a page. The page it replaces is not somewhere
     * back should return to -- the person came from the home screen -- so its
     * history goes once the new page has loaded.
     */
    private var clearHistoryOnLoad = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Debug builds only: lets the WebView be inspected over adb while working
        // on the page it hosts. A release build is not debuggable, so this is off.
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
        filePicker = WebViewFilePicker(this, getString(R.string.choose_gallery), getString(R.string.choose_files))
        val content = buildContent()
        setContentView(content)
        fitInsideSystemBars(content)
        val backCallback = object : OnBackPressedCallback(true) {
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
                    // Stand aside for one press so the system does its default,
                    // then take the callback back. Leaving it disabled was a
                    // latch: on a device that keeps the activity alive when the
                    // task goes to the background -- back on a root activity
                    // does not always destroy it -- every later press bypassed
                    // the WebView, so the app left again the moment it was
                    // reopened warm, until it was force-stopped. See AND-28.
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                    isEnabled = true
                }
            }
        }
        onBackPressedDispatcher.addCallback(this, backCallback)
        this.backCallback = backCallback

        // Below the Chromium the pages are built for, loading them only shows a
        // blank screen or a connection error that is not true. Say what is wrong
        // and where to fix it instead (C5).
        val installed = WebViewSupport.installedChromiumMajor(this)
        if (installed != null && installed < WebViewSupport.MIN_CHROMIUM_MAJOR) {
            showOutdatedWebView(installed)
            return
        }

        // A launch from the recents list replays the intent it started with, so a
        // widget tap from hours ago would otherwise navigate again.
        val fromHistory = intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0
        val widgetLink = if (fromHistory) null else widgetDeepLink(intent)
        consumeWidgetExtras()
        when {
            widgetLink != null -> openMissionGo(widgetLink)
            savedInstanceState == null -> openMissionGo()
            else -> webView.restoreState(savedInstanceState)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // A widget tap cannot load a page this WebView is too old to run.
        if (outdatedView.visibility == View.VISIBLE) return
        val widgetLink = widgetDeepLink(intent) ?: return
        openMissionGo(widgetLink)
    }

    /**
     * The intent stays attached to the activity, and a recreation -- no longer
     * a rotation, which the manifest now handles in place, but still a switch
     * between light and dark -- replays it. Dropping the widget's extras once
     * they are acted on keeps that from loading the page again.
     */
    private fun consumeWidgetExtras() {
        if (!intent.hasExtra(EXTRA_WIDGET_TARGET)) return
        intent = Intent(intent).apply {
            removeExtra(EXTRA_WIDGET_TARGET)
            removeExtra(EXTRA_PRODUCT_ID)
            removeExtra(EXTRA_SESSION_ID)
            removeExtra(EXTRA_ATTENTION_ONLY)
        }
    }

    /**
     * From targetSdk 35 the window is edge-to-edge whether or not the app asks,
     * so the page ran up under the status bar and down under the gesture handle
     * (A8). The page's own `env(safe-area-inset-*)` cannot help: the WebView on
     * the devices checked reports those as zero. So the native side keeps the
     * WebView clear of the bars, the cutout and the keyboard -- which also does
     * what adjustResize no longer does edge-to-edge -- and paints the strips
     * behind the bars in the page's own background.
     *
     * The bars' icons follow the theme, because the platform default left them
     * white on the light background: the clock and battery all but vanished.
     */
    private fun fitInsideSystemBars(content: View) {
        ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, keyboard.bottom))
            WindowInsetsCompat.CONSUMED
        }
        val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        WindowCompat.getInsetsController(window, content).apply {
            isAppearanceLightStatusBars = !night
            isAppearanceLightNavigationBars = !night
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
            // Pinch-zoom stays off -- the console is an app shell, not a page to
            // pan around -- so the system font size is how someone enlarges text.
            settings.textZoom = WebViewSupport.textZoomFor(resources.configuration.fontScale)
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

        outdatedView = centeredMessage().apply {
            visibility = View.GONE
            addView(messageText(getString(R.string.webview_outdated_title), 20f).apply { id = R.id.webview_outdated_title })
            addView(messageText("", 14f).apply { id = R.id.webview_outdated_message })
            addView(Button(this@MainActivity).apply {
                text = getString(R.string.update_webview)
                isAllCaps = false
                setOnClickListener { WebViewSupport.openUpdate(this@MainActivity) }
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(16)
            })
        }
        addView(
            outdatedView,
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

    private fun openMissionGo(widgetLink: String? = null) {
        errorView.visibility = View.GONE
        loadingView.visibility = View.VISIBLE
        if (!MissionGoApplication.isConfiguredEndpoint(BuildConfig.MISSIONGO_ENDPOINT)) {
            showLoadError()
            return
        }
        clearHistoryOnLoad = widgetLink != null
        webView.loadUrl(widgetLink ?: (BuildConfig.MISSIONGO_ENDPOINT.trimEnd('/') + "/"))
    }

    private fun showOutdatedWebView(installed: Int) {
        loadingView.visibility = View.GONE
        errorView.visibility = View.GONE
        outdatedView.findViewById<TextView>(R.id.webview_outdated_message).text =
            getString(R.string.webview_outdated_message, installed, WebViewSupport.MIN_CHROMIUM_MAJOR)
        outdatedView.visibility = View.VISIBLE
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
            if (clearHistoryOnLoad) {
                clearHistoryOnLoad = false
                view.clearHistory()
            }
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

    /**
     * Rotating, folding and unfolding no longer recreate the activity (see the
     * manifest): recreation reloaded the page, and whatever was on screen went
     * with it. The WebView lays itself out again on its own; the font size is
     * the one thing it has to be told.
     */
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        if (::webView.isInitialized) webView.settings.textZoom = WebViewSupport.textZoomFor(newConfig.fontScale)
    }

    override fun onResume() {
        super.onResume()
        // Belt and braces for the latch above: whatever happened while the app
        // was away, back routes through the WebView again from here.
        backCallback?.isEnabled = true
    }

    override fun onStop() {
        super.onStop()
        // Leaving the app is when the widget is most likely out of date: whatever
        // was just handled here is still counted on it. Not on a rotation, which
        // stops and starts the activity without the person going anywhere.
        if (!isChangingConfigurations) WidgetRefresher.refreshInBackground(this)
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

    /** Where a widget tap should land (AND-149). */
    sealed interface WidgetTarget {
        /**
         * The Agent console, in [productId] because its views are per product.
         * [sessionId] opens one conversation; [attentionOnly] opens the
         * "needs attention" filter.
         */
        data class Console(val productId: String?, val sessionId: String?, val attentionOnly: Boolean) : WidgetTarget

        /** The item list's "ready" view, in [productId]. */
        data class ReadyItems(val productId: String?) : WidgetTarget
    }

    companion object {
        private const val TAG = "MissionGoAndroid"

        private const val EXTRA_WIDGET_TARGET = "io.missiongo.android.extra.WIDGET_TARGET"
        private const val EXTRA_PRODUCT_ID = "io.missiongo.android.extra.PRODUCT_ID"
        private const val EXTRA_SESSION_ID = "io.missiongo.android.extra.SESSION_ID"
        private const val EXTRA_ATTENTION_ONLY = "io.missiongo.android.extra.ATTENTION_ONLY"
        private const val TARGET_CONSOLE = "console"
        private const val TARGET_READY_ITEMS = "ready_items"

        /**
         * The intent a widget tap starts. A null [target] opens the app as the
         * launcher would. CLEAR_TOP with SINGLE_TOP hands it to the running
         * activity through onNewIntent instead of stacking a second copy.
         */
        fun openFromWidget(context: Context, target: WidgetTarget?): Intent =
            Intent(context, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                when (target) {
                    is WidgetTarget.Console -> {
                        putExtra(EXTRA_WIDGET_TARGET, TARGET_CONSOLE)
                        target.productId?.let { putExtra(EXTRA_PRODUCT_ID, it) }
                        target.sessionId?.let { putExtra(EXTRA_SESSION_ID, it) }
                        putExtra(EXTRA_ATTENTION_ONLY, target.attentionOnly)
                    }
                    is WidgetTarget.ReadyItems -> {
                        putExtra(EXTRA_WIDGET_TARGET, TARGET_READY_ITEMS)
                        target.productId?.let { putExtra(EXTRA_PRODUCT_ID, it) }
                    }
                    null -> Unit
                }
            }

        /**
         * The page a widget tap opens, built here from the tap's parts rather than
         * taken as a URL. The activity is exported, so any app can send it extras;
         * building the address from named parameters on the configured origin is
         * what keeps an intent from pointing the WebView anywhere else. The query
         * parameters are the ones apps/web/src/navigation.ts reads.
         */
        private fun widgetDeepLink(intent: Intent): String? {
            val target = intent.getStringExtra(EXTRA_WIDGET_TARGET) ?: return null
            val builder = Uri.parse(BuildConfig.MISSIONGO_ENDPOINT.trimEnd('/') + "/").buildUpon().clearQuery()
            intent.getStringExtra(EXTRA_PRODUCT_ID)?.let { builder.appendQueryParameter("product", it) }
            when (target) {
                TARGET_CONSOLE -> {
                    builder.appendQueryParameter("console", "agent")
                    if (intent.getBooleanExtra(EXTRA_ATTENTION_ONLY, false)) {
                        builder.appendQueryParameter("consoleFilter", "attention")
                    }
                    intent.getStringExtra(EXTRA_SESSION_ID)?.let { builder.appendQueryParameter("session", it) }
                }
                TARGET_READY_ITEMS -> builder.appendQueryParameter("status", "ready")
                else -> return null
            }
            return builder.build().toString()
        }
    }
}
