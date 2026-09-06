package com.hermes.companion;

import android.content.Context;
import com.getcapacitor.JSObject;
import org.json.JSONArray;
import org.json.JSONObject;
import java.net.URI;
import java.net.URLEncoder;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/** Owns credentials; the bridge receives only status or a single-use WS ticket. */
final class OwnerSession implements AutoCloseable {
    interface Browser { void open(String url) throws Exception; }
    interface Current { boolean isCurrent(); }
    interface Attempt extends AutoCloseable {
        String challenge() throws Exception;
        String state();
        String redirectUri();
        String awaitCode() throws Exception;
        String takeVerifier();
        @Override void close();
    }
    static final class StoredCredentials {
        final Object value;
        final String owner;
        StoredCredentials(Object value, String owner) { this.value = value; this.owner = owner; }
    }
    /** A ticket result that stays opaque until the trusted WebView resolve boundary. */
    final class Disclosure {
        private final String base;
        private final String credentialOwner;
        private final ReadLease lease;
        private JSObject result;
        private boolean attempted;

        private Disclosure(String base, String credentialOwner, ReadLease lease, JSObject result) {
            this.base = base;
            this.credentialOwner = credentialOwner;
            this.lease = lease;
            this.result = result;
        }

        synchronized JSObject reveal() throws Exception {
            if (attempted) throw new IllegalStateException();
            attempted = true;
            require(boundary.isOwned(base, credentialOwner, lease));
            lease.requireCurrent();
            JSObject revealed = result;
            result = null;
            return revealed;
        }
    }
    interface Boundary {
        Attempt newAttempt() throws Exception;
        void requireSupport(String base) throws Exception;
        Object exchangeCode(String base, String code, String verifier) throws Exception;
        boolean clearForReplacement(String base, Current current) throws Exception;
        boolean persistSignIn(String base, Object credentials, String owner, Current current) throws Exception;
        StoredCredentials load(String base) throws Exception;
        boolean isFresh(Object credentials) throws Exception;
        boolean canRefresh(Object credentials) throws Exception;
        Object refresh(String base, Object credentials) throws Exception;
        boolean updateIfOwned(
            String base, Object credentials, String expectedOwner, String newOwner, Current current
        ) throws Exception;
        boolean removeIfOwned(String base, String owner, Current current) throws Exception;
        boolean isOwned(String base, String owner, Current current) throws Exception;
        Object requestTicket(String base, Object credentials) throws Exception;
        JSObject ticketResult(String base, Object response) throws Exception;
        JSObject signedInResult(String base) throws Exception;
    }
    static final class Unsupported extends Exception { }

    private static final Object REGISTRY_LOCK = new Object();
    private static final Map<String, BaseOperation> OPERATIONS = new HashMap<>();
    private static long nextOperation;
    private static long nextSession;

    private static final class BaseOperation {
        final long id;
        final long sessionId;
        final Attempt attempt;
        BaseOperation(long id, long sessionId, Attempt attempt) {
            this.id = id;
            this.sessionId = sessionId;
            this.attempt = attempt;
        }
    }

    private final Context context;
    private final Boundary boundary;
    private final long sessionId = reserveSessionId();
    private Attempt pending;
    private String pendingBase;
    private long generation;
    private boolean destroyed;

    OwnerSession(Context context) {
        this.context = context;
        this.boundary = new Boundary() {
            @Override public Attempt newAttempt() throws Exception { return new OwnerLoopback(180000); }
            @Override public void requireSupport(String base) throws Exception { OwnerSession.this.requireSupport(base); }
            @Override public Object exchangeCode(String base, String code, String verifier) throws Exception {
                return OwnerHttp.request(base, "/auth/native/token",
                    new JSONObject().put("code", code).put("code_verifier", verifier), null);
            }
            @Override public boolean clearForReplacement(String base, Current current) throws Exception {
                return store(base).resetIfCurrent(current::isCurrent);
            }
            @Override public boolean persistSignIn(
                String base, Object credentials, String owner, Current current
            ) throws Exception {
                return store(base).setOwnedIfCurrent(serialized((JSONObject) credentials), owner, current::isCurrent);
            }
            @Override public StoredCredentials load(String base) throws Exception {
                KeystoreTokenStore.OwnedValue saved = store(base).getOwned();
                return saved == null ? null : new StoredCredentials(new JSONObject(saved.value), saved.owner);
            }
            @Override public boolean isFresh(Object credentials) throws Exception {
                return ((JSONObject) credentials).getLong("expires_at") > System.currentTimeMillis() / 1000 + 60;
            }
            @Override public boolean canRefresh(Object credentials) {
                return !((JSONObject) credentials).optString("refresh_token", "").isEmpty();
            }
            @Override public Object refresh(String base, Object credentials) throws Exception {
                JSONObject data = (JSONObject) credentials;
                return OwnerHttp.request(base, "/auth/native/refresh", new JSONObject()
                    .put("refresh_token", data.getString("refresh_token"))
                    .put("provider", data.getString("provider")), null);
            }
            @Override public boolean updateIfOwned(
                String base, Object credentials, String expectedOwner, String newOwner, Current current
            ) throws Exception {
                return store(base).setIfOwned(
                    serialized((JSONObject) credentials), expectedOwner, newOwner, current::isCurrent
                );
            }
            @Override public boolean removeIfOwned(String base, String owner, Current current) throws Exception {
                return store(base).resetIfOwned(owner, current::isCurrent);
            }
            @Override public boolean isOwned(String base, String owner, Current current) throws Exception {
                return store(base).isOwned(owner, current::isCurrent);
            }
            @Override public Object requestTicket(String base, Object credentials) throws Exception {
                return OwnerHttp.request(base, "/api/auth/ws-ticket", new JSONObject(),
                    ((JSONObject) credentials).getString("access_token"));
            }
            @Override public JSObject ticketResult(String base, Object response) throws Exception {
                String ticket = ((JSONObject) response).getString("ticket");
                if (!ticket.matches("[A-Za-z0-9_-]{20,512}")) throw new IllegalStateException();
                URI baseUri = URI.create(base);
                String path = baseUri.getRawPath().replaceAll("/+$", "") + "/api/ws";
                URI socket = new URI("https".equals(baseUri.getScheme()) ? "wss" : "ws", null,
                    baseUri.getHost(), baseUri.getPort(), path, "ticket=" + ticket, null);
                JSObject result = new JSObject();
                result.put("value", socket.toASCIIString());
                return result;
            }
            @Override public JSObject signedInResult(String base) { return statusResult(base, true, true); }
        };
    }

    OwnerSession(Context context, Boundary boundary) {
        this.context = context;
        this.boundary = boundary;
    }

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
        final Attempt attempt = boundary.newAttempt();
        final Lease lease;
        try {
            lease = claim(base, attempt);
        } catch (Exception failure) {
            attempt.close();
            throw failure;
        }
        closeSuperseded(lease.superseded);
        try (Attempt ignored = attempt) {
            // Claiming happens first. Persistence may be blocked, but older sessions are already stale.
            require(boundary.clearForReplacement(base, lease));
            boundary.requireSupport(base);
            String url = base + "/auth/native/authorize?code_challenge_method=S256&code_challenge="
                + attempt.challenge() + "&state=" + attempt.state() + "&redirect_uri="
                + URLEncoder.encode(attempt.redirectUri(), "UTF-8");
            lease.requireCurrent();
            browser.open(url); // ACTION_VIEW only; no embedded login, passwords, cookie scraping, or fallback.
            String code = attempt.awaitCode();
            String verifier = attempt.takeVerifier();
            Object credentials = boundary.exchangeCode(base, code, verifier);
            lease.requireCurrent(); // Deliberately repeated inside the store's persistence critical section.
            String credentialOwner = UUID.randomUUID().toString();
            require(boundary.persistSignIn(base, credentials, credentialOwner, lease));
            lease.requireCurrent();
            JSObject result = boundary.signedInResult(base);
            lease.requireCurrent();
            return result;
        } finally {
            finishAttempt(attempt);
        }
    }

    JSObject status(String base) throws Exception {
        ReadLease lease = readLease(base);
        try { boundary.requireSupport(base); }
        catch (Unsupported ignored) {
            lease.requireCurrent();
            return statusResult(base, false, false);
        }
        StoredCredentials credentials = credentials(base, lease);
        lease.requireCurrent();
        return statusResult(base, credentials != null, true);
    }

    JSObject signOut(String base) throws Exception {
        Lease lease = claim(base, null);
        closeSuperseded(lease.superseded);
        require(boundary.clearForReplacement(base, lease));
        lease.requireCurrent();
        // Local sign-out only: do not log out the user's system browser or revoke unrelated sessions.
        return statusResult(base, false, true);
    }

    Disclosure webSocketUrl(String base) throws Exception {
        ReadLease lease = readLease(base);
        boundary.requireSupport(base);
        StoredCredentials credentials = credentials(base, lease);
        if (credentials == null) throw new IllegalStateException();
        Object response;
        try {
            response = boundary.requestTicket(base, credentials.value);
        } catch (OwnerHttp.Failure failure) {
            if (failure.status == 401 || failure.status == 403) {
                boundary.removeIfOwned(base, credentials.owner, lease);
            }
            throw failure;
        }
        // The only credential intentionally exposed is a gateway-issued, single-use, 30s WS ticket.
        require(boundary.isOwned(base, credentials.owner, lease));
        JSObject result = boundary.ticketResult(base, response);
        lease.requireCurrent();
        return new Disclosure(base, credentials.owner, lease, result);
    }

    private StoredCredentials credentials(String base, ReadLease lease) throws Exception {
        StoredCredentials saved = boundary.load(base);
        lease.requireCurrent();
        if (saved == null) return null; // Shared gateway token storage is deliberately never consulted.
        if (boundary.isFresh(saved.value)) return saved;
        if (!boundary.canRefresh(saved.value)) {
            require(boundary.removeIfOwned(base, saved.owner, lease));
            return null;
        }
        try {
            Object fresh = boundary.refresh(base, saved.value);
            String refreshedOwner = UUID.randomUUID().toString();
            require(boundary.updateIfOwned(base, fresh, saved.owner, refreshedOwner, lease));
            return new StoredCredentials(fresh, refreshedOwner);
        } catch (OwnerHttp.Failure failure) {
            if (failure.status == 400 || failure.status == 401 || failure.status == 403) {
                require(boundary.removeIfOwned(base, saved.owner, lease));
                return null;
            }
            throw failure; // Transient network/provider failure is NOT expiry and must not erase credentials.
        }
    }

    private String serialized(JSONObject response) throws Exception {
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
        return new JSONObject().put("access_token", access).put("refresh_token", refresh)
            .put("provider", provider).put("expires_at", expires).toString();
    }

    private Lease claim(String base, Attempt attempt) {
        final Attempt localSuperseded;
        final long localGeneration;
        final BaseOperation previous;
        final BaseOperation operation;
        synchronized (this) {
            if (destroyed) throw new IllegalStateException();
            synchronized (REGISTRY_LOCK) {
                previous = OPERATIONS.get(base);
                if (previous != null && previous.sessionId > sessionId) throw new IllegalStateException();
                localSuperseded = pending;
                pending = attempt;
                pendingBase = attempt == null ? null : base;
                localGeneration = ++generation;
                operation = new BaseOperation(++nextOperation, sessionId, attempt);
                OPERATIONS.put(base, operation);
            }
        }
        Attempt globalSuperseded = previous == null ? null : previous.attempt;
        if (globalSuperseded == attempt) globalSuperseded = null;
        if (localSuperseded != null && localSuperseded != globalSuperseded) localSuperseded.close();
        return new Lease(base, operation.id, localGeneration, globalSuperseded);
    }

    private ReadLease readLease(String base) {
        final Attempt superseded;
        final ReadLease lease;
        synchronized (this) {
            if (destroyed) throw new IllegalStateException();
            synchronized (REGISTRY_LOCK) {
                BaseOperation operation = OPERATIONS.get(base);
                if (operation != null && operation.sessionId > sessionId) throw new IllegalStateException();
                if (operation == null || operation.sessionId < sessionId) {
                    superseded = operation == null ? null : operation.attempt;
                    operation = new BaseOperation(++nextOperation, sessionId, null);
                    OPERATIONS.put(base, operation);
                } else {
                    superseded = null;
                }
                lease = new ReadLease(base, operation.id, generation);
            }
        }
        closeSuperseded(superseded);
        return lease;
    }

    private void finishAttempt(Attempt attempt) {
        synchronized (this) {
            if (pending == attempt) {
                pending = null;
                pendingBase = null;
            }
        }
        synchronized (REGISTRY_LOCK) {
            for (Map.Entry<String, BaseOperation> entry : OPERATIONS.entrySet()) {
                BaseOperation operation = entry.getValue();
                if (operation.attempt == attempt) {
                    entry.setValue(new BaseOperation(operation.id, operation.sessionId, null));
                    break;
                }
            }
        }
    }

    private static void closeSuperseded(Attempt attempt) {
        if (attempt != null) attempt.close();
    }

    private static void require(boolean current) {
        if (!current) throw new IllegalStateException();
    }

    private class ReadLease implements Current {
        final String base;
        final long operationId;
        final long localGeneration;
        ReadLease(String base, long operationId, long localGeneration) {
            this.base = base;
            this.operationId = operationId;
            this.localGeneration = localGeneration;
        }
        @Override public boolean isCurrent() {
            synchronized (OwnerSession.this) {
                if (destroyed || generation != localGeneration) return false;
                synchronized (REGISTRY_LOCK) {
                    BaseOperation operation = OPERATIONS.get(base);
                    return operation != null && operation.id == operationId && operation.sessionId == sessionId;
                }
            }
        }
        void requireCurrent() { require(isCurrent()); }
    }

    private final class Lease extends ReadLease {
        final Attempt superseded;
        Lease(String base, long operationId, long localGeneration, Attempt superseded) {
            super(base, operationId, localGeneration);
            this.superseded = superseded;
        }
    }

    private static long reserveSessionId() {
        synchronized (REGISTRY_LOCK) { return ++nextSession; }
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
        // Lifecycle teardown invalidates promptly and never waits for persistence or network work.
        final Attempt attempt;
        synchronized (this) {
            if (destroyed) return;
            destroyed = true;
            generation++;
            attempt = pending;
            pending = null;
            pendingBase = null;
        }
        if (attempt != null) attempt.close();
    }
}
