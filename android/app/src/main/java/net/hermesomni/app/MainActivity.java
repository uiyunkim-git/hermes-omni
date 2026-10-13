package net.hermesomni.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.text.InputType;
import android.util.Log;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

/**
 * Hermes Omni: a WebView shell around the hub web UI.
 *
 * <p>Only the configured hub origin is loaded in-app (and gets the {@link OmniBridge}); other
 * links open in the default browser. Main-frame load failures show a native panel with a Tailscale
 * hint and retry; it also retries automatically when a network (e.g. the Tailscale VPN) comes up.
 */
public class MainActivity extends Activity {
  private static final String TAG = "HermesOmni";
  private static final String PREFS = "omni";
  private static final String PREF_HUB_URL = "hub_url";
  private static final int FILE_CHOOSER_REQ = 1;
  private static final long AUTO_RETRY_MIN_INTERVAL_MS = 3000;

  private final Handler ui = new Handler(Looper.getMainLooper());
  private SharedPreferences prefs;
  private FrameLayout root;
  private WebView web;
  private ProgressBar progress;
  private View errorPanel;
  private TextView errorDetail;
  private OmniBridge bridge;
  private Downloader downloader;
  private ConnectivityManager.NetworkCallback netCallback;

  private String hubUrl;                 // normalized, or null before first-run setup
  private String failedUrl;              // main-frame URL whose load failed (for retry)
  private boolean loadFailed;
  private long lastAutoRetry;
  private ValueCallback<Uri[]> fileCallback;
  private AlertDialog hubDialog;

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    setContentView(R.layout.activity_main);
    prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
    hubUrl = HubUrl.normalize(prefs.getString(PREF_HUB_URL, null));

    root = findViewById(R.id.root);
    progress = findViewById(R.id.progress);
    errorPanel = findViewById(R.id.error_panel);
    errorDetail = findViewById(R.id.error_detail);
    ((Button) findViewById(R.id.error_retry)).setOnClickListener(v -> retry());
    ((Button) findViewById(R.id.error_change_hub)).setOnClickListener(v -> showHubDialog(false));

    bridge = new OmniBridge(this);
    downloader = new Downloader(this);
    downloader.register();
    CookieManager.getInstance().setAcceptCookie(true);
    WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
    createWebView();
    registerNetworkCallback();

    if (state != null && web.restoreState(state) != null) {
      Log.i(TAG, "restored WebView state");
    } else if (hubUrl == null) {
      showHubDialog(true);
    } else {
      web.loadUrl(hubUrl);
    }
  }

  // ---------------------------------------------------------------- WebView setup

  @SuppressLint("SetJavaScriptEnabled")
  private void createWebView() {
    web = new WebView(this);
    web.setLayoutParams(new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    root.addView(web, 0);

    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setSupportMultipleWindows(false);        // target=_blank / window.open -> same WebView
    s.setAllowFileAccess(false);
    s.setMediaPlaybackRequiresUserGesture(true);
    s.setUserAgentString(s.getUserAgentString() + " HermesOmni/" + BuildConfig.VERSION_NAME);
    CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);

    web.addJavascriptInterface(bridge, OmniBridge.NAME);
    web.setWebViewClient(new HubClient());
    web.setWebChromeClient(new HubChromeClient());
    web.setDownloadListener((url, ua, cd, mime, len) -> downloader.start(url, ua, cd, mime));
  }

  private final class HubClient extends WebViewClient {
    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
      String url = req.getUrl().toString();
      if (hubUrl != null && HubUrl.sameOrigin(url, hubUrl)) return false;
      if (!req.isForMainFrame()) {
        // Never load foreign documents into frames: they would see the HermesOmni bridge.
        Log.w(TAG, "blocked cross-origin subframe " + req.getUrl().getHost());
        return true;
      }
      openExternally(req.getUrl());
      return true;
    }

    @Override
    public void onPageStarted(WebView view, String url, Bitmap favicon) {
      loadFailed = false;
      bridge.setEnabled(isHub(url));
    }

    @Override
    public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
      bridge.setEnabled(isHub(url));
    }

    @Override
    public void onPageFinished(WebView view, String url) {
      if (!loadFailed) hideError();
      CookieManager.getInstance().flush();
    }

    @Override
    public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
      if (!req.isForMainFrame()) return;
      Log.w(TAG, "main-frame load failed: " + err.getErrorCode() + " " + err.getDescription());
      showError(req.getUrl().toString(), String.valueOf(err.getDescription()));
    }

    @Override
    public void onReceivedHttpError(WebView view, WebResourceRequest req, WebResourceResponse resp) {
      int code = resp.getStatusCode();
      // 502/503/504 = proxy (tailscale serve) up but hub down; other statuses are the UI's business.
      if (req.isForMainFrame() && code >= 502 && code <= 504) {
        Log.w(TAG, "main-frame HTTP " + code);
        showError(req.getUrl().toString(), "HTTP " + code);
      }
    }

    @Override
    public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
      Log.e(TAG, "renderer gone (crash=" + detail.didCrash() + "); rebuilding WebView");
      if (view == web) {
        root.removeView(web);
        web.destroy();
        createWebView();
        if (hubUrl != null) web.loadUrl(hubUrl);
      }
      return true;
    }
  }

  private final class HubChromeClient extends WebChromeClient {
    @Override
    public void onProgressChanged(WebView view, int newProgress) {
      progress.setProgress(newProgress);
      progress.setVisibility(newProgress < 100 ? View.VISIBLE : View.GONE);
    }

    @Override
    public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
      if (fileCallback != null) fileCallback.onReceiveValue(null);
      fileCallback = cb;
      try {
        startActivityForResult(params.createIntent(), FILE_CHOOSER_REQ);
        return true;
      } catch (ActivityNotFoundException e) {
        Log.w(TAG, "no file picker available", e);
        fileCallback = null;
        return false;
      }
    }
  }

  private boolean isHub(String url) {
    return hubUrl != null && HubUrl.sameOrigin(url, hubUrl);
  }

  private void openExternally(Uri uri) {
    try {
      startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE));
    } catch (ActivityNotFoundException e) {
      Toast.makeText(this, R.string.no_app_for_link, Toast.LENGTH_SHORT).show();
    }
  }

  // ---------------------------------------------------------------- error panel

  private void showError(String url, String detail) {
    loadFailed = true;
    failedUrl = url;
    errorDetail.setText(getString(R.string.error_detail, url, detail));
    errorPanel.setVisibility(View.VISIBLE);
    progress.setVisibility(View.GONE);
  }

  private void hideError() {
    errorPanel.setVisibility(View.GONE);
  }

  private void retry() {
    hideError();
    String target = failedUrl != null && isHub(failedUrl) ? failedUrl : hubUrl;
    failedUrl = null;
    if (target != null) web.loadUrl(target);
    else showHubDialog(true);
  }

  /** Reload automatically once a network appears while the error panel is showing. */
  private void registerNetworkCallback() {
    ConnectivityManager cm = getSystemService(ConnectivityManager.class);
    if (cm == null) return;
    netCallback = new ConnectivityManager.NetworkCallback() {
      @Override public void onAvailable(Network network) {
        ui.postDelayed(MainActivity.this::autoRetry, 1500);   // let VPN routes/DNS settle
      }
    };
    try {
      cm.registerDefaultNetworkCallback(netCallback);
    } catch (RuntimeException e) {
      Log.w(TAG, "network callback unavailable", e);
      netCallback = null;
    }
  }

  private void autoRetry() {
    if (isFinishing() || errorPanel.getVisibility() != View.VISIBLE) return;
    long now = SystemClock.elapsedRealtime();
    if (now - lastAutoRetry < AUTO_RETRY_MIN_INTERVAL_MS) return;
    lastAutoRetry = now;
    Log.i(TAG, "network available; retrying");
    retry();
  }

  // ---------------------------------------------------------------- hub URL dialog

  private void showHubDialog(boolean required) {
    if (hubDialog != null && hubDialog.isShowing()) return;
    EditText input = new EditText(this);
    input.setSingleLine(true);
    input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
    input.setImeOptions(EditorInfo.IME_ACTION_GO);
    String prefill = hubUrl != null ? hubUrl
        : (BuildConfig.DEFAULT_HUB_URL.isEmpty() ? "http://" : BuildConfig.DEFAULT_HUB_URL);
    input.setText(prefill);
    input.setSelection(prefill.length());
    FrameLayout box = new FrameLayout(this);
    int pad = Math.round(20 * getResources().getDisplayMetrics().density);
    box.setPadding(pad, pad / 2, pad, 0);
    box.addView(input);

    AlertDialog.Builder b = new AlertDialog.Builder(this)
        .setTitle(R.string.hub_dialog_title)
        .setMessage(R.string.hub_dialog_message)
        .setView(box)
        .setCancelable(!required)
        .setPositiveButton(R.string.hub_dialog_connect, null);   // listener set below: keep open on error
    if (!required) b.setNegativeButton(R.string.cancel, null);
    AlertDialog d = b.create();
    d.setOnShowListener(x -> {
      View.OnClickListener submit = v -> {
        String url = HubUrl.normalize(input.getText().toString());
        if (url == null) {
          input.setError(getString(R.string.hub_url_invalid));
          return;
        }
        if (HubUrl.classify(HubUrl.host(url)) == HubUrl.Kind.OTHER) {
          confirmUnusualHost(url, () -> { d.dismiss(); applyHubUrl(url); });
        } else {
          d.dismiss();
          applyHubUrl(url);
        }
      };
      d.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(submit);
      input.setOnEditorActionListener((v, actionId, ev) -> {
        submit.onClick(v);
        return true;
      });
    });
    hubDialog = d;
    d.show();
  }

  private void confirmUnusualHost(String url, Runnable onConfirm) {
    new AlertDialog.Builder(this)
        .setTitle(R.string.hub_warn_title)
        .setMessage(getString(R.string.hub_warn_message, url))
        .setPositiveButton(R.string.hub_warn_use, (dlg, w) -> onConfirm.run())
        .setNegativeButton(R.string.cancel, null)
        .show();
  }

  private void applyHubUrl(String url) {
    Log.i(TAG, "hub URL set to " + url);
    hubUrl = url;
    prefs.edit().putString(PREF_HUB_URL, url).apply();
    hideError();
    web.clearHistory();
    web.loadUrl(url);
  }

  // ---------------------------------------------------------------- menu

  @Override
  public boolean onCreateOptionsMenu(Menu menu) {
    getMenuInflater().inflate(R.menu.main, menu);
    return true;
  }

  @Override
  public boolean onOptionsItemSelected(MenuItem item) {
    int id = item.getItemId();
    if (id == R.id.action_reload) {
      if (errorPanel.getVisibility() == View.VISIBLE || web.getUrl() == null) retry();
      else web.reload();
      return true;
    } else if (id == R.id.action_change_hub) {
      showHubDialog(false);
      return true;
    } else if (id == R.id.action_clear_cookies) {
      new AlertDialog.Builder(this)
          .setMessage(R.string.clear_cookies_message)
          .setPositiveButton(R.string.clear_cookies_confirm, (d, w) -> clearSiteData())
          .setNegativeButton(R.string.cancel, null)
          .show();
      return true;
    }
    return super.onOptionsItemSelected(item);
  }

  private void clearSiteData() {
    CookieManager cm = CookieManager.getInstance();
    cm.removeAllCookies(removed -> {
      cm.flush();
      WebStorage.getInstance().deleteAllData();
      web.clearCache(false);
      Toast.makeText(this, R.string.cookies_cleared, Toast.LENGTH_SHORT).show();
      if (hubUrl != null) web.loadUrl(hubUrl);
    });
  }

  // ---------------------------------------------------------------- lifecycle

  @Override
  protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    if (requestCode == FILE_CHOOSER_REQ) {
      if (fileCallback != null) {
        fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
        fileCallback = null;
      }
      return;
    }
    super.onActivityResult(requestCode, resultCode, data);
  }

  // targetSdk 35 still delivers onBackPressed (enableOnBackInvokedCallback is not set).
  @SuppressWarnings("deprecation")
  @Override
  public void onBackPressed() {
    if (web.canGoBack()) {
      hideError();
      web.goBack();
    } else {
      super.onBackPressed();
    }
  }

  @Override
  protected void onSaveInstanceState(Bundle out) {
    super.onSaveInstanceState(out);
    web.saveState(out);
  }

  @Override
  protected void onResume() {
    super.onResume();
    web.onResume();
  }

  @Override
  protected void onPause() {
    CookieManager.getInstance().flush();
    web.onPause();
    super.onPause();
  }

  @Override
  protected void onDestroy() {
    ui.removeCallbacksAndMessages(null);
    if (netCallback != null) {
      try {
        getSystemService(ConnectivityManager.class).unregisterNetworkCallback(netCallback);
      } catch (RuntimeException ignored) {
        // already unregistered
      }
    }
    downloader.unregister();
    if (hubDialog != null) hubDialog.dismiss();
    root.removeView(web);
    web.destroy();
    super.onDestroy();
  }
}
