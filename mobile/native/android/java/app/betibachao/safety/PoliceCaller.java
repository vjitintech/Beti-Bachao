package app.betibachao.safety;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.telecom.TelecomManager;

import androidx.core.content.ContextCompat;

import org.json.JSONObject;

/**
 * Police auto-connect: her phone calls the nearest admin-loaded police station (≤ 30 km),
 * — only its first number, straight away, without her tapping the dialler, on the default SIM.
 * TelecomManager.placeCall works from the background (push message, service), unlike
 * starting the dialler activity. Each incident + number is called once, and the result
 * is reported to the server (the impact dashboard counts only calls that went out).
 */
public final class PoliceCaller {
    private PoliceCaller() {}

    /** @return true when the call was handed to the phone app. */
    public static synchronized boolean call(Context ctx, String number, String incidentId) {
        final Context app = ctx.getApplicationContext();
        if (number == null || number.trim().isEmpty()) return false;
        String n = number.replaceAll("[^0-9+]", "");
        String key = "policeCall:" + (incidentId == null ? "" : incidentId) + ":" + n;
        if (Store.getBool(app, key, false)) return true; // already called for this SOS
        if (Store.getBool(app, key + ":tried", false)) return false; // failed once (no permission / no SIM) — don't loop
        Store.putBool(app, key + ":tried", true);
        boolean ok = false;
        if (ContextCompat.checkSelfPermission(app, Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED) {
            try {
                TelecomManager tm = (TelecomManager) app.getSystemService(Context.TELECOM_SERVICE);
                Uri uri = Uri.fromParts("tel", n, null);
                if (tm != null && Build.VERSION.SDK_INT >= 23) {
                    Bundle extras = new Bundle();
                    extras.putBoolean(TelecomManager.EXTRA_START_CALL_WITH_SPEAKERPHONE, true); // she may not hold the phone
                    android.telecom.PhoneAccountHandle sim = SimPicker.callAccount(app); // default calling SIM, no SIM pop-up
                    if (sim != null) extras.putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, sim);
                    tm.placeCall(uri, extras);
                } else {
                    Intent i = new Intent(Intent.ACTION_CALL, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    app.startActivity(i);
                }
                ok = true;
            } catch (Exception ignored) { ok = false; }
        }
        if (ok) Store.putBool(app, key, true);
        if (incidentId != null && !incidentId.isEmpty()) {
            try {
                JSONObject j = new JSONObject();
                j.put("number", n);
                j.put("result", ok ? "placed" : "failed");
                Api.post(app, "/incidents/" + incidentId + "/police-call", j, null);
            } catch (Exception ignored) {}
        }
        return ok;
    }
}
