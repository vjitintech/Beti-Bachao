package app.betibachao.safety;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Context;
import android.content.pm.PackageManager;
import android.location.Location;
import android.os.Handler;
import android.os.Looper;
import android.os.Vibrator;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;
import com.google.android.gms.tasks.CancellationTokenSource;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

/**
 * SOS raised outside the app screen (lock-screen button, quick tile, widget,
 * shake, power button). A 5-second countdown notification lets her cancel an
 * accidental press; then SMS are sent from the phone, the incident is created on
 * the server and live location tracking starts.
 */
public final class NativeSos {
    static final int NOTIF_COUNTDOWN = 7001;
    static final int NOTIF_SENT = 7002;
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static String pendingId = null;

    private NativeSos() {}

    public static synchronized void trigger(Context ctx, String trigger) {
        final Context app = ctx.getApplicationContext();
        if (pendingId != null) return; // a countdown is already running
        Notify.channels(app);
        final String id = UUID.randomUUID().toString();
        pendingId = id;
        countdown(app, id, trigger, 5);
    }

    public static synchronized void cancel(Context ctx) {
        pendingId = null;
        android.app.NotificationManager nm = (android.app.NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        nm.cancel(NOTIF_COUNTDOWN);
    }

    private static void countdown(Context app, String id, String trigger, int left) {
        synchronized (NativeSos.class) { if (!id.equals(pendingId)) return; }
        if (left <= 0) {
            synchronized (NativeSos.class) { pendingId = null; }
            ((android.app.NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE)).cancel(NOTIF_COUNTDOWN);
            send(app, trigger);
            return;
        }
        NotificationCompat.Builder b = new NotificationCompat.Builder(app, Notify.CH_SOS)
                .setSmallIcon(R.drawable.ic_sos)
                .setContentTitle("SOS in " + left + "s")
                .setContentText("Sending SOS to volunteers and your contacts. Tap Cancel if this was a mistake.")
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setOnlyAlertOnce(left < 5)
                .setOngoing(true)
                .addAction(0, "CANCEL", Notify.broadcast(app, SosReceiver.ACTION_CANCEL, null, 11))
                .addAction(0, "SEND NOW", Notify.broadcast(app, SosReceiver.ACTION_SEND_NOW, trigger, 12));
        Notify.show(app, NOTIF_COUNTDOWN, b);
        vibrate(app, 200);
        MAIN.postDelayed(() -> countdown(app, id, trigger, left - 1), 1000);
    }

    public static synchronized void sendNow(Context ctx, String trigger) {
        pendingId = null;
        ((android.app.NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE)).cancel(NOTIF_COUNTDOWN);
        send(ctx.getApplicationContext(), trigger);
    }

    @SuppressLint("MissingPermission")
    private static void send(Context app, String trigger) {
        vibrate(app, 800);
        boolean hasLoc = ContextCompat.checkSelfPermission(app, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        if (!hasLoc) { finish(app, trigger, null, null); return; }
        final FusedLocationProviderClient fused = LocationServices.getFusedLocationProviderClient(app);
        // Fast path: the last known fix (instant). If it is recent, the SMS goes out right now
        // with it; a fresh high-accuracy fix is still taken for the server and a follow-up SMS.
        fused.getLastLocation().addOnCompleteListener(last -> {
            Location l0 = last.isSuccessful() ? last.getResult() : null;
            boolean recent = l0 != null && (System.currentTimeMillis() - l0.getTime()) < 120_000;
            final Location quick = recent ? l0 : null;
            final String shareToken = newShareToken();
            final SmsResult first = sendSms(app, quick, shareToken, false);
            CancellationTokenSource cts = new CancellationTokenSource();
            final boolean[] done = {false};
            // Never hold the server alert for GPS longer than 3.5 s.
            MAIN.postDelayed(() -> { if (!done[0]) { done[0] = true; cts.cancel(); report(app, trigger, quick, shareToken, first); } }, 3500);
            fused.getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, cts.getToken()).addOnCompleteListener(t -> {
                Location fix = t.isSuccessful() ? t.getResult() : null;
                if (fix != null && quick == null && first.sent > 0) sendSms(app, fix, null, true); // location the first SMS lacked
                if (done[0]) return;
                done[0] = true;
                report(app, trigger, fix != null ? fix : quick, shareToken, first);
            });
        });
    }

    private static final class SmsResult { int sent; final List<String> numbers = new ArrayList<>(); }

    /** SMS from her own phone (works without internet). Plain GSM-7 English so it fits in 1–2 parts. */
    private static SmsResult sendSms(Context app, Location loc, String shareToken, boolean followUp) {
        SmsResult r = new SmsResult();
        if (!Store.getBool(app, "autoSms", true)) return r;
        List<String> numbers = Places.numbersFor(app, loc); // the contacts for the place she is at
        r.numbers.addAll(numbers);
        if (!followUp && Store.getBool(app, "sms112", false)) numbers.add("112");
        String where = loc == null ? "location coming in next SMS"
                : String.format(Locale.US, "https://maps.google.com/?q=%.5f,%.5f (+/-%dm)", loc.getLatitude(), loc.getLongitude(), Math.round(loc.getAccuracy()));
        String msg;
        if (followUp) msg = "SOS update - my location: " + where;
        else {
            String server = Store.get(app, "serverUrl");
            String live = server == null || server.isEmpty() || shareToken == null ? "" : " Live: " + server.replaceAll("/+$", "") + "/s/" + shareToken;
            msg = "SOS! I need help (Beti Bachao). Location: " + where + "." + live + " Call me or 112.";
        }
        r.sent = SmsSender.send(app, numbers, msg);
        return r;
    }

    // Kept for callers that pass a location directly.
    private static void finish(Context app, String trigger, Location loc, String unused) {
        String token = newShareToken();
        report(app, trigger, loc, token, sendSms(app, loc, token, false));
    }

    private static void report(Context app, String trigger, Location loc, String shareToken, SmsResult sms) {
        final int sent = sms.sent;
        final List<String> smsNumbers = sms.numbers;
        // 2) Incident on the server → staged volunteer search + operators.
        try {
            JSONObject body = new JSONObject();
            body.put("idempotencyKey", UUID.randomUUID().toString());
            body.put("severity", "HIGH");
            body.put("trigger", trigger);
            body.put("deviceSmsSent", sent > 0);
            body.put("shareToken", shareToken);
            if (sent > 0) body.put("deviceSmsNumbers", new JSONArray(smsNumbers));
            if (loc != null) body.put("location", Api.locationJson(loc));
            Api.post(app, "/incidents", body, (status, res) -> {
                String incidentId = null;
                try { if (res != null) incidentId = res.getJSONObject("incident").getString("id"); } catch (Exception ignored) {}
                String url = incidentId != null ? "#/incident/" + incidentId : "#/home";
                if (incidentId != null && status >= 200 && status < 300) { final String iid = incidentId; MAIN.post(() -> EvidenceRecorder.record(app, iid, 15)); }
                Store.put(app, "launch_url", url);
                NotificationCompat.Builder b = new NotificationCompat.Builder(app, Notify.CH_SOS)
                        .setSmallIcon(R.drawable.ic_sos)
                        .setContentTitle(status >= 200 && status < 300 ? "SOS sent — help is being found" : "SOS: no internet — SMS sent, call 112")
                        .setContentText("Tap to see who is coming. Call 112 if you are in immediate danger.")
                        .setPriority(NotificationCompat.PRIORITY_MAX)
                        .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                        .setContentIntent(Notify.openApp(app, url, 21))
                        .setAutoCancel(true);
                Notify.show(app, NOTIF_SENT, b);
            });
        } catch (Exception ignored) {}
        // 3) Live location tracking until she confirms she is safe in the app.
        SafetyService.start(app, "sos");
    }

    private static void vibrate(Context ctx, long ms) {
        try { Vibrator v = (Vibrator) ctx.getSystemService(Context.VIBRATOR_SERVICE); if (v != null) v.vibrate(ms); } catch (Exception ignored) {}
    }

    private static String newShareToken() {
        byte[] b = new byte[16];
        new java.security.SecureRandom().nextBytes(b);
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format(Locale.US, "%02x", x));
        return sb.toString();
    }
}
