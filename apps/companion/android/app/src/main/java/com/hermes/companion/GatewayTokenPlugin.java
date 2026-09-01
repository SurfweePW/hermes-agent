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

    @Override
    public void load() {
        store = new KeystoreTokenStore(getContext().getApplicationContext());
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
