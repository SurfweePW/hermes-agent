package com.hermes.companion;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

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
        if (!isTrustedCall(call) || !hasExactKeys(call, new String[] {})) {
            call.reject(GENERIC_ERROR);
            return;
        }

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
    }

    @PluginMethod
    public void set(PluginCall call) {
        if (!isTrustedCall(call) || !hasExactKeys(call, new String[] {"value"})) {
            call.reject(GENERIC_ERROR);
            return;
        }

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
    }

    @PluginMethod
    public void reset(PluginCall call) {
        if (!isTrustedCall(call) || !hasExactKeys(call, new String[] {})) {
            call.reject(GENERIC_ERROR);
            return;
        }

        try {
            store.reset();
            call.resolve();
        } catch (Exception ignored) {
            call.reject(GENERIC_ERROR);
        }
    }

    private boolean isTrustedCall(PluginCall call) {
        if (call == null || getBridge() == null || getBridge().getWebView() == null) {
            return false;
        }
        return isTrustedBundledOrigin(getBridge().getWebView().getUrl());
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
