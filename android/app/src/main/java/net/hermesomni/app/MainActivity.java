package net.hermesomni.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.text.InputType;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewTreeObserver;
import android.view.Window;
import android.view.WindowInsetsController;
import android.view.inputmethod.EditorInfo;
import android.webkit.CookieManager;
import android.webkit.MimeTypeMap;
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
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Hermes: a WebView shell around the hub web UI (spec §5c).
 *
 * <p>Only the configured hub origin is loaded in-app (and gets the {@link OmniBridge}); other
 * links open in the default browser. The web app draws all chrome; the shell adds the launch
 * screen, system-bar colors that follow the page theme, Android back routed through the page's
 * {@code window.__omniBack}, a native connection-error screen (auto-retried when a network comes
 * up), a file chooser with camera capture, downloads and an update prompt.
 */
public class MainActivity extends Activity implements OmniBridge.Host {
  private static final String TAG = "HermesOmni";
  private static final String PREFS = "omni";
  private static final String PREF_HUB_URL = "hub_url";
  private static final String PREF_BARS = "bars";                       // "#RRGGBB|light|night"
  private static final String PREF_LAST_UPDATE_CHECK = "last_update_check";
  private static final String PREF_SKIPPED_VERSION = "skipped_version";
  private static final int FILE_CHOOSER_REQ = 1;
  private static final long AUTO_RETRY_MIN_INTERVAL_MS = 3000;
  private static final long SPLASH_MAX_MS = 2500;
  private static final long BACK_GUARD_MS = 300;
  private static final long UPDATE_CHECK_INTERVAL_MS = 6L * 60 * 60 * 1000;
  private static final String APK_PATH = "/app/hermes-omni.apk";
  private static final String BACK_JS =
      "(function(){try{if(typeof window.__omniBack!=='function')return 'none';"
          + "return window.__omniBack()===true?'handled':'unhandled';}catch(e){return 'none';}})()";

  private final Handler ui = new Handler(Looper.getMainLooper());
  private SharedPreferences prefs;
  private FrameLayout root;
  private WebView web;
  private ProgressBar progress;
  private View errorPanel;
  private TextView errorDetail;
  private OmniBridge bridge;
  private Downloader downloader;
  private final UpdateChecker updateChecker = new UpdateChecker();
  private ConnectivityManager.NetworkCallback netCallback;

  private String hubUrl;                 // normalized, or null before first-run setup
  private String failedUrl;              // main-frame URL whose load failed (for retry)
  private boolean loadFailed;
  private boolean pageShown;             // first hub page finished: launch background replaced
  private boolean launchReady;           // releases the API 31+ splash screen
  private int pageBg;                    // current page background (--bg), drives bars + window
  private long lastAutoRetry;
  private long lastBack;
  private boolean resumedOnce;           // the first onResume of a cold start forces an update check
  private ValueCallback<Uri[]> fileCallback;
  private Uri captureUri;
  private AlertDialog hubDialog;
  private AlertDialog updateDialog;

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    setContentView(R.layout.activity_main);
    prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
    hubUrl = HubUrl.normalize(prefs.getString(PREF_HUB_URL, null));
    pageBg = getColor(R.color.surface);
    restoreBars();
    if (state == null) holdSplash();
    else resumedOnce = true;              // recreated (rotation, theme): not a cold start

    root = findViewById(R.id.root);
    progress = findViewById(R.id.progress);
    errorPanel = findViewById(R.id.error_panel);
    errorDetail = findViewById(R.id.error_detail);
    findViewById(R.id.error_retry).setOnClickListener(v -> retry());
    findViewById(R.id.error_change_hub).setOnClickListener(v -> showHubDialog(false));

    bridge = new OmniBridge(this);
    downloader = new Downloader(this);
    downloader.register();
    CookieManager.getInstance().setAcceptCookie(true);
    WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
    createWebView();
    registerNetworkCallback();
    CaptureProvider.pruneOld(this);

    if (state != null && web.restoreState(state) != null) {
      bridge.setEnabled(isHub(web.getUrl()));
      Log.i(TAG, "restored WebView state");
    } else if (hubUrl == null) {
      markLaunchReady();
      showHubDialog(true);
    } else {
      loadHub(hubUrl);
    }
  }

  // ---------------------------------------------------------------- launch screen

  /**
   * API 31+: keeps the system splash (surface color + mark, from the theme) up until the first hub
   * page has finished or {@link #SPLASH_MAX_MS} has passed, then fades it out. On every API
   * level the themed launch background (the same mark) stays visible behind the transparent
   * WebView until the page has loaded, so a slow hub shows the mark instead of a blank screen.
   */
  private void holdSplash() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return;
    getSplashScreen().setOnExitAnimationListener(view ->
        view.animate().alpha(0f).setDuration(160).withEndAction(view::remove).start());
    View content = findViewById(android.R.id.content);
    content.getViewTreeObserver().addOnPreDrawListener(new ViewTreeObserver.OnPreDrawListener() {
      @Override public boolean onPreDraw() {
        if (!launchReady) return false;
        content.getViewTreeObserver().removeOnPreDrawListener(this);
        return true;
      }
    });
    ui.postDelayed(this::markLaunchReady, SPLASH_MAX_MS);
  }

  private void markLaunchReady() {
    launchReady = true;
  }

  /** The first hub page is up: swap the launch background for the plain page color. */
  private void onFirstPageShown() {
    if (pageShown) return;
    pageShown = true;
    getWindow().setBackgroundDrawable(new ColorDrawable(pageBg));
    web.setBackgroundColor(pageBg);
  }

  // ---------------------------------------------------------------- system bars

  /** Bridge: HermesOmni.setBars(--bg, isLight). Also recolors the window behind the WebView. */
  @Override
  public void applyBars(int color, boolean lightBackground) {
    if (isFinishing()) return;
    setBars(color, lightBackground);
    String saved = String.format(Locale.ROOT, "#%06X|%d|%d",
        color & 0xFFFFFF, lightBackground ? 1 : 0, nightMode());
    if (!saved.equals(prefs.getString(PREF_BARS, null))) prefs.edit().putString(PREF_BARS, saved).apply();
  }

  /**
   * Re-applies the last page colors on start when the system night mode is unchanged, so a user
   * who forced the other theme in the web app does not see the bars flip after every launch.
   */
  private void restoreBars() {
    String saved = prefs.getString(PREF_BARS, null);
    if (saved == null) return;
    String[] p = saved.split("\\|");
    if (p.length != 3 || !p[2].equals(String.valueOf(nightMode()))) return;
    Integer color = OmniBridge.parseRgb(p[0]);
    if (color != null) setBars(color, "1".equals(p[1]));
  }

  private int nightMode() {
    return getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
  }

  // Window.setStatusBarColor/setNavigationBarColor are deprecated at API 35 but still apply while
  // the window opts out of edge-to-edge (windowOptOutEdgeToEdgeEnforcement).
  @SuppressWarnings("deprecation")
  private void setBars(int color, boolean light) {
    pageBg = color;
    Window w = getWindow();
    w.setStatusBarColor(color);
    w.setNavigationBarColor(color);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      WindowInsetsController c = w.getInsetsController();
      if (c != null) {
        int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
            | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
        c.setSystemBarsAppearance(light ? mask : 0, mask);
      }
    }
    if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.R) {
      // API 30 still honors (and lets the theme re-apply) the legacy flags; set both.
      View decor = w.getDecorView();
      int flags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
      int vis = decor.getSystemUiVisibility();
      decor.setSystemUiVisibility(light ? vis | flags : vis & ~flags);
    }
    if (pageShown) {
      w.setBackgroundDrawable(new ColorDrawable(color));
      if (web != null) web.setBackgroundColor(color);
    }
  }

  // ---------------------------------------------------------------- WebView setup

  @SuppressLint("SetJavaScriptEnabled")
  @SuppressWarnings("deprecation")
  private void createWebView() {
    web = new WebView(this);
    web.setLayoutParams(new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    // Transparent until the first page: the launch background (or the splash) shows through
    // instead of a white flash.
    web.setBackgroundColor(pageShown ? pageBg : Color.TRANSPARENT);
    // The web app implements pull-to-refresh itself; the native glow would fight it.
    web.setOverScrollMode(View.OVER_SCROLL_NEVER);
    root.addView(web, 0);

    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setSupportMultipleWindows(false);        // target=_blank / window.open -> same WebView
    s.setAllowFileAccess(false);
    s.setMediaPlaybackRequiresUserGesture(true);
    s.setTextZoom(100);                        // the web app has its own type scale
    s.setUserAgentString(s.getUserAgentString() + " HermesOmni/" + BuildConfig.VERSION_NAME);
    // The web app themes itself from prefers-color-scheme (derived from the app theme).
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      s.setAlgorithmicDarkeningAllowed(false);
    } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      s.setForceDark(WebSettings.FORCE_DARK_OFF);
    }
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
      if (isHub(url)) return false;
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
      if (!loadFailed) {
        hideError();
        if (isHub(url)) onFirstPageShown();
      }
      if (isHub(url) || loadFailed) markLaunchReady();
      CookieManager.getInstance().flush();
    }

    @Override
    public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
      if (!req.isForMainFrame() || !isHub(req.getUrl().toString())) return;
      Log.w(TAG, "main-frame load failed: " + err.getErrorCode() + " " + err.getDescription());
      showError(req.getUrl().toString(), String.valueOf(err.getDescription()));
    }

    @Override
    public void onReceivedHttpError(WebView view, WebResourceRequest req, WebResourceResponse resp) {
      int code = resp.getStatusCode();
      // 502/503/504 = proxy (tailscale serve) up but hub down; other statuses are the UI's business.
      if (req.isForMainFrame() && isHub(req.getUrl().toString()) && code >= 502 && code <= 504) {
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
        if (hubUrl != null) loadHub(hubUrl);
      }
      return true;
    }
  }

  private final class HubChromeClient extends WebChromeClient {
    @Override
    public void onProgressChanged(WebView view, int newProgress) {
      progress.setProgress(newProgress);
      progress.setVisibility(newProgress < 100 && errorPanel.getVisibility() != View.VISIBLE
          ? View.VISIBLE : View.GONE);
    }

    @Override
    public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
      return openFileChooser(cb, params);
    }
  }

  private boolean isHub(String url) {
    return hubUrl != null && HubUrl.sameOrigin(url, hubUrl);
  }

  /**
   * Loads a hub URL with the bridge already enabled: onPageStarted is posted to the UI thread and
   * can arrive after the page's first scripts have called HermesOmni (seen on cold starts).
   */
  private void loadHub(String url) {
    bridge.setEnabled(isHub(url));
    web.loadUrl(url);
  }

  /** Non-hub navigations: web links to the browser; mailto/tel/sms/geo to their apps. */
  private void openExternally(Uri uri) {
    String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
    Intent i = new Intent(Intent.ACTION_VIEW, uri);
    switch (scheme) {
      case "http":
      case "https":
        i.addCategory(Intent.CATEGORY_BROWSABLE);
        break;
      case "mailto":
      case "tel":
      case "sms":
      case "smsto":
      case "geo":
        break;
      default:
        // intent:, file:, content:, javascript: ... are never handed to other apps.
        Log.w(TAG, "refused to open scheme " + scheme);
        Toast.makeText(this, R.string.no_app_for_link, Toast.LENGTH_SHORT).show();
        return;
    }
    try {
      startActivity(i);
    } catch (ActivityNotFoundException e) {
      Toast.makeText(this, R.string.no_app_for_link, Toast.LENGTH_SHORT).show();
    }
  }

  // ---------------------------------------------------------------- back

  /**
   * Back goes to the web app first ({@code window.__omniBack}, spec §2.2): it closes menus and
   * sheets and pops routes. When it declines (home screen) the app is backgrounded rather than
   * finished, so reopening is instant. Pages without the hook fall back to WebView history.
   */
  // targetSdk 35 still delivers onBackPressed (enableOnBackInvokedCallback is not set).
  @SuppressWarnings("deprecation")
  @Override
  public void onBackPressed() {
    long now = SystemClock.uptimeMillis();
    if (now - lastBack < BACK_GUARD_MS) return;
    lastBack = now;
    if (errorPanel.getVisibility() == View.VISIBLE || web.getUrl() == null) {
      moveTaskToBack(true);
      return;
    }
    final WebView target = web;
    target.evaluateJavascript(BACK_JS, result -> {
      if (isFinishing() || target != web) return;
      if ("\"handled\"".equals(result)) return;
      if (errorPanel.getVisibility() == View.VISIBLE) {
        moveTaskToBack(true);
      } else if (!"\"unhandled\"".equals(result) && web.canGoBack()) {
        web.goBack();
      } else {
        moveTaskToBack(true);
      }
    });
  }

  // ---------------------------------------------------------------- file chooser

  private boolean openFileChooser(ValueCallback<Uri[]> cb, WebChromeClient.FileChooserParams params) {
    if (fileCallback != null) fileCallback.onReceiveValue(null);
    fileCallback = cb;
    discardCapture();

    List<String> types = acceptMimeTypes(params.getAcceptTypes());
    Intent pick = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE);
    pick.setType(types.size() == 1 ? types.get(0) : "*/*");
    if (types.size() > 1) pick.putExtra(Intent.EXTRA_MIME_TYPES, types.toArray(new String[0]));
    if (params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
      pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
    }

    boolean imagesOk = types.isEmpty();
    for (String t : types) imagesOk |= t.equals("*/*") || t.startsWith("image/");
    Intent camera = imagesOk ? cameraIntent() : null;

    Intent launch;
    if (camera != null && params.isCaptureEnabled()) {
      launch = camera;                                   // <input capture>: straight to the camera
    } else {
      launch = Intent.createChooser(pick, getString(R.string.choose_file));
      if (camera != null) launch.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[] {camera});
    }
    try {
      startActivityForResult(launch, FILE_CHOOSER_REQ);
      return true;
    } catch (ActivityNotFoundException e) {
      Log.w(TAG, "no file picker available", e);
      discardCapture();
      fileCallback = null;                               // returning false makes WebView cancel
      Toast.makeText(this, R.string.no_file_picker, Toast.LENGTH_SHORT).show();
      return false;
    }
  }

  /** Accept attribute values to MIME types: ".pdf" -> application/pdf; unknown -> any file. */
  private static List<String> acceptMimeTypes(String[] accept) {
    Set<String> out = new LinkedHashSet<>();
    if (accept != null) {
      for (String raw : accept) {
        if (raw == null) continue;
        for (String part : raw.split(",")) {
          String t = part.trim().toLowerCase(Locale.ROOT);
          if (t.isEmpty()) continue;
          if (t.startsWith(".")) {
            t = MimeTypeMap.getSingleton().getMimeTypeFromExtension(t.substring(1));
            if (t == null) t = "*/*";
          }
          if (t.equals("*/*") || !t.contains("/")) return new ArrayList<>(Collections.singletonList("*/*"));
          out.add(t);
        }
      }
    }
    return new ArrayList<>(out);
  }

  /**
   * ACTION_IMAGE_CAPTURE writing to a CaptureProvider URI, or null without a camera app. No CAMERA
   * permission is declared, so the intent works without one. The camera apps get explicit grants
   * because the chooser does not forward EXTRA_INITIAL_INTENTS grant flags reliably.
   */
  @SuppressWarnings("deprecation")   // queryIntentActivities(Intent, int): the flags overload is API 33+
  private Intent cameraIntent() {
    Uri out = CaptureProvider.newCapture(this);
    if (out == null) return null;
    int grant = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
    Intent i = new Intent(MediaStore.ACTION_IMAGE_CAPTURE)
        .putExtra(MediaStore.EXTRA_OUTPUT, out)
        .addFlags(grant);
    i.setClipData(ClipData.newRawUri("", out));
    List<ResolveInfo> cams = getPackageManager().queryIntentActivities(i, PackageManager.MATCH_DEFAULT_ONLY);
    if (cams.isEmpty()) return null;
    for (ResolveInfo r : cams) grantUriPermission(r.activityInfo.packageName, out, grant);
    captureUri = out;
    return i;
  }

  private void onFileChooserResult(int resultCode, Intent data) {
    Uri[] result = null;
    if (resultCode == RESULT_OK) {
      File shot = CaptureProvider.fileFor(this, captureUri);
      if (shot != null && shot.length() > 0) {
        result = new Uri[] {captureUri};
        captureUri = null;                               // keep the file: the page reads it later
      } else if (data != null) {
        List<Uri> uris = new ArrayList<>();
        ClipData clip = data.getClipData();
        if (clip != null) {
          for (int i = 0; i < clip.getItemCount(); i++) {
            Uri u = clip.getItemAt(i).getUri();
            if (u != null) uris.add(u);
          }
        }
        if (uris.isEmpty() && data.getData() != null) uris.add(data.getData());
        if (uris.isEmpty()) {
          result = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
        } else {
          result = uris.toArray(new Uri[0]);
        }
      }
    }
    discardCapture();
    if (fileCallback != null) {
      fileCallback.onReceiveValue(result);               // null = cancelled; must always be called
      fileCallback = null;
    }
  }

  /** Revokes the camera grant and deletes an unused capture file. */
  private void discardCapture() {
    if (captureUri == null) return;
    revokeUriPermission(captureUri,
        Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
    File f = CaptureProvider.fileFor(this, captureUri);
    if (f != null && f.length() == 0) {
      //noinspection ResultOfMethodCallIgnored
      f.delete();
    }
    captureUri = null;
  }

  // ---------------------------------------------------------------- error screen

  private void showError(String url, String detail) {
    loadFailed = true;
    failedUrl = url;
    errorDetail.setText(getString(R.string.error_detail, url, detail));
    errorPanel.setVisibility(View.VISIBLE);
    progress.setVisibility(View.GONE);
    markLaunchReady();
  }

  private void hideError() {
    errorPanel.setVisibility(View.GONE);
  }

  private void retry() {
    hideError();
    String target = failedUrl != null && isHub(failedUrl) ? failedUrl : hubUrl;
    failedUrl = null;
    if (target != null) loadHub(target);
    else showHubDialog(true);
  }

  /** Reload automatically once a network appears while the error screen is showing. */
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

  /** Bridge: HermesOmni.changeHubUrl(). */
  @Override
  public void showHubDialog() {
    showHubDialog(false);
  }

  private void showHubDialog(boolean required) {
    if (hubDialog != null && hubDialog.isShowing()) return;
    EditText input = new EditText(this);
    input.setSingleLine(true);
    input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
    input.setImeOptions(EditorInfo.IME_ACTION_GO);
    input.setTextSize(16);
    String prefill = hubUrl != null ? hubUrl
        : (BuildConfig.DEFAULT_HUB_URL.isEmpty() ? "http://" : BuildConfig.DEFAULT_HUB_URL);
    input.setText(prefill);
    input.setSelection(prefill.length());
    FrameLayout box = new FrameLayout(this);
    int pad = dp(20);
    box.setPadding(pad, dp(8), pad, 0);
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
    boolean changed = !url.equals(hubUrl);
    hubUrl = url;
    prefs.edit().putString(PREF_HUB_URL, url).apply();
    hideError();
    web.clearHistory();
    loadHub(url);
    if (changed) checkForUpdate(true);
  }

  // ---------------------------------------------------------------- shell menu

  /** Bridge: HermesOmni.openMenu() (legacy web builds; the v3 UI has these in Settings › 앱). */
  @Override
  public void showShellMenu() {
    CharSequence[] items = {
        getString(R.string.menu_reload), getString(R.string.change_hub), getString(R.string.menu_clear_cookies)};
    new AlertDialog.Builder(this)
        .setItems(items, (d, which) -> {
          if (which == 0) reload();
          else if (which == 1) showHubDialog(false);
          else confirmClearSiteData();
        })
        .show();
  }

  private void reload() {
    if (errorPanel.getVisibility() == View.VISIBLE || web.getUrl() == null) retry();
    else web.reload();
  }

  private void confirmClearSiteData() {
    new AlertDialog.Builder(this)
        .setMessage(R.string.clear_cookies_message)
        .setPositiveButton(R.string.clear_cookies_confirm, (d, w) -> clearSiteData())
        .setNegativeButton(R.string.cancel, null)
        .show();
  }

  private void clearSiteData() {
    CookieManager cm = CookieManager.getInstance();
    cm.removeAllCookies(removed -> {
      cm.flush();
      WebStorage.getInstance().deleteAllData();
      web.clearCache(false);
      Toast.makeText(this, R.string.cookies_cleared, Toast.LENGTH_SHORT).show();
      if (hubUrl != null) loadHub(hubUrl);
    });
  }

  // ---------------------------------------------------------------- update prompt

  /** Cold start always checks; resume checks again once {@link #UPDATE_CHECK_INTERVAL_MS} passed. */
  private void checkForUpdate(boolean force) {
    if (hubUrl == null) return;
    long now = System.currentTimeMillis();
    long last = prefs.getLong(PREF_LAST_UPDATE_CHECK, 0);
    if (!force && now - last >= 0 && now - last < UPDATE_CHECK_INTERVAL_MS) return;
    prefs.edit().putLong(PREF_LAST_UPDATE_CHECK, now).apply();
    updateChecker.check(hubUrl, this::offerUpdate);
  }

  private void offerUpdate(UpdateChecker.Meta meta) {
    if (isFinishing() || isDestroyed()) return;
    if (meta.versionCode == prefs.getInt(PREF_SKIPPED_VERSION, 0)) return;
    if ((updateDialog != null && updateDialog.isShowing()) || (hubDialog != null && hubDialog.isShowing())) return;
    String size = meta.size > 0 ? String.format(Locale.ROOT, "%.1f MB", meta.size / 1048576.0) : "";
    String detail = size.isEmpty() ? "v" + meta.versionName
        : getString(R.string.update_detail, meta.versionName, size);
    updateDialog = new AlertDialog.Builder(this)
        .setTitle(R.string.update_title)
        .setMessage(detail)
        .setPositiveButton(R.string.update_now, (d, w) -> downloadUpdate())
        .setNegativeButton(R.string.update_later, null)
        .setNeutralButton(R.string.update_skip, (d, w) ->
            prefs.edit().putInt(PREF_SKIPPED_VERSION, meta.versionCode).apply())
        .show();
  }

  private void downloadUpdate() {
    if (hubUrl == null) return;
    downloader.start(hubUrl + APK_PATH, web.getSettings().getUserAgentString(), null, Downloader.APK_MIME);
  }

  // ---------------------------------------------------------------- lifecycle

  private int dp(int v) {
    return Math.round(v * getResources().getDisplayMetrics().density);
  }

  @Override
  protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    if (requestCode == FILE_CHOOSER_REQ) {
      onFileChooserResult(resultCode, data);
      return;
    }
    super.onActivityResult(requestCode, resultCode, data);
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
    checkForUpdate(!resumedOnce);
    resumedOnce = true;
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
    if (fileCallback != null) {
      fileCallback.onReceiveValue(null);
      fileCallback = null;
    }
    discardCapture();
    downloader.unregister();
    if (hubDialog != null) hubDialog.dismiss();
    if (updateDialog != null) updateDialog.dismiss();
    root.removeView(web);
    web.destroy();
    super.onDestroy();
  }
}
