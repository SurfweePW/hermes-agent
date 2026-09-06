package com.hermes.companion;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.UUID;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Fail-closed token storage: ciphertext is app-private and its AES key never leaves AndroidKeyStore. */
final class KeystoreTokenStore {
    interface Guard { boolean isCurrent(); }
    static final class OwnedValue {
        final String value;
        final String owner;
        OwnedValue(String value, String owner) { this.value = value; this.owner = owner; }
    }

    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "hermes_companion_gateway_token_v1";
    private static final String PREFERENCES = "hermes_companion_secure_store";
    private static final String CIPHERTEXT = "gateway_token_ciphertext";
    private static final String IV = "gateway_token_iv";
    private static final String OWNER = "gateway_token_owner";
    private static final int TAG_BITS = 128;
    /** One process-wide lock covers every instance and every owner credential namespace mutation. */
    private static final Object PERSISTENCE_LOCK = new Object();

    private final SharedPreferences preferences;
    private final String keyAlias;

    KeystoreTokenStore(Context context) {
        preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
        keyAlias = KEY_ALIAS;
    }

    KeystoreTokenStore(Context context, String ownerBaseUrl) throws Exception {
        String scope = OwnerAuthPolicy.challenge(ownerBaseUrl);
        preferences = context.getSharedPreferences("hermes_companion_owner_" + scope, Context.MODE_PRIVATE);
        keyAlias = "hermes_companion_owner_" + scope;
    }

    String get() throws Exception {
        synchronized (PERSISTENCE_LOCK) { return getLocked(); }
    }

    OwnedValue getOwned() throws Exception {
        synchronized (PERSISTENCE_LOCK) {
            String value = getLocked();
            if (value == null) {
                if (preferences.contains(OWNER) && !preferences.edit().remove(OWNER).commit()) {
                    throw unavailable();
                }
                return null;
            }
            String owner = preferences.getString(OWNER, null);
            if (owner == null || owner.isEmpty()) {
                // Adopt credentials written by older app versions so every subsequent mutation has CAS identity.
                owner = UUID.randomUUID().toString();
                if (!preferences.edit().putString(OWNER, owner).commit()) throw unavailable();
            }
            return new OwnedValue(value, owner);
        }
    }

    private String getLocked() throws Exception {
        String encodedCiphertext = preferences.getString(CIPHERTEXT, null);
        String encodedIv = preferences.getString(IV, null);
        if (encodedCiphertext == null && encodedIv == null) return null;
        if (encodedCiphertext == null || encodedIv == null) throw unavailable();

        KeyStore keyStore = keyStore();
        SecretKey key = (SecretKey) keyStore.getKey(keyAlias, null);
        if (key == null) throw unavailable();

        byte[] iv = Base64.decode(encodedIv, Base64.NO_WRAP);
        byte[] encrypted = Base64.decode(encodedCiphertext, Base64.NO_WRAP);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, iv));
        String token = new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
        if (!GatewayTokenValidator.isValid(token)) throw unavailable();
        return token;
    }

    void set(String token) throws Exception {
        synchronized (PERSISTENCE_LOCK) { setLocked(token, null); }
    }

    void setOwned(String token, String owner) throws Exception {
        requireOwner(owner);
        synchronized (PERSISTENCE_LOCK) { setLocked(token, owner); }
    }

    /** Sign-in precheck, save, postcheck and owned rollback are one persistence transaction. */
    boolean setOwnedIfCurrent(String token, String owner, Guard guard) throws Exception {
        requireOwner(owner);
        synchronized (PERSISTENCE_LOCK) {
            if (!guard.isCurrent()) return false;
            setLocked(token, owner);
            if (guard.isCurrent()) return true;
            if (owner.equals(preferences.getString(OWNER, null))) resetLocked(false);
            return false;
        }
    }

    /** Refresh is a compare-and-set on the exact marker read before its network request. */
    boolean setIfOwned(String token, String expectedOwner, String newOwner, Guard guard) throws Exception {
        requireOwner(expectedOwner);
        requireOwner(newOwner);
        synchronized (PERSISTENCE_LOCK) {
            if (!guard.isCurrent() || !expectedOwner.equals(preferences.getString(OWNER, null))) return false;
            RawState before = rawStateLocked();
            setLocked(token, newOwner);
            if (guard.isCurrent() && newOwner.equals(preferences.getString(OWNER, null))) return true;
            restoreLocked(before);
            return false;
        }
    }

    private void setLocked(String token, String owner) throws Exception {
        if (!GatewayTokenValidator.isValid(token)) throw new IllegalArgumentException("Invalid token");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
        byte[] encrypted = cipher.doFinal(token.getBytes(StandardCharsets.UTF_8));
        SharedPreferences.Editor editor = preferences.edit()
            .putString(CIPHERTEXT, Base64.encodeToString(encrypted, Base64.NO_WRAP))
            .putString(IV, Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP));
        if (owner == null) editor.remove(OWNER); else editor.putString(OWNER, owner);
        if (!editor.commit()) throw unavailable();
    }

    void reset() throws Exception {
        synchronized (PERSISTENCE_LOCK) { resetLocked(true); }
    }

    boolean resetIfCurrent(Guard guard) throws Exception {
        synchronized (PERSISTENCE_LOCK) {
            if (!guard.isCurrent()) return false;
            RawState before = rawStateLocked();
            resetLocked(false);
            if (guard.isCurrent()) return true;
            restoreLocked(before);
            return false;
        }
    }

    boolean resetIfOwned(String owner) throws Exception {
        return resetIfOwned(owner, () -> true);
    }

    boolean resetIfOwned(String owner, Guard guard) throws Exception {
        requireOwner(owner);
        synchronized (PERSISTENCE_LOCK) {
            if (!guard.isCurrent() || !owner.equals(preferences.getString(OWNER, null))) return false;
            RawState before = rawStateLocked();
            resetLocked(false);
            if (guard.isCurrent()) return true;
            restoreLocked(before);
            return false;
        }
    }

    boolean isOwned(String owner, Guard guard) {
        synchronized (PERSISTENCE_LOCK) {
            return guard.isCurrent() && owner != null && owner.equals(preferences.getString(OWNER, null))
                && preferences.contains(CIPHERTEXT) && preferences.contains(IV);
        }
    }

    private void resetLocked(boolean deleteKey) throws Exception {
        if (!preferences.edit().remove(CIPHERTEXT).remove(IV).remove(OWNER).commit()) throw unavailable();
        if (deleteKey) {
            KeyStore keyStore = keyStore();
            if (keyStore.containsAlias(keyAlias)) keyStore.deleteEntry(keyAlias);
        }
    }

    private RawState rawStateLocked() {
        return new RawState(
            preferences.getString(CIPHERTEXT, null),
            preferences.getString(IV, null),
            preferences.getString(OWNER, null)
        );
    }

    private void restoreLocked(RawState state) throws Exception {
        SharedPreferences.Editor editor = preferences.edit();
        putOrRemove(editor, CIPHERTEXT, state.ciphertext);
        putOrRemove(editor, IV, state.iv);
        putOrRemove(editor, OWNER, state.owner);
        if (!editor.commit()) throw unavailable();
    }

    private static void putOrRemove(SharedPreferences.Editor editor, String key, String value) {
        if (value == null) editor.remove(key); else editor.putString(key, value);
    }

    private static final class RawState {
        final String ciphertext;
        final String iv;
        final String owner;
        RawState(String ciphertext, String iv, String owner) {
            this.ciphertext = ciphertext;
            this.iv = iv;
            this.owner = owner;
        }
    }

    private static void requireOwner(String owner) {
        if (owner == null || owner.isEmpty()) throw new IllegalArgumentException("Invalid owner");
    }

    private static IllegalStateException unavailable() {
        return new IllegalStateException("Secure storage unavailable");
    }

    private static KeyStore keyStore() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE);
        keyStore.load(null);
        return keyStore;
    }

    private SecretKey getOrCreateKey() throws Exception {
        KeyStore keyStore = keyStore();
        SecretKey existing = (SecretKey) keyStore.getKey(keyAlias, null);
        if (existing != null) return existing;

        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(new KeyGenParameterSpec.Builder(
            keyAlias,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .setUserAuthenticationRequired(false)
            .build());
        return generator.generateKey();
    }
}
