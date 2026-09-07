package com.hermes.companion;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class OwnerTaskLifecycleTest {
    @Test
    public void destructionWaitsForTheActiveBrowserAuthentication() {
        OwnerTaskLifecycle lifecycle = new OwnerTaskLifecycle();

        assertTrue(lifecycle.begin());
        assertFalse(lifecycle.destroy());
        assertTrue(lifecycle.isDestroyed());
        assertFalse(lifecycle.begin());
        assertTrue(lifecycle.finish());
    }

    @Test
    public void idleDestructionClosesImmediately() {
        OwnerTaskLifecycle lifecycle = new OwnerTaskLifecycle();

        assertTrue(lifecycle.destroy());
        assertFalse(lifecycle.begin());
    }

    @Test
    public void allConcurrentTasksMustFinishBeforeClosing() {
        OwnerTaskLifecycle lifecycle = new OwnerTaskLifecycle();

        assertTrue(lifecycle.begin());
        assertTrue(lifecycle.begin());
        assertFalse(lifecycle.destroy());
        assertFalse(lifecycle.finish());
        assertTrue(lifecycle.finish());
    }
}
