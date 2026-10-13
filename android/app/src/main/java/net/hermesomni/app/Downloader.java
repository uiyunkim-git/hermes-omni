package net.hermesomni.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.util.Log;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.widget.Toast;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * WebView downloads via the system DownloadManager, forwarding the hub session cookie.
 *
 * <p>Every download is a plain hub GET URL (the web UI never hands out blob:/data: URLs). The
 * completed-download notification opens the file; while the activity is alive a toast confirms
 * completion. APK downloads (the hub's /app/hermes-omni.apk self-update) are handed to the package
 * installer as soon as they complete.
 */
final class Downloader {
  private static final String TAG = "HermesOmni";
  static final String APK_MIME = "application/vnd.android.package-archive";

  private final Activity activity;
  private final DownloadManager dm;
  /** Downloads enqueued by this activity: id -> file name. */
  private final Map<Long, String> pending = new HashMap<>();
  private final Set<Long> pendingApks = new HashSet<>();
  private boolean registered;

  private final BroadcastReceiver onComplete = new BroadcastReceiver() {
    @Override public void onReceive(Context context, Intent intent) {
      long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
      String name = pending.remove(id);
      boolean apk = pendingApks.remove(id);
      if (name != null) onDownloaded(id, name, apk);
    }
  };

  Downloader(Activity activity) {
    this.activity = activity;
    this.dm = (DownloadManager) activity.getSystemService(Context.DOWNLOAD_SERVICE);
  }

  // Pre-33 platforms have no exported-state flag; the receiver is implicitly exported there.
  @SuppressLint("UnspecifiedRegisterReceiverFlag")
  void register() {
    if (registered) return;
    IntentFilter f = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
    // The broadcast comes from the DownloadProvider (another uid), so it must be exported.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      activity.registerReceiver(onComplete, f, Context.RECEIVER_EXPORTED);
    } else {
      activity.registerReceiver(onComplete, f);
    }
    registered = true;
  }

  void unregister() {
    if (!registered) return;
    activity.unregisterReceiver(onComplete);
    registered = false;
  }

  /** WebView DownloadListener entry point. */
  void start(String url, String userAgent, String contentDisposition, String mimeType) {
    Uri uri = Uri.parse(url);
    String scheme = uri.getScheme();
    if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) {
      // blob:/data: URLs only exist inside the renderer; DownloadManager cannot fetch them.
      Log.w(TAG, "unsupported download scheme: " + scheme);
      toast(activity.getString(R.string.download_unsupported));
      return;
    }
    String name = FileNames.fromContentDisposition(contentDisposition);
    if (name == null) name = FileNames.sanitize(URLUtil.guessFileName(url, contentDisposition, mimeType));
    if (name == null) name = "download";
    boolean apk = APK_MIME.equals(mimeType) || name.toLowerCase(Locale.ROOT).endsWith(".apk");
    if (apk) name = FileNames.withApkExtension(name);

    DownloadManager.Request r = new DownloadManager.Request(uri);
    String cookies = CookieManager.getInstance().getCookie(url);
    if (cookies != null && !cookies.isEmpty()) r.addRequestHeader("Cookie", cookies);
    if (userAgent != null) r.addRequestHeader("User-Agent", userAgent);
    r.setTitle(name);
    if (apk) r.setMimeType(APK_MIME);
    else if (mimeType != null && !mimeType.isEmpty()) r.setMimeType(mimeType);
    r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
    } else {
      // Public Downloads needs WRITE_EXTERNAL_STORAGE before Q; the app-specific dir does not.
      r.setDestinationInExternalFilesDir(activity, Environment.DIRECTORY_DOWNLOADS, name);
    }
    try {
      long id = dm.enqueue(r);
      pending.put(id, name);
      if (apk) pendingApks.add(id);
      Log.i(TAG, "download #" + id + " " + name);
      toast(activity.getString(R.string.download_started, name));
    } catch (RuntimeException e) {
      Log.w(TAG, "download enqueue failed", e);
      toast(activity.getString(R.string.download_failed, name));
    }
  }

  private void onDownloaded(long id, String name, boolean apk) {
    int status = -1;
    int reason = 0;
    try (Cursor c = dm.query(new DownloadManager.Query().setFilterById(id))) {
      if (c != null && c.moveToFirst()) {
        status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
        reason = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
      }
    } catch (RuntimeException e) {
      Log.w(TAG, "download #" + id + " query failed", e);
    }
    if (status != DownloadManager.STATUS_SUCCESSFUL) {
      // status -1: the user removed it from the notification before it finished.
      if (status != -1) {
        Log.w(TAG, "download #" + id + " failed: status=" + status + " reason=" + reason);
        toast(activity.getString(R.string.download_failed, name));
      }
      return;
    }
    if (!apk) {
      toast(activity.getString(R.string.download_done, name));
      return;
    }
    Uri file = dm.getUriForDownloadedFile(id);
    if (file == null) return;
    Intent install = new Intent(Intent.ACTION_VIEW)
        .setDataAndType(file, APK_MIME)
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
    try {
      activity.startActivity(install);
    } catch (ActivityNotFoundException e) {
      Log.w(TAG, "no package installer", e);
      toast(activity.getString(R.string.download_done, name));
    }
  }

  private void toast(String msg) {
    Toast.makeText(activity, msg, Toast.LENGTH_SHORT).show();
  }
}
