package com.samredwings.multihf

import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.res.ColorStateList
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.ConsoleMessage
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import android.widget.Button
import android.widget.LinearLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : ComponentActivity() {
    companion object { @Volatile private var crashHandlerInstalled = false }
    private lateinit var webView: WebView
    private lateinit var assetLoader: WebViewAssetLoader
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private val appHost = "appassets.androidplatform.net"
    private val diagnosticsPrefs by lazy { getSharedPreferences("multi_hf_diagnostics", MODE_PRIVATE) }
    private val diagnosticsLock = Any()
    private var pendingDebugReport: String? = null
    private val debugReportPicker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val report = pendingDebugReport
        pendingDebugReport = null
        val uri = if (result.resultCode == RESULT_OK) result.data?.data else null
        if (uri != null && report != null) {
            try {
                val output = contentResolver.openOutputStream(uri) ?: throw IllegalStateException("Could not open the selected file.")
                output.use { it.write(report.toByteArray(Charsets.UTF_8)) }
                Toast.makeText(this, "Debug report saved.", Toast.LENGTH_LONG).show()
            } catch (error: Exception) {
                Toast.makeText(this, "Could not save debug report: " + (error.message ?: "Storage error"), Toast.LENGTH_LONG).show()
            }
        }
    }
    private val filePicker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val selected = if (result.resultCode == RESULT_OK) {
            val data = result.data
            val uris = mutableListOf<Uri>()
            val clip = data?.clipData
            if (clip != null) {
                for (index in 0 until clip.itemCount) {
                    val uri = clip.getItemAt(index).uri
                    if (uri !in uris) uris.add(uri)
                }
            }
            data?.data?.let { if (it !in uris) uris.add(it) }
            uris.takeIf { it.isNotEmpty() }?.toTypedArray()
        } else null
        fileChooserCallback?.onReceiveValue(selected)
        fileChooserCallback = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        installCrashDiagnostics()
        recordNativeDiagnostic("lifecycle", "Android activity created.")
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

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                if (Uri.parse(url ?: "").host == appHost) {
                    val entries = nativeDiagnosticsSnapshot()
                    view?.evaluateJavascript("document.getElementById('export-debug-report')?.setAttribute('hidden','hidden'); window.MultiHFDiagnostics?.importNativeEntries($entries);", null)
                }
            }

            override fun onReceivedError(view: WebView?, request: WebResourceRequest, error: android.webkit.WebResourceError) {
                super.onReceivedError(view, request, error)
                if (request.isForMainFrame) {
                    recordNativeDiagnostic("webview_error", error.description?.toString() ?: "WebView main-frame load failed.", request.url.toString().substringBefore("?").substringBefore("#"))
                }
            }

            override fun onReceivedHttpError(view: WebView?, request: WebResourceRequest, errorResponse: android.webkit.WebResourceResponse) {
                super.onReceivedHttpError(view, request, errorResponse)
                if (request.isForMainFrame && errorResponse.statusCode >= 400) {
                    recordNativeDiagnostic("webview_http_error", "Main-frame HTTP ${errorResponse.statusCode} ${errorResponse.reasonPhrase ?: ""}", request.url.toString().substringBefore("?").substringBefore("#"))
                }
            }

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
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                val level = when (message.messageLevel()) {
                    ConsoleMessage.MessageLevel.ERROR -> "console_error"
                    ConsoleMessage.MessageLevel.WARNING -> "console_warning"
                    else -> return true
                }
                recordNativeDiagnostic(level, message.message(), message.sourceId().substringBefore("?").substringBefore("#"), "line ${message.lineNumber()}")
                return true
            }

            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                this@MainActivity.fileChooserCallback?.onReceiveValue(null)
                this@MainActivity.fileChooserCallback = filePathCallback
                val acceptedTypes = fileChooserParams?.acceptTypes
                    ?.flatMap { it.split(",") }
                    ?.map { it.trim() }
                    ?.filter { it.contains("/") && it != "*/*" }
                    ?.distinct()
                    .orEmpty()
                val allowMultiple = fileChooserParams?.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = if (acceptedTypes.size == 1) acceptedTypes.first() else "*/*"
                    if (acceptedTypes.size > 1) putExtra(Intent.EXTRA_MIME_TYPES, acceptedTypes.toTypedArray())
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, allowMultiple)
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
        val exportButton = Button(this).apply {
            text = "Save full debug report"
            setTextColor(android.graphics.Color.WHITE)
            backgroundTintList = ColorStateList.valueOf(android.graphics.Color.rgb(46, 67, 91))
            setOnClickListener { requestDebugReportSave() }
        }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(android.graphics.Color.rgb(13, 17, 23))
            addView(exportButton, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            addView(webView, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        }
        setContentView(root)
        if (savedInstanceState == null) {
            webView.loadUrl("https://$appHost/index.html")
        } else {
            webView.restoreState(savedInstanceState)
        }
    }

    private fun requestDebugReportSave() {
        if (!::webView.isInitialized) return
        webView.evaluateJavascript("window.MultiHFDiagnostics?.buildReportJson?.()") { encoded ->
            try {
                val report = JSONArray("[$encoded]").getString(0)
                if (report.isBlank() || !report.trimStart().startsWith("{")) throw IllegalStateException("The app has not finished preparing the debug report.")
                pendingDebugReport = report
                val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "application/json"
                    putExtra(Intent.EXTRA_TITLE, "multi-hf-debug-report-" + System.currentTimeMillis() + ".json")
                }
                debugReportPicker.launch(intent)
            } catch (error: Exception) {
                Toast.makeText(this, "Could not prepare debug report: " + (error.message ?: "Unknown error"), Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun redactDiagnosticText(value: String): String {
        var safe = value
        safe = Regex("""\bhf_[A-Za-z0-9]{20,}\b""").replace(safe, "[REDACTED_HF_TOKEN]")
        safe = Regex("""(?i)\bBearer\s+[^\s"' ,;]+""").replace(safe, "Bearer [REDACTED]")
        safe = Regex("""(?i)(authorization|access[_-]?token|refresh[_-]?token|token|secret|password|api[_-]?key)(\s*[:=]\s*["']?)[^"'\s,;&}]+""").replace(safe) { match ->
            match.groupValues[1] + match.groupValues[2] + "[REDACTED]"
        }
        return safe.take(6000)
    }

    private fun recordNativeDiagnostic(level: String, message: String, source: String = "", stack: String = "") {
        try {
            synchronized(diagnosticsLock) {
                val entries = try { JSONArray(diagnosticsPrefs.getString("entries", "[]") ?: "[]") }
                    catch (_: Exception) { JSONArray() }
                entries.put(
                    JSONObject()
                        .put("id", System.currentTimeMillis().toString() + "-" + entries.length())
                        .put("timestamp", System.currentTimeMillis())
                        .put("level", redactDiagnosticText(level))
                        .put("message", redactDiagnosticText(message))
                        .put("source", redactDiagnosticText(source))
                        .put("stack", redactDiagnosticText(stack))
                )
                while (entries.length() > 120) entries.remove(0)
                diagnosticsPrefs.edit().putString("entries", entries.toString()).apply()
            }
        } catch (_: Exception) {
            // Diagnostics must never crash the host app.
        }
    }

    private fun nativeDiagnosticsSnapshot(): String {
        return synchronized(diagnosticsLock) {
            diagnosticsPrefs.getString("entries", "[]") ?: "[]"
        }
    }

    private fun installCrashDiagnostics() {
        synchronized(MainActivity::class.java) {
            if (crashHandlerInstalled) return
            val previous = Thread.getDefaultUncaughtExceptionHandler()
            Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
                recordNativeDiagnostic(
                    "fatal_android_crash",
                    "Uncaught Android exception on thread " + thread.name,
                    "",
                    throwable.stackTraceToString()
                )
                previous?.uncaughtException(thread, throwable)
            }
            crashHandlerInstalled = true
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
        recordNativeDiagnostic("lifecycle", "Android activity destroyed.")

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
