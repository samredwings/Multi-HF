package com.samredwings.multihf

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.webkit.WebViewAssetLoader

class MainActivity : ComponentActivity() {
    private lateinit var webView: WebView
    private lateinit var assetLoader: WebViewAssetLoader
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private val appHost = "appassets.androidplatform.net"
    private val filePicker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val selected = if (result.resultCode == RESULT_OK) result.data?.data?.let { arrayOf(it) } else null
        fileChooserCallback?.onReceiveValue(selected)
        fileChooserCallback = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (::webView.isInitialized && webView.canGoBack()) webView.goBack() else finish()
            }
        })
        // Map the packaged assets root to the same URL paths used by index.html
        // (for example /src/app.js and /src/styles.css).
        assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        webView = WebView(this)
        webView.layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        )
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.allowFileAccess = false
        webView.settings.allowContentAccess = true
        webView.settings.javaScriptCanOpenWindowsAutomatically = false
        webView.settings.setSupportMultipleWindows(false)
        webView.setBackgroundColor(android.graphics.Color.rgb(13, 17, 23))
        // <a download> links hand off to the system browser/download manager.
        webView.setDownloadListener { url, _, _, _, _ ->
            val uri = Uri.parse(url)
            if (uri.scheme == "https") openExternal(uri)
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest) =
                assetLoader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest): Boolean {
                val uri = request.url
                if (uri.host == appHost && uri.scheme == "https") return false
                if (uri.scheme == "https" || uri.scheme == "http") {
                    openExternal(uri)
                    return true
                }
                return true
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                this@MainActivity.fileChooserCallback?.onReceiveValue(null)
                this@MainActivity.fileChooserCallback = filePathCallback
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                    putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("image/*", "video/*", "audio/*", "application/octet-stream"))
                }
                return try {
                    filePicker.launch(intent)
                    true
                } catch (_: ActivityNotFoundException) {
                    this@MainActivity.fileChooserCallback = null
                    Toast.makeText(this@MainActivity, "No file picker is available on this device.", Toast.LENGTH_LONG).show()
                    false
                }
            }
        }
        setContentView(webView)
        if (savedInstanceState == null) {
            webView.loadUrl("https://$appHost/index.html")
        } else {
            webView.restoreState(savedInstanceState)
        }
    }

    private fun openExternal(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, "No app can open this link.", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        webView.saveState(outState)
        super.onSaveInstanceState(outState)
    }

    override fun onDestroy() {
        fileChooserCallback?.onReceiveValue(null)
        fileChooserCallback = null
        if (::webView.isInitialized) {
            (webView.parent as? ViewGroup)?.removeView(webView)
            webView.stopLoading()
            webView.destroy()
        }
        super.onDestroy()
    }
}
