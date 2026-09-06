package com.hermes.companion;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

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

    @Test
    public void ownerTicketIsRevealedOnlyInsideQueuedTrustedResolveCallback() throws Exception {
        String source = new String(Files.readAllBytes(Path.of(
            "src/main/java/com/hermes/companion/GatewayTokenPlugin.java")), StandardCharsets.UTF_8);
        String capture = "OwnerSession.Disclosure disclosure = owner.webSocketUrl(base);";
        String queued = "withTrustedCall(call, new String[] {\"baseUrl\"}, () -> {";
        String resolve = "call.resolve(disclosure.reveal());";
        int captureAt = source.indexOf(capture);
        int queueAt = source.indexOf(queued, captureAt);
        int resolveAt = source.indexOf(resolve, queueAt);
        int callbackEnd = source.indexOf("});", resolveAt);

        assertTrue(captureAt >= 0);
        assertTrue(queueAt > captureAt);
        assertFalse(source.substring(captureAt + capture.length(), queueAt).contains("reveal("));
        assertTrue(resolveAt > queueAt);
        assertTrue(callbackEnd > resolveAt);
    }
}
