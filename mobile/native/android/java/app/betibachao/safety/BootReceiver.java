package app.betibachao.safety;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import androidx.core.app.NotificationCompat;

/**
 * After a restart Android does not let apps silently resume location tracking,
 * so we remind her with one tap to switch background protection back on.
 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
        if (!Store.getBool(ctx, "armed", false) && Store.get(ctx, "safetyMode") == null) return;
        Notify.channels(ctx);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, Notify.CH_UPDATES)
                .setSmallIcon(R.drawable.ic_sos)
                .setContentTitle("Turn Beti Bachao protection back on")
                .setContentText("Your phone restarted. Tap to restore the lock-screen SOS button.")
                .setContentIntent(Notify.openApp(ctx, "#/home", 51))
                .setAutoCancel(true);
        Notify.show(ctx, 7010, b);
    }
}
