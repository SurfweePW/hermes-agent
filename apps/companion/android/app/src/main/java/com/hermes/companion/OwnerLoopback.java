package com.hermes.companion;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/** One attempt, one listener, one verifier. No credentials are ever delivered through this HTTP surface. */
final class OwnerLoopback implements AutoCloseable {
    private final ServerSocket server;
    private final long deadline;
    private final String state = OwnerAuthPolicy.random();
    private String verifier = OwnerAuthPolicy.random();
    private final String path = "/owner-callback/" + OwnerAuthPolicy.random();
    private boolean consumed;
    private volatile Socket active;

    OwnerLoopback(int timeoutMillis) throws Exception {
        server = new ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"));
        deadline = System.nanoTime() + timeoutMillis * 1_000_000L;
    }

    String redirectUri() { return "http://127.0.0.1:" + server.getLocalPort() + path; }
    String state() { return state; }
    String challenge() throws Exception { return OwnerAuthPolicy.challenge(verifier); }

    synchronized String takeVerifier() {
        if (consumed || verifier == null) throw new IllegalStateException();
        consumed = true;
        String result = verifier;
        verifier = null;
        return result;
    }

    String awaitCode() throws Exception {
        while (!server.isClosed()) {
            long remaining = (deadline - System.nanoTime()) / 1_000_000L;
            if (remaining <= 0) throw new java.net.SocketTimeoutException();
            server.setSoTimeout((int) Math.min(remaining, Integer.MAX_VALUE));
            try (Socket socket = server.accept()) {
                active = socket;
                socket.setSoTimeout((int) Math.min(remaining, 2000));
                try {
                    String request = readHeaders(new OwnerDeadlineInput(socket.getInputStream(), socket,
                        Math.min(deadline, System.nanoTime() + 2_000_000_000L)), 8192);
                    String code = parseRequest(request, path, state, server.getLocalPort());
                    String body = "Sign-in received. You may return to Companion.";
                    String response = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nCache-Control: no-store\r\n"
                        + "Referrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'\r\nConnection: close\r\nContent-Length: "
                        + body.length() + "\r\n\r\n" + body;
                    socket.getOutputStream().write(response.getBytes(StandardCharsets.US_ASCII));
                    return code;
                } catch (IllegalArgumentException | java.io.IOException ignored) {
                    // Malformed, duplicate, wrong-state and slow local probes never consume this attempt.
                } finally { active = null; }
            }
        }
        throw new IllegalStateException();
    }

    static String readHeaders(InputStream input, int limit) throws java.io.IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        int last = 0;
        while (bytes.size() < limit) {
            int b = input.read();
            if (b == -1) throw new java.io.EOFException();
            bytes.write(b);
            last = (last << 8) | b;
            if (last == 0x0d0a0d0a) return bytes.toString(StandardCharsets.US_ASCII.name());
        }
        throw new java.io.IOException("Header limit");
    }

    static String parseRequest(String headers, String path, String state, int port) throws Exception {
        String[] lines = headers.split("\r\n");
        String[] first = lines[0].split(" ", -1);
        if (first.length != 3 || !"GET".equals(first[0]) || !"HTTP/1.1".equals(first[2])) throw new IllegalArgumentException();
        URI uri = URI.create(first[1]);
        if (uri.isAbsolute() || uri.getRawAuthority() != null || !path.equals(uri.getRawPath())
            || uri.getRawFragment() != null || uri.getRawQuery() == null) throw new IllegalArgumentException();
        int hosts = 0;
        for (int i = 1; i < lines.length; i++) {
            if (lines[i].toLowerCase(java.util.Locale.ROOT).startsWith("host:")) {
                hosts++;
                if (!lines[i].substring(5).trim().equals("127.0.0.1:" + port)) throw new IllegalArgumentException();
            }
        }
        if (hosts != 1) throw new IllegalArgumentException();
        Map<String, String> query = new HashMap<>();
        for (String pair : uri.getRawQuery().split("&")) {
            String[] kv = pair.split("=", 2);
            if (kv.length != 2) throw new IllegalArgumentException();
            String k = URLDecoder.decode(kv[0], "UTF-8");
            if (query.put(k, URLDecoder.decode(kv[1], "UTF-8")) != null) throw new IllegalArgumentException();
        }
        if (query.size() != 2 || !OwnerAuthPolicy.equal(state, query.get("state"))
            || query.get("code") == null || !query.get("code").matches("[A-Za-z0-9_-]{20,256}")) throw new IllegalArgumentException();
        return query.get("code");
    }

    @Override public synchronized void close() {
        verifier = null;
        consumed = true;
        try { server.close(); } catch (Exception ignored) { }
        Socket socket = active;
        if (socket != null) try { socket.close(); } catch (Exception ignored) { }
    }
}
