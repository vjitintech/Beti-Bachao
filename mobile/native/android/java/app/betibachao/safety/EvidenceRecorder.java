package app.betibachao.safety;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;

import androidx.core.content.ContextCompat;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;

/**
 * 15 s of audio once an SOS is active (the server has accepted it). Silent: no prompt, no beep.
 * Kept only if a voice was heard (loudness sampled 4× a second); then a copy is saved on the
 * phone (app storage, "evidence" folder) and it is uploaded to the SOS for operators and admin.
 * Every step is reported to the server audit log.
 */
public final class EvidenceRecorder {
    private static boolean busy = false;
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final int VOICE_AMPLITUDE = 2500; // getMaxAmplitude() is 0..32767; quiet room ≈ 100–800
    private EvidenceRecorder() {}

    public static synchronized void record(Context ctx, String incidentId, int seconds) {
        final Context app = ctx.getApplicationContext();
        if (busy || incidentId == null || !Store.getBool(app, "autoEvidence", true)) return;
        if (Store.getBool(app, "evidence:" + incidentId, false)) return; // once per SOS (native + in-app paths)
        if (ContextCompat.checkSelfPermission(app, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) { log(app, incidentId, "mic_denied", 0); return; }
        busy = true;
        Store.putBool(app, "evidence:" + incidentId, true);
        VoiceGuard.pause(app, (seconds + 5) * 1000L); // the microphone can only be used by one of them
        MAIN.postDelayed(() -> start(app, incidentId, seconds), 500); // let the recogniser let go of the mic
    }

    private static void start(Context app, String incidentId, int seconds) {
        final File f = new File(app.getCacheDir(), "sos-" + System.currentTimeMillis() + ".m4a");
        final MediaRecorder r = Build.VERSION.SDK_INT >= 31 ? new MediaRecorder(app) : new MediaRecorder();
        try {
            r.setAudioSource(MediaRecorder.AudioSource.MIC);
            r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            r.setAudioEncodingBitRate(32000);
            r.setAudioSamplingRate(22050);
            r.setOutputFile(f.getAbsolutePath());
            r.prepare();
            r.start();
        } catch (Exception e) {
            try { r.release(); } catch (Exception ignored) {}
            synchronized (EvidenceRecorder.class) { busy = false; }
            Store.putBool(app, "evidence:" + incidentId, false);
            log(app, incidentId, "unsupported", 0);
            return;
        }
        log(app, incidentId, "started", seconds);
        final int[] voiced = { 0 };
        final Runnable sample = new Runnable() {
            @Override public void run() {
                try { if (r.getMaxAmplitude() > VOICE_AMPLITUDE) voiced[0]++; } catch (Exception ignored) {}
                MAIN.postDelayed(this, 250);
            }
        };
        MAIN.postDelayed(sample, 250);
        MAIN.postDelayed(() -> {
            MAIN.removeCallbacks(sample);
            try { r.stop(); } catch (Exception ignored) {}
            r.release();
            synchronized (EvidenceRecorder.class) { busy = false; }
            if (voiced[0] < 2) { f.delete(); log(app, incidentId, "no_voice", seconds); return; } // silence → nothing kept
            new Thread(() -> keepAndUpload(app, incidentId, f, seconds)).start();
        }, seconds * 1000L);
    }

    private static void keepAndUpload(Context app, String incidentId, File f, int seconds) {
        try {
            byte[] buf = new byte[(int) f.length()];
            try (FileInputStream in = new FileInputStream(f)) { int off = 0; while (off < buf.length) { int n = in.read(buf, off, buf.length - off); if (n < 0) break; off += n; } }
            f.delete();
            if (buf.length < 200) { log(app, incidentId, "no_voice", seconds); return; }
            File dir = new File(app.getFilesDir(), "evidence");
            if (dir.isDirectory() || dir.mkdirs()) {
                try (FileOutputStream out = new FileOutputStream(new File(dir, "sos-" + incidentId.substring(0, Math.min(8, incidentId.length())) + "-" + System.currentTimeMillis() + ".m4a"))) { out.write(buf); }
            }
            JSONObject j = new JSONObject();
            j.put("mime", "audio/mp4");
            j.put("kind", "audio");
            j.put("durationSec", seconds);
            j.put("auto", true);
            j.put("data", Base64.encodeToString(buf, Base64.NO_WRAP));
            Api.post(app, "/incidents/" + incidentId + "/evidence", j, (status, body) -> { if (status < 200 || status >= 300) log(app, incidentId, "upload_failed", seconds); });
        } catch (Exception e) { log(app, incidentId, "upload_failed", seconds); }
    }

    private static void log(Context app, String incidentId, String event, int seconds) {
        try {
            JSONObject j = new JSONObject();
            j.put("event", event);
            if (seconds > 0) j.put("seconds", seconds);
            Api.post(app, "/incidents/" + incidentId + "/evidence-log", j, null);
        } catch (Exception ignored) {}
    }
}
