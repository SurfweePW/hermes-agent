package com.hermes.companion;

import org.junit.Test;
import static org.junit.Assert.*;
import java.util.*;

public class OwnerSessionContractTest {

    @Test
    public void disclosedResultContainsOnlyStatusFields() {
        String scope = String.join("", Collections.nCopies(64, "a"));
        Map<String, Object> signedIn = OwnerSession.statusFields("https://gateway.ts.net", true, true, scope);
        assertEquals(new HashSet<>(Arrays.asList("baseUrl", "supported", "signedIn", "authenticated", "status", "ownerScope")),
            signedIn.keySet());
        assertEquals(scope, signedIn.get("ownerScope"));

        for (Map<String, Object> result : Arrays.asList(
            OwnerSession.statusFields("https://gateway.ts.net", false, true),
            OwnerSession.statusFields("https://gateway.ts.net", false, false))) {
            assertEquals(new HashSet<>(Arrays.asList("baseUrl", "supported", "signedIn", "authenticated", "status")),
                result.keySet());
            assertFalse(result.values().toString().toLowerCase(Locale.ROOT).contains("token"));
            assertFalse(result.values().toString().toLowerCase(Locale.ROOT).contains("code"));
        }
    }

    @Test
    public void unsupportedGatewayIsDistinctFromSignedOut() {
        assertEquals("unsupported", OwnerSession.statusFields("https://gateway.ts.net", false, false).get("status"));
        assertEquals("signed-out", OwnerSession.statusFields("https://gateway.ts.net", false, true).get("status"));
        assertEquals("signed-in", OwnerSession.statusFields("https://gateway.ts.net", true, true,
            String.join("", Collections.nCopies(64, "a"))).get("status"));
    }

    @Test
    public void unsupportedIsSilentOnFailureNotAnUnauthorizedError() {
        // Unsupported extends Exception but carries no cause or message: the bridge translates it to
        // the explicit OWNER_UNSUPPORTED code, distinct from OWNER_AUTH_FAILED, and never an HTTP error body.
        assertNull(new OwnerSession.Unsupported().getMessage());
        assertNull(new OwnerSession.Unsupported().getCause());
    }
}
