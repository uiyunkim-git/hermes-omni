package net.hermesomni.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Minimal content provider for camera captures from the WebView file chooser.
 *
 * <p>Serves only {@code content://<pkg>.capture/capture/<name>.jpg}, backed by {@code
 * cacheDir/capture/<name>.jpg}. It is not exported; the camera app gets a per-URI grant. This
 * replaces androidx FileProvider (the shell has no AndroidX dependency).
 */
public final class CaptureProvider extends ContentProvider {
  static final String DIR = "capture";
  private static final Pattern NAME = Pattern.compile("[A-Za-z0-9_-]{1,64}\\.jpg");
  private static final long MAX_AGE_MS = 24L * 60 * 60 * 1000;

  static String authority(Context context) {
    return context.getPackageName() + ".capture";
  }

  /** Returns a content URI for a new capture (the camera app creates the file through openFile). */
  static Uri newCapture(Context context) {
    File dir = new File(context.getCacheDir(), DIR);
    if (!dir.isDirectory() && !dir.mkdirs()) return null;
    String name = "IMG_" + System.currentTimeMillis() + ".jpg";
    return new Uri.Builder().scheme("content").authority(authority(context))
        .appendPath(DIR).appendPath(name).build();
  }

  /** The backing file of a capture URI, or null when the URI is not one of ours. */
  static File fileFor(Context context, Uri uri) {
    if (uri == null || !"content".equals(uri.getScheme())
        || !authority(context).equals(uri.getAuthority())) {
      return null;
    }
    List<String> seg = uri.getPathSegments();
    if (seg.size() != 2 || !DIR.equals(seg.get(0)) || !NAME.matcher(seg.get(1)).matches()) return null;
    return new File(new File(context.getCacheDir(), DIR), seg.get(1));
  }

  /**
   * Deletes captures older than a day. Recent ones are kept: the page reads a picked file lazily,
   * possibly long after the chooser returned.
   */
  static void pruneOld(Context context) {
    File[] files = new File(context.getCacheDir(), DIR).listFiles();
    if (files == null) return;
    long cutoff = System.currentTimeMillis() - MAX_AGE_MS;
    for (File f : files) {
      if (f.lastModified() < cutoff) {
        //noinspection ResultOfMethodCallIgnored
        f.delete();
      }
    }
  }

  @Override
  public boolean onCreate() {
    return true;
  }

  /** getContext() with a null check (ContentProvider.requireContext() needs API 30). */
  private Context ctx() {
    Context c = getContext();
    if (c == null) throw new IllegalStateException("provider not attached");
    return c;
  }

  @Override
  public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
    File f = fileFor(ctx(), uri);
    if (f == null) throw new FileNotFoundException("not a capture URI");
    return ParcelFileDescriptor.open(f, ParcelFileDescriptor.parseMode(mode));
  }

  @Override
  public String getType(Uri uri) {
    return fileFor(ctx(), uri) != null ? "image/jpeg" : null;
  }

  @Override
  public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs,
      String sortOrder) {
    File f = fileFor(ctx(), uri);
    if (f == null) return null;
    String[] cols = projection != null ? projection
        : new String[] {OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
    MatrixCursor c = new MatrixCursor(cols, 1);
    Object[] row = new Object[cols.length];
    for (int i = 0; i < cols.length; i++) {
      if (OpenableColumns.DISPLAY_NAME.equals(cols[i])) row[i] = f.getName();
      else if (OpenableColumns.SIZE.equals(cols[i])) row[i] = f.length();
    }
    c.addRow(row);
    return c;
  }

  @Override
  public Uri insert(Uri uri, ContentValues values) {
    throw new UnsupportedOperationException("read/write of existing captures only");
  }

  @Override
  public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
    throw new UnsupportedOperationException("read/write of existing captures only");
  }

  @Override
  public int delete(Uri uri, String selection, String[] selectionArgs) {
    File f = fileFor(ctx(), uri);
    return f != null && f.delete() ? 1 : 0;
  }
}
