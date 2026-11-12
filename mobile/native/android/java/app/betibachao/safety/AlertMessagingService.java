package app.betibachao.safety;

import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * Receives Firebase pushes even when the app is closed. Urgent ones (a new SOS
 * nearby, an escalation for operators) ring like an alarm and show over the
 * lock screen (full-screen when the user allowed it on Android 14+).
 */
public class AlertMessagingService extends FirebaseMessagingService {
    @Override
    public void onNewToken(@NonNull String token) {
        Store.put(this, "fcmToken", token);
        Api.registerDevice(this, token);
    }

    @Override
    public void onMessageReceived(@NonNull RemoteMessage msg) {
        Map<String, String> d = msg.getData();
        MainActivity.installCrashRecorder(getApplicationContext());
        // Police auto-connect reached her phone: call the station / 1091 / 112 now, even if the app is closed.
        if ("POLICE_CONNECTED".equals(d.get("kind")) && d.get("callNumber") != null && !d.get("callNumber").isEmpty() && "user".equals(Store.get(this, "role"))) {
            PoliceCaller.call(this, d.get("callNumber"), d.get("incidentId"));
        }
        String title = d.containsKey("title") ? d.get("title") : (msg.getNotification() != null ? msg.getNotification().getTitle() : "Beti Bachao");
        String body = d.containsKey("body") ? d.get("body") : (msg.getNotification() != null ? msg.getNotification().getBody() : "");
        String url = d.containsKey("url") ? d.get("url") : "#/";
        boolean urgent = "1".equals(d.get("urgent"));
        Notify.channels(this);
        int id = (d.containsKey("tag") ? d.get("tag") : title).hashCode();
        PendingIntent open = Notify.openApp(this, url, id);
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, urgent ? Notify.CH_ALERTS : Notify.CH_UPDATES)
                .setSmallIcon(R.drawable.ic_sos)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setContentIntent(open)
                .setAutoCancel(true)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setPriority(urgent ? NotificationCompat.PRIORITY_MAX : NotificationCompat.PRIORITY_DEFAULT)
                .setCategory(urgent ? NotificationCompat.CATEGORY_ALARM : NotificationCompat.CATEGORY_STATUS);
        if (urgent) {
            b.addAction(0, "RESPOND", open);
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            boolean fsAllowed = Build.VERSION.SDK_INT < 34 || nm.canUseFullScreenIntent();
            if (fsAllowed) b.setFullScreenIntent(open, true);
        }
        Notify.show(this, id, b);
    }
}
