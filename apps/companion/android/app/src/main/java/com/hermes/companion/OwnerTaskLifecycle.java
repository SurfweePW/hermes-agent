package com.hermes.companion;

/** Keeps an in-flight browser authentication alive across Activity recreation. */
final class OwnerTaskLifecycle {
    private int activeTasks;
    private boolean destroyed;

    synchronized boolean begin() {
        if (destroyed) return false;
        activeTasks += 1;
        return true;
    }

    synchronized boolean finish() {
        if (activeTasks > 0) activeTasks -= 1;
        return destroyed && activeTasks == 0;
    }

    synchronized boolean destroy() {
        destroyed = true;
        return activeTasks == 0;
    }

    synchronized boolean isDestroyed() {
        return destroyed;
    }
}
