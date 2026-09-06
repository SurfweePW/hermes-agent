package com.hermes.companion;

import org.junit.Test;
import static org.junit.Assert.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;

public class OwnerAuthSecurityTest {
    @Test public void pkceMatchesRfc7636VectorAndRandomStateIsIndependent() throws Exception {
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            OwnerAuthPolicy.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"));
        String first = OwnerAuthPolicy.random(), second = OwnerAuthPolicy.random();
        assertTrue(first.matches("[A-Za-z0-9_-]{43}"));
        assertNotEquals(first, second);
        assertFalse(OwnerAuthPolicy.equal(first, second));
        assertTrue(OwnerAuthPolicy.equal(first, first));
    }

    @Test public void nativePolicyAllowsCleartextOnlyOnTrueLoopback() {
        assertEquals("https://gateway.ts.net/base", OwnerAuthPolicy.baseUrl(" https://gateway.ts.net:443/base/api/ws/ ", false));
        assertEquals("http://127.0.0.1:8080", OwnerAuthPolicy.baseUrl("http://127.0.0.1:8080/", false));
        assertEquals("http://localhost", OwnerAuthPolicy.baseUrl("http://localhost/", false));
        assertEquals("http://[::1]:8642", OwnerAuthPolicy.baseUrl("http://[::1]:8642/", true));
        for (String url : Arrays.asList("http://100.64.0.1", "http://10.0.0.1", "http://192.168.1.2", "http://172.16.0.1", "http://example.com")) {
            assertThrows(IllegalArgumentException.class, () -> OwnerAuthPolicy.baseUrl(url, true));
        }
        for (String url : Arrays.asList("http://127.0.0.1.evil.com",
            "http://100.064.0.1", "https://u:p@host", "https://host/?ticket=secret", "https://host/#secret",
            "https://host/a/../b", "https://host/%2e%2e", "https://host:0", "file:///tmp/login")) {
            assertThrows(IllegalArgumentException.class, () -> OwnerAuthPolicy.baseUrl(url, true));
        }
    }

    private static String request(String path, String query, String host) {
        return "GET " + path + "?" + query + " HTTP/1.1\r\nHost: " + host + "\r\n\r\n";
    }

    @Test public void callbackRequiresExactPathHostStateAndOnlyCodeState() throws Exception {
        String code = "A".repeat(43), state = "state", path = "/owner-callback/random";
        String query = "code=" + code + "&state=" + state;
        assertEquals(code, OwnerLoopback.parseRequest(request(path, query, "127.0.0.1:40000"), path, state, 40000));
        for (String bad : Arrays.asList(
            request(path, query + "&access_token=secret", "127.0.0.1:40000"),
            request(path, query + "&state=state", "127.0.0.1:40000"),
            request(path, query + "&%73tate=state", "127.0.0.1:40000"),
            request(path, "code=" + code + "&state=wrong", "127.0.0.1:40000"),
            request(path, query, "evil.example:40000"),
            request("/other", query, "127.0.0.1:40000"),
            request("http://127.0.0.1:40000" + path, query, "127.0.0.1:40000"),
            request(path, "code=bad%0aheader&state=state", "127.0.0.1:40000"),
            request(path, query, "127.0.0.1:40000").replace("GET ", "POST "))) {
            assertThrows(IllegalArgumentException.class, () -> OwnerLoopback.parseRequest(bad, path, state, 40000));
        }
    }

    @Test public void realLoopbackRejectsProbeThenAcceptsAndVerifierIsSingleUse() throws Exception {
        ExecutorService worker = Executors.newSingleThreadExecutor();
        try (OwnerLoopback attempt = new OwnerLoopback(5000)) {
            URI uri = URI.create(attempt.redirectUri());
            assertEquals("127.0.0.1", uri.getHost());
            Future<String> code = worker.submit(attempt::awaitCode);
            String value = "B".repeat(43);
            exchange(uri, "code=" + value + "&state=wrong");
            String response = exchange(uri, "code=" + value + "&state=" + attempt.state());
            assertTrue(response.startsWith("HTTP/1.1 200"));
            assertFalse(response.contains(value));
            assertFalse(response.contains(attempt.state()));
            assertTrue(response.contains("Cache-Control: no-store"));
            assertEquals(value, code.get(2, TimeUnit.SECONDS));
            String challenge = attempt.challenge();
            assertEquals(challenge, OwnerAuthPolicy.challenge(attempt.takeVerifier()));
            assertThrows(IllegalStateException.class, attempt::takeVerifier);
        } finally { worker.shutdownNow(); }
    }

    private static String exchange(URI uri, String query) throws Exception {
        try (Socket s = new Socket(uri.getHost(), uri.getPort())) {
            s.setSoTimeout(3000);
            s.getOutputStream().write(request(uri.getPath(), query, uri.getAuthority()).getBytes(StandardCharsets.US_ASCII));
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            int b; while ((b = s.getInputStream().read()) != -1) out.write(b);
            return out.toString("US-ASCII");
        }
    }

    @Test public void loopbackTimesOutAndCancellationClosesPort() throws Exception {
        try (OwnerLoopback attempt = new OwnerLoopback(30)) {
            assertThrows(SocketTimeoutException.class, attempt::awaitCode);
        }
        OwnerLoopback cancelled = new OwnerLoopback(5000);
        URI uri = URI.create(cancelled.redirectUri());
        cancelled.close();
        assertThrows(IllegalStateException.class, cancelled::takeVerifier);
        assertThrows(IOException.class, () -> { try (Socket ignored = new Socket(uri.getHost(), uri.getPort())) { } });
    }

    @Test public void headerAndBodyParsersBoundUntrustedGatewayInput() throws Exception {
        assertThrows(IOException.class, () -> OwnerLoopback.readHeaders(new ByteArrayInputStream(new byte[100]), 99));
        Map<String, String> chunked = Collections.singletonMap("transfer-encoding", "chunked");
        assertArrayEquals("hello".getBytes(StandardCharsets.US_ASCII), OwnerHttp.readBody(
            new ByteArrayInputStream("5\r\nhello\r\n0\r\n\r\n".getBytes(StandardCharsets.US_ASCII)), chunked));
        assertThrows(IOException.class, () -> OwnerHttp.readBody(new ByteArrayInputStream(new byte[0]),
            Collections.singletonMap("content-length", "65537")));
        Map<String, String> ambiguous = new HashMap<>(chunked); ambiguous.put("content-length", "5");
        assertThrows(IOException.class, () -> OwnerHttp.readBody(new ByteArrayInputStream(new byte[0]), ambiguous));
        assertThrows(IOException.class, () -> OwnerHttp.readBody(new ByteArrayInputStream(new byte[0]),
            Collections.singletonMap("transfer-encoding", "gzip")));
    }

    @Test public void nativeHttpNeverFollowsRedirectOrUsesAmbientCookies() throws Exception {
        ExecutorService worker = Executors.newSingleThreadExecutor();
        CookieHandler previous = CookieHandler.getDefault();
        CookieHandler.setDefault(new CookieManager());
        try (ServerSocket server = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
            Future<String> observed = worker.submit(() -> {
                try (Socket socket = server.accept()) {
                    String headers = OwnerLoopback.readHeaders(socket.getInputStream(), 16384);
                    socket.getOutputStream().write("HTTP/1.1 302 Found\r\nLocation: https://evil.example/\r\nContent-Length: 0\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
                    return headers;
                }
            });
            OwnerHttp.Failure error = assertThrows(OwnerHttp.Failure.class, () -> OwnerHttp.request(
                "http://127.0.0.1:" + server.getLocalPort(), "/api/status", null, "disposable-test-bearer"));
            assertEquals(302, error.status);
            String headers = observed.get(2, TimeUnit.SECONDS);
            assertTrue(headers.contains("Authorization: Bearer disposable-test-bearer\r\n"));
            assertFalse(headers.contains("Cookie:"));
            assertFalse(error.getMessage().contains("evil"));
            assertThrows(IllegalArgumentException.class, () -> OwnerHttp.request("https://example.com", "/arbitrary", null, null));
        } finally { CookieHandler.setDefault(previous); worker.shutdownNow(); }
    }
}
