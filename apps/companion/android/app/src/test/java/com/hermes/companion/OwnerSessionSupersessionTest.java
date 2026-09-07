package com.hermes.companion;

import com.getcapacitor.JSObject;
import org.junit.Test;

import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.Map;
import java.util.Queue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.*;

public class OwnerSessionSupersessionTest {
    private static final String BASE = "https://gateway.test";

    @Test public void oldPauseAfterCurrentCheckBeforeLockCannotOverwriteNewSave() throws Exception {
        SharedPersistence persistence = new SharedPersistence();
        FakeBoundary oldBoundary = boundary(persistence, "old");
        oldBoundary.blockBeforePersist = true;
        FakeBoundary newBoundary = boundary(persistence, "new");
        OwnerSession oldSession = new OwnerSession(null, oldBoundary);
        OwnerSession newSession = new OwnerSession(null, newBoundary);
        ExecutorService workers = Executors.newFixedThreadPool(2);
        try {
            Future<JSObject> old = workers.submit(() -> signIn(oldSession));
            await(oldBoundary.beforePersist);
            Future<JSObject> replacement = workers.submit(() -> signIn(newSession));
            assertNull(replacement.get(2, TimeUnit.SECONDS));
            oldBoundary.releaseBeforePersist.countDown();
            assertStale(old);
            assertCredential(persistence, "new-credentials");
            assertFalse(persistence.events.contains("save:old-credentials"));
        } finally { release(oldBoundary); close(oldSession, newSession); workers.shutdownNow(); }
    }

    @Test public void newClaimBetweenOldSaveAndPostcheckForcesOwnedRollbackBeforeNewSave() throws Exception {
        SharedPersistence persistence = new SharedPersistence();
        FakeBoundary oldBoundary = boundary(persistence, "old");
        oldBoundary.blockAfterPersist = true;
        FakeBoundary newBoundary = boundary(persistence, "new");
        OwnerSession oldSession = new OwnerSession(null, oldBoundary);
        OwnerSession newSession = new OwnerSession(null, newBoundary);
        ExecutorService workers = Executors.newFixedThreadPool(2);
        try {
            Future<JSObject> old = workers.submit(() -> signIn(oldSession));
            await(oldBoundary.afterPersist);
            Future<JSObject> replacement = workers.submit(() -> signIn(newSession));
            await(newBoundary.claimedReplacement);
            assertFalse("new persistence waits for the old atomic save/rollback", replacement.isDone());
            oldBoundary.releaseAfterPersist.countDown();
            assertStale(old);
            assertNull(replacement.get(2, TimeUnit.SECONDS));
            assertCredential(persistence, "new-credentials");
            assertEquals(Arrays.asList("save:old-credentials", "rollback:old-credentials", "save:new-credentials"),
                persistence.events);
        } finally { release(oldBoundary); close(oldSession, newSession); workers.shutdownNow(); }
    }

    @Test public void failedNewerReplacementLeavesNoStaleOldCredentials() throws Exception {
        SharedPersistence persistence = new SharedPersistence();
        FakeBoundary oldBoundary = boundary(persistence, "old");
        oldBoundary.blockAfterPersist = true;
        FakeBoundary newBoundary = boundary(persistence, "new");
        newBoundary.failExchange = true;
        OwnerSession oldSession = new OwnerSession(null, oldBoundary);
        OwnerSession newSession = new OwnerSession(null, newBoundary);
        ExecutorService workers = Executors.newFixedThreadPool(2);
        try {
            Future<JSObject> old = workers.submit(() -> signIn(oldSession));
            await(oldBoundary.afterPersist);
            Future<JSObject> replacement = workers.submit(() -> signIn(newSession));
            await(newBoundary.claimedReplacement);
            oldBoundary.releaseAfterPersist.countDown();
            assertStale(old);
            assertStale(replacement);
            assertNull(persistence.entries.get(BASE));
        } finally { release(oldBoundary); close(oldSession, newSession); workers.shutdownNow(); }
    }

    @Test public void oldBlockedRefreshSuccessCannotOverwriteNewSave() throws Exception {
        SharedPersistence persistence = seeded("old-expired");
        FakeBoundary oldBoundary = boundary(persistence);
        oldBoundary.blockRefresh = true;
        FakeBoundary newBoundary = boundary(persistence, "new");
        OwnerSession oldSession = new OwnerSession(null, oldBoundary);
        OwnerSession newSession = new OwnerSession(null, newBoundary);
        ExecutorService workers = Executors.newFixedThreadPool(2);
        try {
            Future<JSObject> old = workers.submit(() -> oldSession.status(BASE));
            await(oldBoundary.networkStarted);
            assertNull(signIn(newSession));
            oldBoundary.releaseNetwork.countDown();
            assertStale(old);
            assertCredential(persistence, "new-credentials");
        } finally { release(oldBoundary); close(oldSession, newSession); workers.shutdownNow(); }
    }

    @Test public void oldRefreshAuthFailureCannotDeleteNewSave() throws Exception {
        assertRefreshFailureDoesNotDeleteReplacement(401);
    }

    @Test public void oldRefreshForbiddenCannotDeleteNewSave() throws Exception {
        assertRefreshFailureDoesNotDeleteReplacement(403);
    }

    @Test public void oldTicketUnauthorizedCannotDeleteNewSave() throws Exception {
        assertTicketFailureDoesNotDeleteReplacement(401);
    }

    @Test public void oldTicketForbiddenCannotDeleteNewSave() throws Exception {
        assertTicketFailureDoesNotDeleteReplacement(403);
    }

    @Test public void closeWhileSignInWaitsBeforePersistenceLockPreventsWrite() throws Exception {
        SharedPersistence persistence = new SharedPersistence();
        FakeBoundary boundary = boundary(persistence, "old");
        boundary.blockBeforePersist = true;
        OwnerSession session = new OwnerSession(null, boundary);
        ExecutorService worker = Executors.newSingleThreadExecutor();
        try {
            Future<JSObject> result = worker.submit(() -> signIn(session));
            await(boundary.beforePersist);
            session.close();
            boundary.releaseBeforePersist.countDown();
            assertStale(result);
            assertNull(persistence.entries.get(BASE));
        } finally { release(boundary); session.close(); worker.shutdownNow(); }
    }

    @Test public void closeAfterSignInWriteForcesRollbackInsideSameCriticalSection() throws Exception {
        SharedPersistence persistence = new SharedPersistence();
        FakeBoundary boundary = boundary(persistence, "old");
        boundary.blockAfterPersist = true;
        OwnerSession session = new OwnerSession(null, boundary);
        ExecutorService worker = Executors.newSingleThreadExecutor();
        try {
            Future<JSObject> result = worker.submit(() -> signIn(session));
            await(boundary.afterPersist);
            session.close();
            boundary.releaseAfterPersist.countDown();
            assertStale(result);
            assertNull(persistence.entries.get(BASE));
            assertEquals(Arrays.asList("save:old-credentials", "rollback:old-credentials"), persistence.events);
        } finally { release(boundary); session.close(); worker.shutdownNow(); }
    }

    @Test public void closeSupersedesBlockedRefreshSuccessWithoutChangingCredentials() throws Exception {
        assertCloseSupersedesRefresh(0);
    }

    @Test public void closeSupersedesBlockedRefreshAuthFailureWithoutDeletingCredentials() throws Exception {
        assertCloseSupersedesRefresh(401);
    }

    @Test public void closeSupersedesBlockedTicketFailureWithoutDeletingCredentials() throws Exception {
        assertCloseSupersedesTicket(401, OwnerHttp.Failure.class);
    }

    @Test public void closeSupersedesBlockedTicketSuccessWithoutDisclosingTicket() throws Exception {
        assertCloseSupersedesTicket(0, IllegalStateException.class);
    }

    @Test public void heldTicketDisclosureFailsAfterNewerSessionClaimWithoutExposingValue() throws Exception {
        SharedPersistence persistence = seeded("current-fresh");
        OwnerSession oldSession = new OwnerSession(null, boundary(persistence));
        OwnerSession newSession = new OwnerSession(null, boundary(persistence));
        try {
            OwnerSession.Disclosure disclosure = oldSession.webSocketUrl(BASE);
            assertNotNull(disclosure);
            assertNotNull(newSession.webSocketUrl(BASE));
            assertThrows(IllegalStateException.class, disclosure::reveal);
            assertThrows(IllegalStateException.class, disclosure::reveal);
        } finally { close(oldSession, newSession); }
    }

    @Test public void heldTicketDisclosureFailsAfterCloseWithoutExposingValue() throws Exception {
        SharedPersistence persistence = seeded("current-fresh");
        OwnerSession session = new OwnerSession(null, boundary(persistence));
        OwnerSession.Disclosure disclosure = session.webSocketUrl(BASE);
        assertNotNull(disclosure);
        session.close();
        assertThrows(IllegalStateException.class, disclosure::reveal);
    }

    @Test public void olderSessionCannotLaterSignOutNewerSessionCredentials() throws Exception {
        SharedPersistence persistence = new SharedPersistence();
        OwnerSession oldSession = new OwnerSession(null, boundary(persistence));
        OwnerSession newSession = new OwnerSession(null, boundary(persistence, "new"));
        try {
            assertNull(signIn(newSession));
            assertThrows(IllegalStateException.class, () -> oldSession.signOut(BASE));
            assertCredential(persistence, "new-credentials");
        } finally { close(oldSession, newSession); }
    }

    @Test public void newerRefreshRotatesOwnershipSoOlderRefreshCannotOverwriteIt() throws Exception {
        SharedPersistence persistence = seeded("old-expired");
        FakeBoundary oldBoundary = boundary(persistence);
        oldBoundary.blockRefresh = true;
        OwnerSession oldSession = new OwnerSession(null, oldBoundary);
        OwnerSession newSession = new OwnerSession(null, boundary(persistence));
        ExecutorService worker = Executors.newSingleThreadExecutor();
        try {
            Future<JSObject> old = worker.submit(() -> oldSession.status(BASE));
            await(oldBoundary.networkStarted);
            assertNull(newSession.webSocketUrl(BASE).reveal());
            assertCredential(persistence, "old-refreshed");
            oldBoundary.releaseNetwork.countDown();
            assertStale(old);
            assertCredential(persistence, "old-refreshed");
        } finally { release(oldBoundary); close(oldSession, newSession); worker.shutdownNow(); }
    }

    @Test public void newerSessionClaimClosesOldLoopbackBeforeWaitingOnPersistence() throws Exception {
        SharedPersistence persistence = new SharedPersistence();
        FakeAttempt oldAttempt = FakeAttempt.blocking("old-code");
        FakeBoundary oldBoundary = new FakeBoundary(persistence, oldAttempt);
        FakeBoundary newBoundary = boundary(persistence, "new");
        newBoundary.blockReplacementClear = true;
        OwnerSession oldSession = new OwnerSession(null, oldBoundary);
        OwnerSession newSession = new OwnerSession(null, newBoundary);
        ExecutorService workers = Executors.newFixedThreadPool(2);
        try {
            Future<JSObject> old = workers.submit(() -> signIn(oldSession));
            await(oldAttempt.awaiting);
            Future<JSObject> replacement = workers.submit(() -> signIn(newSession));
            await(newBoundary.claimedReplacement);
            assertTrue(oldAttempt.closed);
            assertStale(old);
            assertFalse(replacement.isDone());
            newBoundary.releaseReplacementClear.countDown();
            assertNull(replacement.get(2, TimeUnit.SECONDS));
            assertCredential(persistence, "new-credentials");
        } finally { release(oldBoundary); release(newBoundary); close(oldSession, newSession); workers.shutdownNow(); }
    }

    @Test public void recreatedSessionStatusWaitsForBrowserSignInWithoutClosingItsLoopback() throws Exception {
        SharedPersistence persistence = new SharedPersistence();
        FakeAttempt oldAttempt = FakeAttempt.blocking("old-code");
        OwnerSession oldSession = new OwnerSession(null, new FakeBoundary(persistence, oldAttempt));
        OwnerSession recreatedSession = new OwnerSession(null, boundary(persistence));
        ExecutorService workers = Executors.newFixedThreadPool(2);
        try {
            Future<JSObject> signIn = workers.submit(() -> signIn(oldSession));
            await(oldAttempt.awaiting);
            java.util.concurrent.atomic.AtomicReference<Thread> statusThread = new java.util.concurrent.atomic.AtomicReference<>();
            Future<JSObject> status = workers.submit(() -> {
                statusThread.set(Thread.currentThread());
                return recreatedSession.status(BASE);
            });
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
            while (statusThread.get() == null || statusThread.get().getState() != Thread.State.TIMED_WAITING) {
                if (System.nanoTime() >= deadline) fail("recreated status did not wait for the active browser sign-in");
                Thread.yield();
            }
            assertFalse(status.isDone());
            assertFalse(oldAttempt.closed);
            oldAttempt.release.countDown();
            assertNull(signIn.get(2, TimeUnit.SECONDS));
            assertNull(status.get(2, TimeUnit.SECONDS));
            assertCredential(persistence, "old-credentials");
        } finally { oldAttempt.release.countDown(); close(oldSession, recreatedSession); workers.shutdownNow(); }
    }

    private void assertRefreshFailureDoesNotDeleteReplacement(int status) throws Exception {
        SharedPersistence persistence = seeded("old-expired");
        FakeBoundary oldBoundary = boundary(persistence);
        oldBoundary.blockRefresh = true;
        oldBoundary.refreshFailure = status;
        FakeBoundary newBoundary = boundary(persistence, "new");
        OwnerSession oldSession = new OwnerSession(null, oldBoundary);
        OwnerSession newSession = new OwnerSession(null, newBoundary);
        ExecutorService workers = Executors.newFixedThreadPool(2);
        try {
            Future<JSObject> old = workers.submit(() -> oldSession.status(BASE));
            await(oldBoundary.networkStarted);
            assertNull(signIn(newSession));
            oldBoundary.releaseNetwork.countDown();
            assertStale(old);
            assertCredential(persistence, "new-credentials");
        } finally { release(oldBoundary); close(oldSession, newSession); workers.shutdownNow(); }
    }

    private void assertTicketFailureDoesNotDeleteReplacement(int status) throws Exception {
        SharedPersistence persistence = seeded("old-fresh");
        FakeBoundary oldBoundary = boundary(persistence);
        oldBoundary.blockTicket = true;
        oldBoundary.ticketFailure = status;
        FakeBoundary newBoundary = boundary(persistence, "new");
        OwnerSession oldSession = new OwnerSession(null, oldBoundary);
        OwnerSession newSession = new OwnerSession(null, newBoundary);
        ExecutorService workers = Executors.newFixedThreadPool(2);
        try {
            Future<OwnerSession.Disclosure> old = workers.submit(() -> oldSession.webSocketUrl(BASE));
            await(oldBoundary.networkStarted);
            assertNull(signIn(newSession));
            oldBoundary.releaseNetwork.countDown();
            assertFailure(old, OwnerHttp.Failure.class);
            assertCredential(persistence, "new-credentials");
        } finally { release(oldBoundary); close(oldSession, newSession); workers.shutdownNow(); }
    }

    private void assertCloseSupersedesRefresh(int failure) throws Exception {
        SharedPersistence persistence = seeded("current-expired");
        FakeBoundary boundary = boundary(persistence);
        boundary.blockRefresh = true;
        boundary.refreshFailure = failure;
        OwnerSession session = new OwnerSession(null, boundary);
        ExecutorService worker = Executors.newSingleThreadExecutor();
        try {
            Future<JSObject> result = worker.submit(() -> session.status(BASE));
            await(boundary.networkStarted);
            session.close();
            boundary.releaseNetwork.countDown();
            assertStale(result);
            assertCredential(persistence, "current-expired");
        } finally { release(boundary); session.close(); worker.shutdownNow(); }
    }

    private void assertCloseSupersedesTicket(
        int failure, Class<? extends Throwable> expectedFailure
    ) throws Exception {
        SharedPersistence persistence = seeded("current-fresh");
        FakeBoundary boundary = boundary(persistence);
        boundary.blockTicket = true;
        boundary.ticketFailure = failure;
        OwnerSession session = new OwnerSession(null, boundary);
        ExecutorService worker = Executors.newSingleThreadExecutor();
        try {
            Future<OwnerSession.Disclosure> result = worker.submit(() -> session.webSocketUrl(BASE));
            await(boundary.networkStarted);
            session.close();
            boundary.releaseNetwork.countDown();
            assertFailure(result, expectedFailure);
            assertCredential(persistence, "current-fresh");
        } finally { release(boundary); session.close(); worker.shutdownNow(); }
    }

    private static JSObject signIn(OwnerSession session) throws Exception {
        return session.signIn(BASE, ignored -> { });
    }

    private static FakeBoundary boundary(SharedPersistence persistence, String... attemptNames) {
        FakeAttempt[] attempts = new FakeAttempt[attemptNames.length];
        for (int i = 0; i < attemptNames.length; i++) attempts[i] = FakeAttempt.immediate(attemptNames[i] + "-code");
        return new FakeBoundary(persistence, attempts);
    }

    private static SharedPersistence seeded(String value) {
        SharedPersistence persistence = new SharedPersistence();
        persistence.entries.put(BASE, new Entry(new Credential(value, value.contains("fresh"), true), "seed-owner"));
        return persistence;
    }

    private static void assertCredential(SharedPersistence persistence, String expected) {
        Entry entry = persistence.entries.get(BASE);
        assertNotNull(entry);
        assertEquals(expected, entry.credentials.name);
    }

    private static void await(CountDownLatch latch) throws Exception {
        assertTrue(latch.await(2, TimeUnit.SECONDS));
    }

    private static void assertStale(Future<?> future) throws Exception {
        assertFailure(future, IllegalStateException.class);
    }

    private static void assertFailure(Future<?> future, Class<? extends Throwable> type) throws Exception {
        ExecutionException failure = assertThrows(ExecutionException.class, () -> future.get(2, TimeUnit.SECONDS));
        assertTrue("expected " + type + " but was " + failure.getCause(), type.isInstance(failure.getCause()));
    }

    private static void release(FakeBoundary boundary) {
        boundary.releaseBeforePersist.countDown();
        boundary.releaseAfterPersist.countDown();
        boundary.releaseNetwork.countDown();
        boundary.releaseReplacementClear.countDown();
    }

    private static void close(OwnerSession... sessions) {
        for (OwnerSession session : sessions) session.close();
    }

    private static final class Credential {
        final String name;
        final boolean fresh;
        final boolean refreshable;
        Credential(String name, boolean fresh, boolean refreshable) {
            this.name = name;
            this.fresh = fresh;
            this.refreshable = refreshable;
        }
    }

    private static final class Entry {
        final Credential credentials;
        final String owner;
        Entry(Credential credentials, String owner) { this.credentials = credentials; this.owner = owner; }
    }

    private static final class SharedPersistence {
        final Object lock = new Object();
        final Map<String, Entry> entries = new ConcurrentHashMap<>();
        final java.util.List<String> events = new java.util.concurrent.CopyOnWriteArrayList<>();
    }

    private static final class FakeAttempt implements OwnerSession.Attempt {
        final CountDownLatch awaiting = new CountDownLatch(1);
        final CountDownLatch release;
        final String code;
        volatile boolean closed;
        boolean verifierTaken;

        FakeAttempt(String code, boolean blocked) {
            this.code = code;
            this.release = new CountDownLatch(blocked ? 1 : 0);
        }
        static FakeAttempt immediate(String code) { return new FakeAttempt(code, false); }
        static FakeAttempt blocking(String code) { return new FakeAttempt(code, true); }
        @Override public String challenge() { return "challenge"; }
        @Override public String state() { return "state"; }
        @Override public String redirectUri() { return "http://127.0.0.1:12345/callback"; }
        @Override public String awaitCode() throws Exception {
            awaiting.countDown();
            assertTrue(release.await(2, TimeUnit.SECONDS));
            if (closed) throw new IllegalStateException();
            return code;
        }
        @Override public synchronized String takeVerifier() {
            if (closed || verifierTaken) throw new IllegalStateException();
            verifierTaken = true;
            return code + "-verifier";
        }
        @Override public void close() { closed = true; release.countDown(); }
    }

    private static final class FakeBoundary implements OwnerSession.Boundary {
        final SharedPersistence persistence;
        final Queue<FakeAttempt> attempts;
        final CountDownLatch beforePersist = new CountDownLatch(1);
        final CountDownLatch releaseBeforePersist = new CountDownLatch(1);
        final CountDownLatch afterPersist = new CountDownLatch(1);
        final CountDownLatch releaseAfterPersist = new CountDownLatch(1);
        final CountDownLatch networkStarted = new CountDownLatch(1);
        final CountDownLatch releaseNetwork = new CountDownLatch(1);
        final CountDownLatch claimedReplacement = new CountDownLatch(1);
        final CountDownLatch releaseReplacementClear = new CountDownLatch(1);
        volatile boolean blockBeforePersist;
        volatile boolean blockAfterPersist;
        volatile boolean blockRefresh;
        volatile boolean blockTicket;
        volatile boolean blockReplacementClear;
        volatile boolean failExchange;
        volatile int refreshFailure;
        volatile int ticketFailure;

        FakeBoundary(SharedPersistence persistence, FakeAttempt... attempts) {
            this.persistence = persistence;
            this.attempts = new ArrayDeque<>(Arrays.asList(attempts));
        }

        @Override public synchronized OwnerSession.Attempt newAttempt() {
            FakeAttempt attempt = attempts.poll();
            if (attempt == null) throw new IllegalStateException();
            return attempt;
        }
        @Override public void requireSupport(String base) { }
        @Override public Object exchangeCode(String base, String code, String verifier) throws Exception {
            assertEquals(code + "-verifier", verifier);
            if (failExchange) throw new IllegalStateException();
            return new Credential(code.replace("-code", "-credentials"), true, true);
        }
        @Override public boolean clearForReplacement(String base, OwnerSession.Current current) throws Exception {
            claimedReplacement.countDown();
            if (blockReplacementClear) await(releaseReplacementClear);
            synchronized (persistence.lock) {
                if (!current.isCurrent()) return false;
                persistence.entries.remove(base);
                return current.isCurrent();
            }
        }
        @Override public boolean persistSignIn(
            String base, Object value, String owner, OwnerSession.Current current
        ) throws Exception {
            if (!current.isCurrent()) return false;
            if (blockBeforePersist) {
                beforePersist.countDown();
                await(releaseBeforePersist);
            }
            synchronized (persistence.lock) {
                if (!current.isCurrent()) return false;
                Credential credentials = (Credential) value;
                persistence.entries.put(base, new Entry(credentials, owner));
                persistence.events.add("save:" + credentials.name);
                if (blockAfterPersist) {
                    afterPersist.countDown();
                    await(releaseAfterPersist);
                }
                if (current.isCurrent()) return true;
                Entry saved = persistence.entries.get(base);
                if (saved != null && owner.equals(saved.owner)) {
                    persistence.entries.remove(base);
                    persistence.events.add("rollback:" + credentials.name);
                }
                return false;
            }
        }
        @Override public OwnerSession.StoredCredentials load(String base) {
            synchronized (persistence.lock) {
                Entry entry = persistence.entries.get(base);
                return entry == null ? null : new OwnerSession.StoredCredentials(entry.credentials, entry.owner);
            }
        }
        @Override public boolean isFresh(Object credentials) { return ((Credential) credentials).fresh; }
        @Override public boolean canRefresh(Object credentials) { return ((Credential) credentials).refreshable; }
        @Override public Object refresh(String base, Object credentials) throws Exception {
            networkStarted.countDown();
            if (blockRefresh) await(releaseNetwork);
            if (refreshFailure != 0) throw new OwnerHttp.Failure(refreshFailure);
            return new Credential("old-refreshed", true, true);
        }
        @Override public boolean updateIfOwned(
            String base, Object value, String expectedOwner, String newOwner, OwnerSession.Current current
        ) {
            synchronized (persistence.lock) {
                Entry entry = persistence.entries.get(base);
                if (!current.isCurrent() || entry == null || !expectedOwner.equals(entry.owner)) return false;
                persistence.entries.put(base, new Entry((Credential) value, newOwner));
                if (current.isCurrent()) return true;
                persistence.entries.put(base, entry);
                return false;
            }
        }
        @Override public boolean removeIfOwned(String base, String owner, OwnerSession.Current current) {
            synchronized (persistence.lock) {
                Entry entry = persistence.entries.get(base);
                if (!current.isCurrent() || entry == null || !owner.equals(entry.owner)) return false;
                persistence.entries.remove(base);
                return current.isCurrent();
            }
        }
        @Override public boolean isOwned(String base, String owner, OwnerSession.Current current) {
            synchronized (persistence.lock) {
                Entry entry = persistence.entries.get(base);
                return current.isCurrent() && entry != null && owner.equals(entry.owner);
            }
        }
        @Override public Object requestTicket(String base, Object credentials) throws Exception {
            networkStarted.countDown();
            if (blockTicket) await(releaseNetwork);
            if (ticketFailure != 0) throw new OwnerHttp.Failure(ticketFailure);
            return "ticket";
        }
        @Override public JSObject ticketResult(String base, Object response) { return null; }
        @Override public JSObject signedInResult(String base) { return null; }
        @Override public JSObject statusResult(String base, boolean signedIn, boolean supported) { return null; }
    }
}
