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
 * JavaScript bridge exposed to the hub web UI as {@code window.HermesOmni} (spec §5c.11).
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

  /** Native actions the bridge forwards to the activity (always called on the main thread). */
  interface Host {
    void applyBars(int color, boolean lightBackground);

    void showHubDialog();

    void showShellMenu();
  }

  private final Activity activity;
  private final Host host;
  private volatile boolean enabled;

  <T extends Activity & Host> OmniBridge(T activity) {
    this.activity = activity;
    this.host = activity;
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
        cm.setPrimaryClip(ClipData.newPlainText("Hermes", value));
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

  /**
   * Colors the status and navigation bars to match the page background (the web calls this on
   * load and on every theme change with its current --bg).
   *
   * @param hexColor {@code #RRGGBB}; anything else is ignored
   * @param lightBackground true when the color is light, so the bar icons must be dark
   * @return whether the color was accepted
   */
  @JavascriptInterface
  public boolean setBars(String hexColor, boolean lightBackground) {
    if (!enabled) return false;
    Integer color = parseRgb(hexColor);
    if (color == null) return false;
    activity.runOnUiThread(() -> host.applyBars(color, lightBackground));
    return true;
  }

  /** Opens the native hub-address dialog (Settings › 앱 › 허브 주소 변경). */
  @JavascriptInterface
  public void changeHubUrl() {
    if (enabled) activity.runOnUiThread(host::showHubDialog);
  }

  /** Opens the native shell menu (reload / hub address / log out). Kept for older web builds. */
  @JavascriptInterface
  public void openMenu() {
    if (enabled) activity.runOnUiThread(host::showShellMenu);
  }

  /** Parses {@code #RRGGBB} into an opaque ARGB int, or null. */
  static Integer parseRgb(String s) {
    if (s == null || s.length() != 7 || s.charAt(0) != '#') return null;
    int rgb = 0;
    for (int i = 1; i < 7; i++) {
      int d = Character.digit(s.charAt(i), 16);
      if (d < 0) return null;
      rgb = (rgb << 4) | d;
    }
    return 0xFF000000 | rgb;
  }
}
