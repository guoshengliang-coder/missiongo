package io.missiongo.android

import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
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
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import io.missiongo.feedback.FeedbackOptions
import io.missiongo.feedback.FeedbackPriority
import io.missiongo.feedback.FeedbackResult
import io.missiongo.feedback.FeedbackType
import io.missiongo.feedback.MissionGo
import android.widget.Toast

class MainActivity : ComponentActivity() {
    private lateinit var webView: WebView
    private lateinit var loadingView: LinearLayout
    private lateinit var errorView: LinearLayout
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
        setContentView(buildContent())
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
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
            setBackgroundColor(Color.rgb(251, 250, 247))

        webView = WebView(this@MainActivity).apply {
            setBackgroundColor(Color.rgb(251, 250, 247))
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
                override fun onProgressChanged(view: WebView, newProgress: Int) {
                    if (newProgress >= 100) loadingView.visibility = View.GONE
                }

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
                val home = Uri.parse(BuildConfig.MISSIONGO_ENDPOINT)
                val current = webView.url?.let(Uri::parse)
                if (current?.scheme == "https" && current.host == home.host) {
                    openSdkFeedback()
                } else {
                    Log.w(TAG, "Ignored a feedback request from ${current?.host}")
                }
            }
        }
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
                    .setItems(arrayOf(getString(R.string.choose_gallery), getString(R.string.choose_files))) { _, choice ->
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
        setBackgroundColor(Color.rgb(251, 250, 247))
    }

    private fun messageText(value: String, size: Float = 14f): TextView = TextView(this).apply {
        text = value
        textSize = size
        gravity = Gravity.CENTER
        setTextColor(Color.rgb(23, 32, 51))
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
            errorView.visibility = View.GONE
            loadingView.visibility = View.VISIBLE
        }

        override fun onPageFinished(view: WebView, url: String?) {
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
        fileChooserCallback?.onReceiveValue(null)
        fileChooserCallback = null
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
