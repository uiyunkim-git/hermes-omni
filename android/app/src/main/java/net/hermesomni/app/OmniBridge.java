package net.hermesomni.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Build;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

/**
 * JavaScript bridge exposed to the hub web UI as {@code window.HermesOmni}.
 *
 * <p>addJavascriptInterface injects the object into every frame, so each method checks {@link
 * #enabled}, which MainActivity keeps true only while the main frame shows the configured hub
 * origin (cross-origin subframes are blocked from loading at all). Methods run on the WebView's
 * JavaBridge thread, so UI work is posted to the main thread.
 */
final class OmniBridge {
  static final String NAME = "HermesOmni";
  private static final String TAG = "HermesOmni";
  private static final int MAX_COPY_CHARS = 1_000_000;

  private final Activity activity;
  private volatile boolean enabled;

  OmniBridge(Activity activity) {
    this.activity = activity;
  }

  void setEnabled(boolean enabled) {
    this.enabled = enabled;
  }

  /** Copies text to the system clipboard (navigator.clipboard is unavailable over plain HTTP). */
  @JavascriptInterface
  public boolean copy(String text) {
    if (!enabled || text == null) return false;
    final String value = text.length() > MAX_COPY_CHARS ? text.substring(0, MAX_COPY_CHARS) : text;
    activity.runOnUiThread(() -> {
      try {
        ClipboardManager cm = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
        cm.setPrimaryClip(ClipData.newPlainText("Hermes Omni", value));
        // Android 13+ shows its own clipboard confirmation.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
          Toast.makeText(activity, R.string.copied, Toast.LENGTH_SHORT).show();
        }
      } catch (RuntimeException e) {
        Log.w(TAG, "clipboard copy failed", e);
      }
    });
    return true;
  }

  /** The shell's versionName, e.g. "0.1.26101315" (empty string off-hub). */
  @JavascriptInterface
  public String appVersion() {
    return enabled ? BuildConfig.VERSION_NAME : "";
  }

  /** The shell's versionCode (0 off-hub); lets the UI compare against /api/app. */
  @JavascriptInterface
  public int appVersionCode() {
    return enabled ? BuildConfig.VERSION_CODE : 0;
  }

  /** Opens the native options menu (Change hub URL / Reload / Clear cookies). */
  @JavascriptInterface
  public void openMenu() {
    if (enabled) activity.runOnUiThread(activity::openOptionsMenu);
  }
}
