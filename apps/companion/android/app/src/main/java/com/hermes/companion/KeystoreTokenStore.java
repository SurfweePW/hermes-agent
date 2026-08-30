package com.hermes.companion;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Fail-closed token storage: ciphertext is app-private and its AES key never leaves AndroidKeyStore. */
final class KeystoreTokenStore {
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "hermes_companion_gateway_token_v1";
    private static final String PREFERENCES = "hermes_companion_secure_store";
    private static final String CIPHERTEXT = "gateway_token_ciphertext";
    private static final String IV = "gateway_token_iv";
    private static final int TAG_BITS = 128;

    private final SharedPreferences preferences;

    KeystoreTokenStore(Context context) {
        preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    synchronized String get() throws Exception {
        String encodedCiphertext = preferences.getString(CIPHERTEXT, null);
        String encodedIv = preferences.getString(IV, null);
        if (encodedCiphertext == null && encodedIv == null) {
            return null;
        }
        if (encodedCiphertext == null || encodedIv == null) {
            throw new IllegalStateException("Secure storage unavailable");
        }

        KeyStore keyStore = keyStore();
        SecretKey key = (SecretKey) keyStore.getKey(KEY_ALIAS, null);
        if (key == null) {
            throw new IllegalStateException("Secure storage unavailable");
        }

        byte[] iv = Base64.decode(encodedIv, Base64.NO_WRAP);
        byte[] encrypted = Base64.decode(encodedCiphertext, Base64.NO_WRAP);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, iv));
        String token = new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
        if (!GatewayTokenValidator.isValid(token)) {
            throw new IllegalStateException("Secure storage unavailable");
        }
        return token;
    }

    synchronized void set(String token) throws Exception {
        if (!GatewayTokenValidator.isValid(token)) {
            throw new IllegalArgumentException("Invalid token");
        }

        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
        byte[] encrypted = cipher.doFinal(token.getBytes(StandardCharsets.UTF_8));
        boolean committed = preferences.edit()
            .putString(CIPHERTEXT, Base64.encodeToString(encrypted, Base64.NO_WRAP))
            .putString(IV, Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
            .commit();
        if (!committed) {
            throw new IllegalStateException("Secure storage unavailable");
        }
    }

    synchronized void reset() throws Exception {
        boolean cleared = preferences.edit().remove(CIPHERTEXT).remove(IV).commit();
        if (!cleared) {
            throw new IllegalStateException("Secure storage unavailable");
        }

        KeyStore keyStore = keyStore();
        if (keyStore.containsAlias(KEY_ALIAS)) {
            keyStore.deleteEntry(KEY_ALIAS);
        }
    }

    private static KeyStore keyStore() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE);
        keyStore.load(null);
        return keyStore;
    }

    private static SecretKey getOrCreateKey() throws Exception {
        KeyStore keyStore = keyStore();
        SecretKey existing = (SecretKey) keyStore.getKey(KEY_ALIAS, null);
        if (existing != null) {
            return existing;
        }

        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(new KeyGenParameterSpec.Builder(
            KEY_ALIAS,
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
