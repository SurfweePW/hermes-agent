package com.hermes.companion;

import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.core.view.WindowCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onResume() {
        super.onResume();
        OwnerAppVisibility.onResume();
    }

    @Override
    public void onPause() {
        OwnerAppVisibility.onPause();
        super.onPause();
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(GatewayTokenPlugin.class);
        super.onCreate(savedInstanceState);

        if (getBridge() == null || getBridge().getWebView() == null) {
            return;
        }

        WindowCompat.enableEdgeToEdge(getWindow());
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        getBridge().getWebView().getSettings().setMixedContentMode(
            BuildConfig.DEBUG
                ? WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
                : WebSettings.MIXED_CONTENT_NEVER_ALLOW
        );
    }
}
