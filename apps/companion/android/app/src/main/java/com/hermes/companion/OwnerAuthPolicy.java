package com.hermes.companion;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import android.util.Base64;

/** Native validation is independent of (and cannot be bypassed by) renderer settings. */
final class OwnerAuthPolicy {
    private OwnerAuthPolicy() {}

    static String baseUrl(String input, boolean debug) {
        if (input == null || input.length() > 2048) throw new IllegalArgumentException();
        URI uri = URI.create(input.trim());
        String host = uri.getHost();
        if (host == null || uri.getRawUserInfo() != null || uri.getRawQuery() != null
            || uri.getRawFragment() != null || uri.getPort() == 0 || uri.getPort() > 65535) {
            throw new IllegalArgumentException();
        }
        if (!"https".equals(uri.getScheme()) && !("http".equals(uri.getScheme()) && isLoopback(host))) {
            throw new IllegalArgumentException();
        }
        String path = uri.getRawPath().replaceAll("/+$", "");
        // Avoid reverse-proxy path ambiguity and never accept encoded separators / traversal.
        if (path.contains("%") || path.contains("\\") || path.contains("//")
            || !uri.normalize().getRawPath().equals(uri.getRawPath())) throw new IllegalArgumentException();
        if (path.toLowerCase(java.util.Locale.ROOT).endsWith("/api/ws")) path = path.substring(0, path.length() - 7);
        int port = uri.getPort();
        String normalizedHost = unbracketedHost(host).toLowerCase(java.util.Locale.ROOT);
        String authority = (normalizedHost.contains(":") ? "[" + normalizedHost + "]" : normalizedHost)
            + ((port == -1 || ("https".equals(uri.getScheme()) && port == 443)
                || ("http".equals(uri.getScheme()) && port == 80)) ? "" : ":" + port);
        return uri.getScheme() + "://" + authority + path;
    }

    static boolean isLoopback(String host) {
        host = unbracketedHost(host);
        if ("localhost".equalsIgnoreCase(host) || "::1".equals(host)) return true;
        String[] parts = host.split("\\.", -1);
        if (parts.length != 4) return false;
        int[] n = new int[4];
        for (int i = 0; i < 4; i++) {
            if (!parts[i].matches("0|[1-9][0-9]{0,2}")) return false;
            n[i] = Integer.parseInt(parts[i]);
            if (n[i] > 255) return false;
        }
        return n[0] == 127;
    }

    private static String unbracketedHost(String host) {
        if (host != null && host.length() > 2 && host.charAt(0) == '[' && host.charAt(host.length() - 1) == ']') {
            return host.substring(1, host.length() - 1);
        }
        return host;
    }

    static String random() {
        byte[] bytes = new byte[32];
        new SecureRandom().nextBytes(bytes);
        return encodeUrlSafe(bytes);
    }

    static String challenge(String verifier) throws Exception {
        return encodeUrlSafe(
            MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII)));
    }

    // android.util.Base64 is API-gated in lint and stubbed in JVM unit tests; java.util.Base64 needs API 26.
    // RFC 4648 base64url (unpadded) in plain Java: works on both, minSdk 24, no desugaring needed.
    private static final char[] B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".toCharArray();

    private static String encodeUrlSafe(byte[] bytes) {
        StringBuilder out = new StringBuilder((bytes.length * 4 + 2) / 3);
        for (int i = 0; i < bytes.length; i += 3) {
            int chunk = (bytes[i] & 0xFF) << 16 | (i + 1 < bytes.length ? (bytes[i + 1] & 0xFF) << 8 : 0)
                | (i + 2 < bytes.length ? bytes[i + 2] & 0xFF : 0);
            out.append(B64URL[(chunk >> 18) & 63]).append(B64URL[(chunk >> 12) & 63]);
            if (i + 1 < bytes.length) out.append(B64URL[(chunk >> 6) & 63]);
            if (i + 2 < bytes.length) out.append(B64URL[chunk & 63]);
        }
        return out.toString();
    }

    static boolean equal(String a, String b) {
        return a != null && b != null && MessageDigest.isEqual(
            a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8));
    }
}
