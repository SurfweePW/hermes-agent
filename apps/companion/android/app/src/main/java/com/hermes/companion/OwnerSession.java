package com.hermes.companion;

import android.content.Context;
import com.getcapacitor.JSObject;
import org.json.JSONArray;
import org.json.JSONObject;
import java.net.URI;
import java.net.URLEncoder;
import java.util.LinkedHashMap;
import java.util.Map;

/** Owns credentials; the bridge receives only status or a single-use WS ticket. */
final class OwnerSession implements AutoCloseable {
    interface Browser { void open(String url) throws Exception; }
    static final class Unsupported extends Exception { }
    private final Context context;
    private volatile OwnerLoopback pending;
    private String pendingBase;
    private long generation;
    private volatile boolean destroyed;

    OwnerSession(Context context) { this.context = context; }

    private KeystoreTokenStore store(String base) throws Exception { return new KeystoreTokenStore(context, base); }

    private void requireSupport(String base) throws Exception {
        JSONObject status;
        try { status = OwnerHttp.request(base, "/api/status", null, null); }
        catch (OwnerHttp.Failure failure) {
            if (failure.status == 404 || failure.status == 405 || failure.status == 501) throw new Unsupported();
            throw failure;
        }
        JSONArray flows = status.optJSONArray("auth_flows");
        if (flows != null) for (int i = 0; i < flows.length(); i++) {
            if ("native_pkce".equals(flows.optString(i))) return;
        }
        throw new Unsupported();
    }

    JSObject signIn(String base, Browser browser) throws Exception {
        final OwnerLoopback attempt;
        final long version;
        synchronized (this) {
            if (destroyed || pending != null) throw new IllegalStateException();
            attempt = new OwnerLoopback(180000);
            pending = attempt;
            pendingBase = base;
            version = ++generation;
        }
        try (OwnerLoopback ignored = attempt) {
            requireSupport(base);
            String url = base + "/auth/native/authorize?code_challenge_method=S256&code_challenge="
                + attempt.challenge() + "&state=" + attempt.state() + "&redirect_uri="
                + URLEncoder.encode(attempt.redirectUri(), "UTF-8");
            synchronized (this) { ensureCurrent(attempt, version); }
            browser.open(url); // ACTION_VIEW only; no embedded login, passwords, cookie scraping, or fallback.
            String code = attempt.awaitCode();
            String verifier = attempt.takeVerifier();
            JSONObject credentials = OwnerHttp.request(base, "/auth/native/token",
                new JSONObject().put("code", code).put("code_verifier", verifier), null);
            synchronized (this) {
                ensureCurrent(attempt, version);
                save(base, credentials);
                return statusResult(base, true, true);
            }
        } finally {
            synchronized (this) {
                if (pending == attempt) { pending = null; pendingBase = null; }
            }
        }
    }

    private void ensureCurrent(OwnerLoopback attempt, long version) {
        if (destroyed || pending != attempt || generation != version) throw new IllegalStateException();
    }

    synchronized JSObject status(String base) throws Exception {
        if (destroyed) throw new IllegalStateException();
        try { requireSupport(base); }
        catch (Unsupported ignored) { return statusResult(base, false, false); }
        return statusResult(base, credentials(base) != null, true);
    }

    synchronized JSObject signOut(String base) throws Exception {
        if (pending != null && base.equals(pendingBase)) {
            generation++;
            pending.close();
            pending = null;
            pendingBase = null;
        }
        store(base).reset();
        // Local sign-out only: do not log out the user's system browser or revoke unrelated sessions.
        return statusResult(base, false, true);
    }

    synchronized JSObject webSocketUrl(String base) throws Exception {
        if (destroyed) throw new IllegalStateException();
        requireSupport(base);
        JSONObject credentials = credentials(base);
        if (credentials == null) throw new IllegalStateException();
        JSONObject response;
        try {
            response = OwnerHttp.request(base, "/api/auth/ws-ticket", new JSONObject(), credentials.getString("access_token"));
        } catch (OwnerHttp.Failure failure) {
            if (failure.status == 401 || failure.status == 403) store(base).reset();
            throw failure;
        }
        String ticket = response.getString("ticket");
        if (!ticket.matches("[A-Za-z0-9_-]{20,512}")) throw new IllegalStateException();
        // The only credential intentionally exposed: gateway-issued, single-use, 30s WS bootstrap ticket.
        URI baseUri = URI.create(base);
        String path = baseUri.getRawPath().replaceAll("/+$", "") + "/api/ws";
        URI socket = new URI("https".equals(baseUri.getScheme()) ? "wss" : "ws", null,
            baseUri.getHost(), baseUri.getPort(), path, "ticket=" + ticket, null);
        JSObject result = new JSObject();
        result.put("value", socket.toASCIIString());
        return result;
    }

    private JSONObject credentials(String base) throws Exception {
        String saved = store(base).get();
        if (saved == null) return null; // Shared gateway token storage is deliberately never consulted.
        JSONObject data = new JSONObject(saved);
        if (data.getLong("expires_at") > System.currentTimeMillis() / 1000 + 60) return data;
        String refresh = data.optString("refresh_token", "");
        if (refresh.isEmpty()) { store(base).reset(); return null; }
        try {
            JSONObject fresh = OwnerHttp.request(base, "/auth/native/refresh", new JSONObject()
                .put("refresh_token", refresh).put("provider", data.getString("provider")), null);
            save(base, fresh);
            return fresh;
        } catch (OwnerHttp.Failure failure) {
            if (failure.status == 400 || failure.status == 401 || failure.status == 403) {
                store(base).reset(); return null;
            }
            throw failure; // Transient network/provider failure is NOT expiry and must not erase credentials.
        }
    }

    private void save(String base, JSONObject response) throws Exception {
        String access = response.getString("access_token");
        String refresh = response.optString("refresh_token", "");
        String provider = response.getString("provider");
        long expires = response.getLong("expires_at");
        if (!GatewayTokenValidator.isValid(access) || (!refresh.isEmpty() && !GatewayTokenValidator.isValid(refresh))
            || !"Bearer".equalsIgnoreCase(response.optString("token_type"))
            || !GatewayTokenValidator.isValid(provider) || expires <= System.currentTimeMillis() / 1000) {
            throw new IllegalStateException();
        }
        // Persist only this explicit credential allowlist, encrypted using an origin-scoped AndroidKeyStore key.
        store(base).set(new JSONObject().put("access_token", access).put("refresh_token", refresh)
            .put("provider", provider).put("expires_at", expires).toString());
    }

    static JSObject statusResult(String base, boolean signedIn, boolean supported) {
        JSObject result = new JSObject();
        for (Map.Entry<String, Object> field : statusFields(base, signedIn, supported).entrySet()) {
            result.put(field.getKey(), field.getValue());
        }
        return result;
    }

    /** Pure field set so unit tests can assert the disclosed contract without org.json (not mocked on the JVM). */
    static Map<String, Object> statusFields(String base, boolean signedIn, boolean supported) {
        Map<String, Object> fields = new LinkedHashMap<>();
        fields.put("baseUrl", base);
        fields.put("supported", supported);
        fields.put("signedIn", signedIn);
        fields.put("authenticated", signedIn);
        fields.put("status", !supported ? "unsupported" : signedIn ? "signed-in" : "signed-out");
        // This is authentication state, NOT an authorization/approval grant. Gateway remains authoritative.
        return fields;
    }

    @Override public void close() {
        // Lifecycle teardown must never wait for a network request's monitor on the WebView UI thread.
        destroyed = true;
        OwnerLoopback attempt = pending;
        if (attempt != null) attempt.close();
    }
}
