package app.betibachao.safety;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;

import androidx.core.content.ContextCompat;

import org.json.JSONArray;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Voice SOS: keeps the phone's on-device speech recognizer listening while background
 * protection is on, and starts the SOS countdown when she says one of her SOS words
 * ("bachao", "help", "kapadandi"…). Runs inside the foreground SafetyService.
 */
public final class VoiceGuard implements RecognitionListener {
    private static VoiceGuard instance;
    private static long pausedUntil = 0;
    private final Context app;
    private final Handler main = new Handler(Looper.getMainLooper());
    private SpeechRecognizer rec;
    private boolean running = false;
    private int errors = 0;

    private VoiceGuard(Context ctx) { app = ctx.getApplicationContext(); }

    public static void start(Context ctx) {
        if (!SpeechRecognizer.isRecognitionAvailable(ctx)) return;
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return;
        if (instance == null) instance = new VoiceGuard(ctx);
        instance.main.post(instance::begin);
    }

    public static void stop() { if (instance != null) instance.main.post(instance::end); }

    /** Frees the microphone for a while (evidence recording, voice commands in the app). */
    public static void pause(Context ctx) { pausedUntil = System.currentTimeMillis() + 20000; if (instance != null) instance.main.post(instance::release); }

    private void begin() { running = true; listen(); }
    private void end() { running = false; release(); }
    private void release() { if (rec != null) { try { rec.cancel(); rec.destroy(); } catch (Exception ignored) {} rec = null; } }

    private void listen() {
        if (!running) return;
        long wait = pausedUntil - System.currentTimeMillis();
        if (wait > 0) { main.postDelayed(this::listen, wait); return; }
        release();
        rec = Build.VERSION.SDK_INT >= 33 && SpeechRecognizer.isOnDeviceRecognitionAvailable(app) ? SpeechRecognizer.createOnDeviceSpeechRecognizer(app) : SpeechRecognizer.createSpeechRecognizer(app);
        rec.setRecognitionListener(this);
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, langTag(Store.get(app, "lang")));
        i.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
        i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3);
        try { rec.startListening(i); } catch (Exception e) { retry(); }
    }

    static String langTag(String l) {
        if (l == null) return "en-IN";
        switch (l) { case "hi": return "hi-IN"; case "te": return "te-IN"; case "ta": return "ta-IN"; case "kn": return "kn-IN"; case "ml": return "ml-IN"; case "bn": return "bn-IN"; case "mr": return "mr-IN"; case "gu": return "gu-IN"; case "ur": return "ur-IN"; default: return "en-IN"; }
    }

    private boolean matches(Bundle b) {
        ArrayList<String> heard = b == null ? null : b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (heard == null) return false;
        List<String> words = new ArrayList<>();
        try { JSONArray a = new JSONArray(Store.get(app, "keywords") == null ? "[\"bachao\",\"help\",\"kapadandi\"]" : Store.get(app, "keywords")); for (int k = 0; k < a.length(); k++) words.add(a.getString(k).toLowerCase(Locale.ROOT)); } catch (Exception ignored) {}
        for (String h : heard) { String s = " " + h.toLowerCase(Locale.ROOT) + " "; for (String w : words) if (s.contains(" " + w + " ") || s.contains(w)) return true; }
        return false;
    }

    private void retry() { errors++; main.postDelayed(this::listen, Math.min(30000, 600L * errors)); }

    @Override public void onPartialResults(Bundle b) { if (matches(b)) { errors = 0; release(); NativeSos.trigger(app, "voice"); main.postDelayed(this::listen, 15000); } }
    @Override public void onResults(Bundle b) { if (matches(b)) { release(); NativeSos.trigger(app, "voice"); main.postDelayed(this::listen, 15000); } else { errors = 0; main.postDelayed(this::listen, 250); } }
    @Override public void onError(int error) { if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) { errors = 0; main.postDelayed(this::listen, 250); } else retry(); }
    @Override public void onReadyForSpeech(Bundle params) {}
    @Override public void onBeginningOfSpeech() {}
    @Override public void onRmsChanged(float rmsdB) {}
    @Override public void onBufferReceived(byte[] buffer) {}
    @Override public void onEndOfSpeech() {}
    @Override public void onEvent(int eventType, Bundle params) {}
}
