package app.betibachao.safety;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.location.Location;
import android.os.Build;
import android.os.IBinder;
import android.os.Looper;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

import java.util.ArrayDeque;

/**
 * Foreground "safety" service. Runs while protection is on, while a volunteer
 * is on duty / responding, and during an SOS:
 *   - streams GPS to the server even with the screen locked
 *   - shows a persistent lock-screen notification with an SOS button
 *   - detects 3 firm shakes and 5 power-button presses → SOS (5 s cancel window)
 *   - listens for her SOS word (Voice SOS) when enabled
 * Modes: armed | trip | duty | assigned | sos
 */
public class SafetyService extends Service implements SensorEventListener {
    static final int NOTIF_ID = 7000;
    private FusedLocationProviderClient fused;
    private LocationCallback callback;
    private SensorManager sensors;
    private String mode = "armed";
    private final ArrayDeque<Long> shakes = new ArrayDeque<>();
    private final ArrayDeque<Long> presses = new ArrayDeque<>();
    private BroadcastReceiver screenReceiver;

    public static void start(Context ctx, String mode) {
        Intent i = new Intent(ctx, SafetyService.class);
        i.putExtra("mode", mode);
        Store.put(ctx, "safetyMode", mode);
        try { ContextCompat.startForegroundService(ctx, i); } catch (Exception ignored) {}
    }

    public static void stop(Context ctx) {
        Store.put(ctx, "safetyMode", null);
        ctx.stopService(new Intent(ctx, SafetyService.class));
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        MainActivity.installCrashRecorder(getApplicationContext());
        Notify.channels(this);
        fused = LocationServices.getFusedLocationProviderClient(this);
        sensors = (SensorManager) getSystemService(SENSOR_SERVICE);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && intent.getStringExtra("mode") != null) mode = intent.getStringExtra("mode");
        boolean hasLoc = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        boolean hasMic = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        // Microphone only when she turned Voice SOS on, or during an SOS for the 15 s evidence clip.
        boolean wantMic = hasMic && "user".equals(Store.get(this, "role")) && (Store.getBool(this, "voice", false) || ("sos".equals(mode) && Store.getBool(this, "autoEvidence", true)));
        int type = 0;
        if (Build.VERSION.SDK_INT >= 29 && hasLoc) type = ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION;
        if (Build.VERSION.SDK_INT >= 30 && wantMic) type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
        try {
            ServiceCompat.startForeground(this, NOTIF_ID, buildNotification(), type);
        } catch (Exception e) {
            // Android 14 refuses the microphone type when started from the background: keep location only.
            try { ServiceCompat.startForeground(this, NOTIF_ID, buildNotification(), Build.VERSION.SDK_INT >= 29 && hasLoc ? ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION : 0); }
            catch (Exception e2) { stopSelf(); return START_NOT_STICKY; }
        }
        startLocation(hasLoc);
        startTriggers();
        boolean woman = "armed".equals(mode) || "trip".equals(mode);
        if (woman && wantMic && Store.getBool(this, "voice", false)) VoiceGuard.start(this); else VoiceGuard.stop();
        return START_STICKY;
    }

    private Notification buildNotification() {
        String title, text;
        switch (mode) {
            case "sos": title = "SOS active — sharing your live location"; text = "Volunteers and operators can see where you are. Open the app when you are safe."; break;
            case "assigned": title = "Responding to an SOS"; text = "Sharing your location with her and the team."; break;
            case "trip": title = "Track my travel — sharing your trip"; text = "Your contacts can follow you. SOS starts automatically if you don't arrive."; break;
            case "duty": title = "On duty — ready for SOS alerts"; text = "Your location updates every 2 minutes."; break;
            default: title = "Beti Bachao is protecting you"; text = Store.getBool(this, "voice", false) ? "Press SOS, shake 3 times, press power 5 times or say your SOS word." : "Press SOS, shake 3 times, or press power 5 times.";
        }
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, Notify.CH_STATUS)
                .setSmallIcon(R.drawable.ic_sos)
                .setContentTitle(title)
                .setContentText(text)
                .setOngoing(true)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setContentIntent(Notify.openApp(this, null, 31));
        if ("armed".equals(mode) || "trip".equals(mode)) {
            b.addAction(0, "🆘 SOS", Notify.broadcast(this, SosReceiver.ACTION_TRIGGER, "lockscreen", 32));
        }
        return b.build();
    }

    @SuppressLint("MissingPermission")
    private void startLocation(boolean hasLoc) {
        if (callback != null) fused.removeLocationUpdates(callback);
        callback = null;
        if (!hasLoc || "armed".equals(mode)) return; // armed mode reads location only at SOS time
        long interval = "sos".equals(mode) ? 5000 : "assigned".equals(mode) ? 10000 : "trip".equals(mode) ? 30000 : 120000;
        LocationRequest req = new LocationRequest.Builder("duty".equals(mode) ? Priority.PRIORITY_BALANCED_POWER_ACCURACY : Priority.PRIORITY_HIGH_ACCURACY, interval)
                .setMinUpdateIntervalMillis(Math.max(3000, interval / 2))
                .build();
        callback = new LocationCallback() {
            @Override public void onLocationResult(@NonNull LocationResult r) {
                Location l = r.getLastLocation();
                if (l != null) Api.postLocation(SafetyService.this, l);
            }
        };
        fused.requestLocationUpdates(req, callback, Looper.getMainLooper());
    }

    private void startTriggers() {
        boolean womanArmed = "armed".equals(mode) || "trip".equals(mode);
        if (sensors != null) {
            sensors.unregisterListener(this);
            if (womanArmed && Store.getBool(this, "shake", false)) {
                Sensor acc = sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
                if (acc != null) sensors.registerListener(this, acc, SensorManager.SENSOR_DELAY_GAME);
            }
        }
        if (screenReceiver == null && womanArmed && Store.getBool(this, "powerButton", true)) {
            screenReceiver = new BroadcastReceiver() {
                @Override public void onReceive(Context c, Intent i) { onPowerPress(); }
            };
            IntentFilter f = new IntentFilter();
            f.addAction(Intent.ACTION_SCREEN_ON);
            f.addAction(Intent.ACTION_SCREEN_OFF);
            ContextCompat.registerReceiver(this, screenReceiver, f, ContextCompat.RECEIVER_NOT_EXPORTED);
        } else if (screenReceiver != null && !womanArmed) {
            unregisterReceiver(screenReceiver);
            screenReceiver = null;
        }
    }

    // Each power-button press toggles the screen; 5 toggles within 4 seconds = SOS.
    private void onPowerPress() {
        long now = System.currentTimeMillis();
        presses.addLast(now);
        while (!presses.isEmpty() && now - presses.peekFirst() > 4000) presses.removeFirst();
        if (presses.size() >= 5) { presses.clear(); NativeSos.trigger(this, "power"); }
    }

    @Override
    public void onSensorChanged(SensorEvent e) {
        float x = e.values[0], y = e.values[1], z = e.values[2];
        double g = Math.sqrt(x * x + y * y + z * z) / SensorManager.GRAVITY_EARTH;
        if (g < 2.6) return; // firm, deliberate shakes only
        long now = System.currentTimeMillis();
        if (!shakes.isEmpty() && now - shakes.peekLast() < 250) return;
        shakes.addLast(now);
        while (!shakes.isEmpty() && now - shakes.peekFirst() > 1500) shakes.removeFirst();
        if (shakes.size() >= 3) { shakes.clear(); NativeSos.trigger(this, "shake"); }
    }

    @Override public void onAccuracyChanged(Sensor sensor, int accuracy) {}

    @Override
    public void onDestroy() {
        if (callback != null) fused.removeLocationUpdates(callback);
        if (sensors != null) sensors.unregisterListener(this);
        VoiceGuard.stop();
        if (screenReceiver != null) { try { unregisterReceiver(screenReceiver); } catch (Exception ignored) {} }
        super.onDestroy();
    }
}
