package net.hermesomni.app;

import java.io.ByteArrayOutputStream;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Download file names from Content-Disposition headers.
 *
 * <p>URLUtil.guessFileName ignores RFC 6266/5987 {@code filename*=UTF-8''...}, which the hub uses
 * for non-ASCII (Korean) names, so that form is parsed here first. Pure Java (no android.*) so it
 * can be unit-tested on a plain JVM.
 */
final class FileNames {
  private static final Pattern EXT_VALUE = Pattern.compile(
      "(?i)(?:^|;)\\s*filename\\*\\s*=\\s*([A-Za-z0-9!#$&+.^_`|~-]+)'[^']*'([^;\\s]+)");
  private static final Pattern QUOTED = Pattern.compile(
      "(?i)(?:^|;)\\s*filename\\s*=\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
  private static final Pattern TOKEN = Pattern.compile("(?i)(?:^|;)\\s*filename\\s*=\\s*([^;\"\\s]+)");
  private static final int MAX_NAME = 120;

  private FileNames() {}

  /** The file name from a Content-Disposition value, sanitized, or null when there is none. */
  static String fromContentDisposition(String cd) {
    if (cd == null || cd.isEmpty()) return null;
    Matcher m = EXT_VALUE.matcher(cd);
    if (m.find()) {
      String name = percentDecode(m.group(2), charset(m.group(1)));
      if (name != null) {
        String s = sanitize(name);
        if (s != null) return s;
      }
    }
    m = QUOTED.matcher(cd);
    if (m.find()) return sanitize(m.group(1).replaceAll("\\\\(.)", "$1"));
    m = TOKEN.matcher(cd);
    if (m.find()) return sanitize(m.group(1));
    return null;
  }

  /**
   * Makes a name safe as a single path component: strips directories and control characters,
   * replaces characters that Android's public Downloads directory rejects, and caps the length
   * while keeping the extension. Returns null if nothing usable is left.
   */
  static String sanitize(String name) {
    if (name == null) return null;
    String s = name.replace('\\', '/');
    s = s.substring(s.lastIndexOf('/') + 1);
    StringBuilder b = new StringBuilder(s.length());
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      if (c < 0x20 || c == 0x7f) continue;
      b.append("<>:\"|?*".indexOf(c) >= 0 ? '_' : c);
    }
    s = b.toString().trim();
    while (s.startsWith(".")) s = s.substring(1);
    if (s.isEmpty()) return null;
    if (s.length() > MAX_NAME) {
      int dot = s.lastIndexOf('.');
      String ext = dot > 0 && s.length() - dot <= 10 ? s.substring(dot) : "";
      s = s.substring(0, MAX_NAME - ext.length()) + ext;
    }
    return s;
  }

  /** Forces an .apk extension (installers ignore files without it). */
  static String withApkExtension(String name) {
    if (name.toLowerCase(Locale.ROOT).endsWith(".apk")) return name;
    return name.replaceFirst("\\.[^.]*$", "") + ".apk";
  }

  private static Charset charset(String name) {
    try {
      return Charset.forName(name);
    } catch (IllegalArgumentException e) {
      return StandardCharsets.UTF_8;
    }
  }

  private static String percentDecode(String s, Charset cs) {
    ByteArrayOutputStream out = new ByteArrayOutputStream(s.length());
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      if (c == '%') {
        if (i + 2 >= s.length()) return null;
        int hi = Character.digit(s.charAt(i + 1), 16);
        int lo = Character.digit(s.charAt(i + 2), 16);
        if (hi < 0 || lo < 0) return null;
        out.write((hi << 4) | lo);
        i += 2;
      } else if (c < 0x80) {
        out.write(c);
      } else {
        return null;   // RFC 5987 values are ASCII-only
      }
    }
    return new String(out.toByteArray(), cs);
  }
}
