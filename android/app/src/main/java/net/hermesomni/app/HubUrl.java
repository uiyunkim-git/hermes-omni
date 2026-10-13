package net.hermesomni.app;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/**
 * Hub URL parsing, origin comparison and network classification.
 *
 * <p>Pure java.net code (no android.*) so it can be unit-tested on a plain JVM.
 */
final class HubUrl {

  /** Where a host lives, used only to warn about hub URLs outside the tailnet/LAN. */
  enum Kind { TAILNET, LAN, OTHER }

  private HubUrl() {}

  /**
   * Normalizes user input to {@code scheme://host[:port][/path]} without a trailing slash, query or
   * fragment. A missing scheme defaults to http (the tailnet has no TLS certificates).
   *
   * @return the normalized URL, or null when the input is not a usable http(s) URL
   */
  static String normalize(String input) {
    if (input == null) return null;
    String s = input.trim();
    if (s.isEmpty()) return null;
    if (!s.contains("://")) s = "http://" + s;
    URI u;
    try {
      u = new URI(s);
    } catch (URISyntaxException e) {
      return null;
    }
    String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
    if (!scheme.equals("http") && !scheme.equals("https")) return null;
    String host = u.getHost();
    if (host == null || host.isEmpty() || u.getRawUserInfo() != null) return null;
    StringBuilder b = new StringBuilder(scheme).append("://").append(host.toLowerCase(Locale.ROOT));
    int port = u.getPort();
    if (port != -1 && port != defaultPort(scheme)) b.append(':').append(port);
    String path = u.getRawPath() == null ? "" : u.getRawPath().replaceAll("/+$", "");
    return b.append(path).toString();
  }

  /** Returns {@code scheme://host[:port]} (lowercase, default port elided) or null. */
  static String origin(String url) {
    if (url == null) return null;
    String s = url;
    // blob:http://host/uuid belongs to the origin of the inner URL.
    if (s.regionMatches(true, 0, "blob:", 0, 5)) s = s.substring(5);
    URI u;
    try {
      u = new URI(s);
    } catch (URISyntaxException e) {
      return null;
    }
    String scheme = u.getScheme() == null ? null : u.getScheme().toLowerCase(Locale.ROOT);
    if (scheme == null || u.getHost() == null) return null;
    if (!scheme.equals("http") && !scheme.equals("https")) return null;
    int port = u.getPort();
    String hostPart = u.getHost().toLowerCase(Locale.ROOT);
    return scheme + "://" + hostPart + (port == -1 || port == defaultPort(scheme) ? "" : ":" + port);
  }

  static boolean sameOrigin(String url, String hubUrl) {
    String a = origin(url);
    return a != null && a.equals(origin(hubUrl));
  }

  /** Host part of an http(s) URL, or null. */
  static String host(String url) {
    try {
      String h = new URI(url).getHost();
      return h == null ? null : h.toLowerCase(Locale.ROOT);
    } catch (URISyntaxException e) {
      return null;
    }
  }

  static Kind classify(String host) {
    if (host == null || host.isEmpty()) return Kind.OTHER;
    String h = host.toLowerCase(Locale.ROOT);
    if (h.startsWith("[") && h.endsWith("]")) h = h.substring(1, h.length() - 1);
    if (h.endsWith(".")) h = h.substring(0, h.length() - 1);

    if (h.endsWith(".ts.net")) return Kind.TAILNET;
    int[] ip = parseIpv4(h);
    if (ip != null) {
      if (ip[0] == 100 && ip[1] >= 64 && ip[1] <= 127) return Kind.TAILNET;   // 100.64.0.0/10
      if (ip[0] == 10 || ip[0] == 127) return Kind.LAN;
      if (ip[0] == 172 && ip[1] >= 16 && ip[1] <= 31) return Kind.LAN;
      if (ip[0] == 192 && ip[1] == 168) return Kind.LAN;
      if (ip[0] == 169 && ip[1] == 254) return Kind.LAN;
      return Kind.OTHER;
    }
    if (h.contains(":")) {                                   // IPv6 literal
      if (h.startsWith("fd7a:115c:a1e0:")) return Kind.TAILNET;   // Tailscale ULA range
      if (h.equals("::1") || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) {
        return Kind.LAN;
      }
      return Kind.OTHER;
    }
    // Single-label names (MagicDNS short names, "nas") and local suffixes.
    if (!h.contains(".") || h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".home.arpa")
        || h.endsWith(".internal")) {
      return Kind.LAN;
    }
    return Kind.OTHER;
  }

  private static int[] parseIpv4(String h) {
    String[] p = h.split("\\.", -1);
    if (p.length != 4) return null;
    int[] out = new int[4];
    for (int i = 0; i < 4; i++) {
      if (p[i].isEmpty() || p[i].length() > 3) return null;
      for (int j = 0; j < p[i].length(); j++) {
        if (!Character.isDigit(p[i].charAt(j))) return null;
      }
      out[i] = Integer.parseInt(p[i]);
      if (out[i] > 255) return null;
    }
    return out;
  }

  private static int defaultPort(String scheme) {
    return scheme.equals("https") ? 443 : 80;
  }
}
