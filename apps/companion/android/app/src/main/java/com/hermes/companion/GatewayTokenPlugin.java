package com.hermes.companion;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import android.webkit.WebView;

import org.json.JSONObject;

import java.net.URI;

@CapacitorPlugin(name = "GatewayToken")
public final class GatewayTokenPlugin extends Plugin {
    static final String GENERIC_ERROR = "Secure token storage unavailable.";
    private KeystoreTokenStore store;
    private OwnerSession owner;
    private final java.util.concurrent.ThreadPoolExecutor ownerWorker = new java.util.concurrent.ThreadPoolExecutor(
        2, 2, 0L, java.util.concurrent.TimeUnit.MILLISECONDS, new java.util.concurrent.ArrayBlockingQueue<>(16));

    @Override
    public void load() {
        store = new KeystoreTokenStore(getContext().getApplicationContext());
        owner = new OwnerSession(getContext().getApplicationContext());
    }

    @PluginMethod
    public void get(PluginCall call) {
        withTrustedCall(call, new String[] {}, () -> {
            try {
                String token = store.get();
                JSObject result = new JSObject();
                if (token != null) {
                    result.put("value", token);
                }
                call.resolve(result);
            } catch (Exception ignored) {
                call.reject(GENERIC_ERROR);
            }
        });
    }

    @PluginMethod
    public void set(PluginCall call) {
        withTrustedCall(call, new String[] {"value"}, () -> {
            String token = call.getString("value");
            if (!GatewayTokenValidator.isValid(token)) {
                call.reject(GENERIC_ERROR);
                return;
            }

            try {
                store.set(token);
                call.resolve();
            } catch (Exception ignored) {
                call.reject(GENERIC_ERROR);
            }
        });
    }

    @PluginMethod
    public void reset(PluginCall call) {
        withTrustedCall(call, new String[] {}, () -> {
            try {
                store.reset();
                call.resolve();
            } catch (Exception ignored) {
                call.reject(GENERIC_ERROR);
            }
        });
    }

    @PluginMethod
    public void ownerSignIn(PluginCall call) { ownerCall(call, "signIn"); }

    @PluginMethod
    public void ownerStatus(PluginCall call) { ownerCall(call, "status"); }

    @PluginMethod
    public void ownerSignOut(PluginCall call) { ownerCall(call, "signOut"); }

    @PluginMethod
    public void ownerWebSocketUrl(PluginCall call) { ownerCall(call, "webSocketUrl"); }

    private void ownerCall(PluginCall call, String operation) {
        withTrustedCall(call, new String[] {"baseUrl"}, () -> {
            final String base;
            try {
                if (!(call.getData().opt("baseUrl") instanceof String)) throw new IllegalArgumentException();
                base = OwnerAuthPolicy.baseUrl(call.getString("baseUrl"), BuildConfig.DEBUG);
            } catch (Exception ignored) {
                call.reject("Invalid owner gateway URL.", "INVALID_BASE_URL");
                return;
            }
            try {
                ownerWorker.execute(() -> {
                    try {
                        if ("webSocketUrl".equals(operation)) {
                            OwnerSession.Disclosure disclosure = owner.webSocketUrl(base);
                            // Keep the ticket opaque until the trusted UI-thread callback actually resolves it.
                            withTrustedCall(call, new String[] {"baseUrl"}, () -> {
                                try {
                                    call.resolve(disclosure.reveal());
                                } catch (Exception ignored) {
                                    call.reject("Owner sign-in unavailable, cancelled, or expired. Try signing in again.",
                                        "OWNER_AUTH_FAILED");
                                }
                            });
                            return;
                        }
                        JSObject result;
                        switch (operation) {
                            case "signIn": result = owner.signIn(base, this::openOwnerBrowser); break;
                            case "signOut": result = owner.signOut(base); break;
                            default: result = owner.status(base);
                        }
                        withTrustedCall(call, new String[] {"baseUrl"}, () -> call.resolve(result));
                    } catch (OwnerSession.Unsupported ignored) {
                        call.reject("This gateway has no supported native owner sign-in provider.", "OWNER_UNSUPPORTED");
                    } catch (Exception ignored) {
                        // Never forward URLs, response bodies, exception causes, codes, verifiers or bearer credentials.
                        call.reject("Owner sign-in unavailable, cancelled, or expired. Try signing in again.", "OWNER_AUTH_FAILED");
                    }
                });
            } catch (java.util.concurrent.RejectedExecutionException ignored) {
                call.reject("Owner sign-in is busy.", "OWNER_AUTH_BUSY");
            }
        });
    }

    private void openOwnerBrowser(String url) throws Exception {
        java.util.concurrent.CompletableFuture<Void> launched = new java.util.concurrent.CompletableFuture<>();
        WebView webView = getBridge().getWebView();
        webView.post(() -> {
            try {
                if (launched.isDone() || !isTrustedBundledOrigin(webView.getUrl())) throw new IllegalStateException();
                android.content.Intent intent = new android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url));
                intent.addCategory(android.content.Intent.CATEGORY_BROWSABLE);
                getActivity().startActivity(intent);
                launched.complete(null);
            } catch (Exception ignored) { launched.completeExceptionally(new IllegalStateException()); }
        });
        try { launched.get(10, java.util.concurrent.TimeUnit.SECONDS); }
        finally { launched.cancel(false); }
    }

    @Override
    protected void handleOnDestroy() {
        if (owner != null) owner.close();
        ownerWorker.shutdownNow();
        super.handleOnDestroy();
    }

    private void withTrustedCall(PluginCall call, String[] expectedKeys, Runnable action) {
        if (call == null || getBridge() == null || getBridge().getWebView() == null) {
            if (call != null) {
                call.reject(GENERIC_ERROR);
            }
            return;
        }

        WebView webView = getBridge().getWebView();
        webView.post(() -> {
            if (!isTrustedBundledOrigin(webView.getUrl()) || !hasExactKeys(call, expectedKeys)) {
                call.reject(GENERIC_ERROR);
                return;
            }
            action.run();
        });
    }

    static boolean isTrustedBundledOrigin(String candidate) {
        if (candidate == null) {
            return false;
        }
        try {
            URI uri = URI.create(candidate);
            int port = uri.getPort();
            return "https".equals(uri.getScheme())
                && "localhost".equals(uri.getHost())
                && (port == -1 || port == 443)
                && uri.getRawUserInfo() == null;
        } catch (IllegalArgumentException ignored) {
            return false;
        }
    }

    private static boolean hasExactKeys(PluginCall call, String[] expected) {
        JSONObject data = call.getData();
        if (data == null || data.length() != expected.length) {
            return false;
        }
        for (String key : expected) {
            if (!data.has(key)) {
                return false;
            }
        }
        return true;
    }
}
