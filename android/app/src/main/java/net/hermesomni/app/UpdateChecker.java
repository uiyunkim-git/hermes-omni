package net.hermesomni.app;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Fetches {@code <hub>/app/meta.json} (public, written by scripts/build-apk.sh) on a background
 * thread and reports a newer build on the main thread.
 *
 * <p>The request is cookie-less: HttpURLConnection does not share the WebView CookieManager and no
 * java.net.CookieHandler is installed.
 */
final class UpdateChecker {
  private static final String TAG = "HermesOmni";
  private static final int TIMEOUT_MS = 5000;
  private static final int MAX_BYTES = 16 * 1024;

  /** Published build info from meta.json. */
  static final class Meta {
    final int versionCode;
    final String versionName;
    final long size;

    Meta(int versionCode, String versionName, long size) {
      this.versionCode = versionCode;
      this.versionName = versionName;
      this.size = size;
    }
  }

  interface Callback {
    /** Called on the main thread when the published build is newer than this one. */
    void onUpdateAvailable(Meta meta);
  }

  private final Handler ui = new Handler(Looper.getMainLooper());
  private volatile boolean running;

  /** Starts a check unless one is already running. */
  void check(String hubUrl, Callback cb) {
    if (hubUrl == null || running) return;
    running = true;
    Thread t = new Thread(() -> {
      try {
        Meta m = fetch(hubUrl + "/app/meta.json");
        if (m != null && m.versionCode > BuildConfig.VERSION_CODE) ui.post(() -> cb.onUpdateAvailable(m));
      } catch (IOException | JSONException | RuntimeException e) {
        Log.i(TAG, "update check failed: " + e);
      } finally {
        running = false;
      }
    }, "omni-update-check");
    t.setDaemon(true);
    t.start();
  }

  private static Meta fetch(String url) throws IOException, JSONException {
    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
    try {
      c.setConnectTimeout(TIMEOUT_MS);
      c.setReadTimeout(TIMEOUT_MS);
      c.setUseCaches(false);
      c.setInstanceFollowRedirects(false);
      c.setRequestProperty("Accept", "application/json");
      if (c.getResponseCode() != HttpURLConnection.HTTP_OK) return null;   // 404: no APK published
      ByteArrayOutputStream out = new ByteArrayOutputStream();
      try (InputStream in = c.getInputStream()) {
        byte[] buf = new byte[4096];
        int n;
        while ((n = in.read(buf)) != -1) {
          if (out.size() + n > MAX_BYTES) throw new IOException("meta.json too large");
          out.write(buf, 0, n);
        }
      }
      JSONObject o = new JSONObject(new String(out.toByteArray(), StandardCharsets.UTF_8));
      int code = o.optInt("version_code", 0);
      String name = o.optString("version_name", "");
      if (code <= 0 || name.isEmpty()) return null;
      return new Meta(code, name, o.optLong("size", 0));
    } finally {
      c.disconnect();
    }
  }
}
