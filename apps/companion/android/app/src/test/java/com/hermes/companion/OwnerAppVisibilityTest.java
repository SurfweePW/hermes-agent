package com.hermes.companion;

import static org.junit.Assert.assertThrows;

import java.net.SocketTimeoutException;
import org.junit.After;
import org.junit.Test;

public class OwnerAppVisibilityTest {
    @After public void reset() { OwnerAppVisibility.onPause(); }

    @Test
    public void resumedAppAllowsExchangeToContinue() throws Exception {
        OwnerAppVisibility.onResume();
        OwnerAppVisibility.awaitResumed(10);
    }

    @Test
    public void pausedAppFailsClosedAfterTheBoundedWait() {
        OwnerAppVisibility.onPause();
        assertThrows(SocketTimeoutException.class, () -> OwnerAppVisibility.awaitResumed(10));
    }

    @Test
    public void laterResumeReleasesTheWaitingExchange() throws Exception {
        OwnerAppVisibility.onPause();
        Thread resume = new Thread(() -> {
            try { Thread.sleep(10); } catch (InterruptedException ignored) { }
            OwnerAppVisibility.onResume();
        });
        resume.start();
        OwnerAppVisibility.awaitResumed(1000);
        resume.join();
    }
}
