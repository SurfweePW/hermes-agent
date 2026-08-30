package com.hermes.companion;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class GatewaySecurityTest {
    @Test
    public void tokenValidationIsBoundedAndRejectsControlCharacters() {
        assertTrue(GatewayTokenValidator.isValid("opaque-token-value"));
        assertFalse(GatewayTokenValidator.isValid(null));
        assertFalse(GatewayTokenValidator.isValid(""));
        assertFalse(GatewayTokenValidator.isValid("token\nvalue"));
        assertFalse(GatewayTokenValidator.isValid("x".repeat(GatewayTokenValidator.MAX_TOKEN_LENGTH + 1)));
    }

    @Test
    public void pluginTrustsOnlyTheBundledHttpsLocalhostOrigin() {
        assertTrue(GatewayTokenPlugin.isTrustedBundledOrigin("https://localhost/"));
        assertTrue(GatewayTokenPlugin.isTrustedBundledOrigin("https://localhost/assets/index.js"));
        assertFalse(GatewayTokenPlugin.isTrustedBundledOrigin("http://localhost/"));
        assertFalse(GatewayTokenPlugin.isTrustedBundledOrigin("https://localhost.evil.example/"));
        assertFalse(GatewayTokenPlugin.isTrustedBundledOrigin("https://evil.example/"));
        assertFalse(GatewayTokenPlugin.isTrustedBundledOrigin("https://user@localhost/"));
    }
}
