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

/** Records 15 s of audio when an SOS starts outside the app and uploads it, encrypted at rest on the server. */
public final class EvidenceRecorder {
    private static boolean busy = false;
    private EvidenceRecorder() {}

    public static synchronized void record(Context ctx, String incidentId, int seconds) {
        final Context app = ctx.getApplicationContext();
        if (busy || incidentId == null || !Store.getBool(app, "autoEvidence", true)) return;
        if (ContextCompat.checkSelfPermission(app, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return;
        VoiceGuard.pause(app); // the microphone can only be used by one of them
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
            busy = true;
        } catch (Exception e) { try { r.release(); } catch (Exception ignored) {} return; }
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            try { r.stop(); } catch (Exception ignored) {}
            r.release();
            synchronized (EvidenceRecorder.class) { busy = false; }
            upload(app, incidentId, f, seconds);
        }, seconds * 1000L);
    }

    private static void upload(Context app, String incidentId, File f, int seconds) {
        try {
            byte[] buf = new byte[(int) f.length()];
            try (FileInputStream in = new FileInputStream(f)) { int off = 0; while (off < buf.length) { int n = in.read(buf, off, buf.length - off); if (n < 0) break; off += n; } }
            f.delete();
            if (buf.length < 200) return;
            JSONObject j = new JSONObject();
            j.put("mime", "audio/mp4");
            j.put("kind", "audio");
            j.put("durationSec", seconds);
            j.put("data", Base64.encodeToString(buf, Base64.NO_WRAP));
            Api.post(app, "/incidents/" + incidentId + "/evidence", j, null);
        } catch (Exception ignored) {}
    }
}
