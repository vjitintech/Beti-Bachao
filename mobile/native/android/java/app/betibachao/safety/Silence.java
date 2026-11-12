package app.betibachao.safety;

import android.content.Context;
import android.media.AudioManager;
import android.os.Handler;
import android.os.Looper;

/**
 * Speech recognisers play a short beep when they start and stop listening. Voice SOS and
 * evidence recording must be silent, so the system/notification streams (and music when
 * nothing is playing) are muted for a moment around each start.
 */
final class Silence {
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static int depth = 0;
    private static boolean mutedMusic = false;
    private Silence() {}

    static void mute(Context ctx) {
        final AudioManager am = (AudioManager) ctx.getApplicationContext().getSystemService(Context.AUDIO_SERVICE);
        if (am == null) return;
        try {
            if (depth++ == 0) {
                adjust(am, AudioManager.STREAM_SYSTEM, AudioManager.ADJUST_MUTE);
                adjust(am, AudioManager.STREAM_NOTIFICATION, AudioManager.ADJUST_MUTE);
                mutedMusic = false; // her music / call audio is never touched
            }
        } catch (Exception ignored) {}
        MAIN.postDelayed(() -> {
            if (--depth > 0) return;
            depth = 0;
            adjust(am, AudioManager.STREAM_SYSTEM, AudioManager.ADJUST_UNMUTE);
            adjust(am, AudioManager.STREAM_NOTIFICATION, AudioManager.ADJUST_UNMUTE);
            if (mutedMusic) adjust(am, AudioManager.STREAM_MUSIC, AudioManager.ADJUST_UNMUTE);
            mutedMusic = false;
        }, 1500);
    }

    private static void adjust(AudioManager am, int stream, int dir) {
        try { am.adjustStreamVolume(stream, dir, 0); } catch (Exception ignored) {} // DND can refuse — never crash
    }
}
