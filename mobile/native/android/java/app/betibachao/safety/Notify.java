package app.betibachao.safety;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;

import androidx.core.app.NotificationCompat;

/** Notification channels and helpers. */
public final class Notify {
    public static final String CH_STATUS = "safety_status";   // quiet, persistent "protecting you"
    public static final String CH_SOS = "sos_countdown";      // SOS countdown / sent
    public static final String CH_ALERTS = "sos_alerts";      // volunteer & operator alarms (loud)
    public static final String CH_UPDATES = "updates";        // ordinary updates

    private Notify() {}

    public static void channels(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        NotificationChannel status = new NotificationChannel(CH_STATUS, "Background protection", NotificationManager.IMPORTANCE_LOW);
        status.setDescription("Shows the SOS button on the lock screen while protection is on");
        status.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        NotificationChannel sos = new NotificationChannel(CH_SOS, "SOS", NotificationManager.IMPORTANCE_HIGH);
        sos.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        NotificationChannel alerts = new NotificationChannel(CH_ALERTS, "SOS alerts (volunteers)", NotificationManager.IMPORTANCE_HIGH);
        alerts.setDescription("Loud alarm when someone nearby needs help");
        Uri alarm = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
        alerts.setSound(alarm, new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
        alerts.enableVibration(true);
        alerts.setVibrationPattern(new long[]{0, 600, 250, 600, 250, 1200});
        alerts.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        alerts.setBypassDnd(true);
        NotificationChannel updates = new NotificationChannel(CH_UPDATES, "Updates", NotificationManager.IMPORTANCE_DEFAULT);
        nm.createNotificationChannel(status);
        nm.createNotificationChannel(sos);
        nm.createNotificationChannel(alerts);
        nm.createNotificationChannel(updates);
    }

    public static int piFlags() { return PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE; }

    public static PendingIntent openApp(Context ctx, String url, int req) {
        Intent i = new Intent(ctx, MainActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (url != null) i.putExtra("bb_url", url);
        return PendingIntent.getActivity(ctx, req, i, piFlags());
    }

    public static PendingIntent broadcast(Context ctx, String action, String trigger, int req) {
        Intent i = new Intent(ctx, SosReceiver.class);
        i.setAction(action);
        if (trigger != null) i.putExtra("trigger", trigger);
        return PendingIntent.getBroadcast(ctx, req, i, piFlags());
    }

    public static void show(Context ctx, int id, NotificationCompat.Builder b) {
        try {
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            nm.notify(id, b.build());
        } catch (SecurityException ignored) {
            // POST_NOTIFICATIONS not granted; the SOS itself still proceeds.
        }
    }
}
