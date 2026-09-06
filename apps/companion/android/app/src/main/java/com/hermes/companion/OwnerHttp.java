package com.hermes.companion;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import javax.net.ssl.*;
import org.json.JSONObject;

/** Fixed-route HTTP, no ambient cookie jar, redirect following, or raw response errors. */
final class OwnerHttp {
    static final int MAX_BODY = 65536;
    static final class Failure extends IOException {
        final int status;
        Failure(int status) { super("Owner gateway request failed"); this.status = status; }
    }

    static JSONObject request(String base, String route, JSONObject body, String bearer) throws Exception {
        if (!Arrays.asList("/api/status", "/auth/native/token", "/auth/native/refresh", "/api/auth/ws-ticket").contains(route)) {
            throw new IllegalArgumentException();
        }
        URI uri = URI.create(base);
        boolean tls = "https".equals(uri.getScheme());
        int port = uri.getPort() == -1 ? (tls ? 443 : 80) : uri.getPort();
        Socket raw = new Socket();
        try {
            raw.connect(new InetSocketAddress(uri.getHost(), port), 15000);
            raw.setSoTimeout(15000);
            Socket connection = raw;
            if (tls) {
                SSLSocket ssl = (SSLSocket) ((SSLSocketFactory) SSLSocketFactory.getDefault())
                    .createSocket(raw, uri.getHost(), port, true);
                SSLParameters parameters = ssl.getSSLParameters();
                parameters.setEndpointIdentificationAlgorithm("HTTPS");
                ssl.setSSLParameters(parameters);
                ssl.startHandshake();
                connection = ssl;
            }
            try (Socket socket = connection) {
                byte[] payload = body == null ? new byte[0] : body.toString().getBytes(StandardCharsets.UTF_8);
                if (bearer != null && !GatewayTokenValidator.isValid(bearer)) throw new IllegalArgumentException();
                String headers = (body == null ? "GET " : "POST ") + uri.getRawPath() + route
                    + " HTTP/1.1\r\nHost: " + uri.getRawAuthority() + "\r\nAccept: application/json\r\nConnection: close\r\n"
                    + (bearer == null ? "" : "Authorization: Bearer " + bearer + "\r\n")
                    + (body == null ? "" : "Content-Type: application/json\r\nContent-Length: " + payload.length + "\r\n") + "\r\n";
                socket.getOutputStream().write(headers.getBytes(StandardCharsets.US_ASCII));
                socket.getOutputStream().write(payload);
                socket.getOutputStream().flush();
                InputStream in = new OwnerDeadlineInput(socket.getInputStream(), socket, System.nanoTime() + 30_000_000_000L);
                String[] lines = OwnerLoopback.readHeaders(in, 16384).split("\r\n");
                String[] status = lines[0].split(" ", 3);
                if (status.length < 2 || !status[0].matches("HTTP/1\\.[01]")) throw new IOException();
                int code = Integer.parseInt(status[1]);
                if (code != 200) throw new Failure(code); // Includes ALL redirects. Never replay credentials elsewhere.
                Map<String, String> h = new HashMap<>();
                for (int i = 1; i < lines.length; i++) {
                    String[] pair = lines[i].split(":", 2);
                    if (pair.length != 2) throw new IOException();
                    String key = pair[0].toLowerCase(Locale.ROOT);
                    if (h.put(key, pair[1].trim()) != null && (key.equals("content-length") || key.equals("transfer-encoding"))) throw new IOException();
                }
                return new JSONObject(new String(readBody(in, h), StandardCharsets.UTF_8));
            }
        } finally { raw.close(); }
    }

    static byte[] readBody(InputStream in, Map<String, String> headers) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        String transfer = headers.get("transfer-encoding");
        if (transfer != null) {
            if (!"chunked".equalsIgnoreCase(transfer) || headers.containsKey("content-length")) throw new IOException();
            while (true) {
                String size = readLine(in);
                int semi = size.indexOf(';');
                int n = Integer.parseInt(semi < 0 ? size : size.substring(0, semi), 16);
                if (n == 0) break;
                copy(in, out, n);
                if (!readLine(in).isEmpty()) throw new IOException();
            }
        } else if (headers.containsKey("content-length")) {
            copy(in, out, Integer.parseInt(headers.get("content-length")));
        } else {
            int b;
            while ((b = in.read()) != -1) {
                if (out.size() >= MAX_BODY) throw new IOException();
                out.write(b);
            }
        }
        return out.toByteArray();
    }
    private static void copy(InputStream in, ByteArrayOutputStream out, int n) throws IOException {
        if (n < 0 || n > MAX_BODY - out.size()) throw new IOException();
        byte[] data = new byte[n]; new DataInputStream(in).readFully(data); out.write(data);
    }
    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        while (out.size() < 1024) {
            int b = in.read(); if (b < 0) throw new EOFException();
            if (b == '\r') { if (in.read() != '\n') throw new IOException(); return out.toString("US-ASCII"); }
            out.write(b);
        }
        throw new IOException();
    }
}
