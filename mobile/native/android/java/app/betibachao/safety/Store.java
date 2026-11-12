package app.betibachao.safety;

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

/**
 * Small settings store shared by the app, the background safety service and the
 * lock-screen / tile / widget / power-button SOS triggers. Secrets (the login
 * token) are encrypted with an AES key held in the Android Keystore.
 */
public final class Store {
    private static final String PREFS = "beti_bachao";
    private static final String KEY_ALIAS = "beti_bachao_secret";

    private Store() {}

    public static SharedPreferences prefs(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static String get(Context ctx, String key) { return prefs(ctx).getString(key, null); }
    public static boolean getBool(Context ctx, String key, boolean def) { return prefs(ctx).getBoolean(key, def); }
    public static void put(Context ctx, String key, String value) { prefs(ctx).edit().putString(key, value).apply(); }
    /** Written to disk before returning (used by the crash recorder, the process is about to die). */
    public static void putNow(Context ctx, String key, String value) { prefs(ctx).edit().putString(key, value).commit(); }
    public static void putBool(Context ctx, String key, boolean value) { prefs(ctx).edit().putBoolean(key, value).apply(); }

    public static void putSecret(Context ctx, String key, String value) {
        if (value == null || value.isEmpty()) { prefs(ctx).edit().remove("s_" + key).apply(); return; }
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, key());
            byte[] enc = c.doFinal(value.getBytes(StandardCharsets.UTF_8));
            String packed = Base64.encodeToString(c.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(enc, Base64.NO_WRAP);
            prefs(ctx).edit().putString("s_" + key, packed).apply();
        } catch (Exception e) {
            // Keystore unavailable on this device: refuse to store the secret in plain text.
            prefs(ctx).edit().remove("s_" + key).apply();
        }
    }

    public static String getSecret(Context ctx, String key) {
        String packed = prefs(ctx).getString("s_" + key, null);
        if (packed == null) return null;
        try {
            String[] parts = packed.split(":");
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
            return new String(c.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }

    private static SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) return ((KeyStore.SecretKeyEntry) ks.getEntry(KEY_ALIAS, null)).getSecretKey();
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        kg.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return kg.generateKey();
    }

    public static String token(Context ctx) { return getSecret(ctx, "token"); }
    public static String server(Context ctx) { String s = get(ctx, "serverUrl"); return s == null ? "" : s; }
}
