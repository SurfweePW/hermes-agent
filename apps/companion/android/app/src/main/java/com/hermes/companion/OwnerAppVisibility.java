package com.hermes.companion;

import java.net.SocketTimeoutException;

/** Process-local foreground signal used to finish browser OAuth on OEM devices. */
final class OwnerAppVisibility {
    private static final Object LOCK = new Object();
    private static boolean resumed;

    static void onResume() {
        synchronized (LOCK) {
            resumed = true;
            LOCK.notifyAll();
        }
    }

    static void onPause() {
        synchronized (LOCK) { resumed = false; }
    }

    static void awaitResumed(long timeoutMillis) throws Exception {
        long deadline = System.nanoTime() + timeoutMillis * 1_000_000L;
        synchronized (LOCK) {
            while (!resumed) {
                long remainingNanos = deadline - System.nanoTime();
                if (remainingNanos <= 0) throw new SocketTimeoutException();
                long millis = Math.max(1L, remainingNanos / 1_000_000L);
                LOCK.wait(millis);
            }
        }
    }

    private OwnerAppVisibility() { }
}
