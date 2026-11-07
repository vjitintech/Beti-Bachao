package app.betibachao.safety;

import android.Manifest;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;

import java.util.ArrayList;
import java.util.List;

/** JavaScript bridge "BetiNative" used by public/js/native.js. */
@CapacitorPlugin(
        name = "BetiNative",
        permissions = {
                @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }),
                @Permission(alias = "sms", strings = { Manifest.permission.SEND_SMS }),
                @Permission(alias = "notifications", strings = { "android.permission.POST_NOTIFICATIONS" })
        }
)
public class BetiNativePlugin extends Plugin {

    @PluginMethod
    public void secureGet(PluginCall call) {
        JSObject r = new JSObject();
        r.put("value", Store.getSecret(getContext(), call.getString("key", "")));
        call.resolve(r);
    }

    @PluginMethod
    public void secureSet(PluginCall call) {
        Store.putSecret(getContext(), call.getString("key", ""), call.getString("value", ""));
        call.resolve();
    }

    /** Everything the background SOS needs while the app is closed. */
    @PluginMethod
    public void configure(PluginCall call) {
        Context c = getContext();
        if (call.hasOption("serverUrl")) Store.put(c, "serverUrl", call.getString("serverUrl"));
        if (call.hasOption("token")) Store.putSecret(c, "token", call.getString("token"));
        if (call.hasOption("contacts")) { JSArray a = call.getArray("contacts"); Store.put(c, "contacts", a == null ? "[]" : a.toString()); }
        for (String k : new String[]{ "sms112", "autoSms", "shake", "powerButton", "armed" }) {
            if (call.hasOption(k)) Store.putBool(c, k, Boolean.TRUE.equals(call.getBoolean(k)));
        }
        if (call.hasOption("role")) Store.put(c, "role", call.getString("role"));
        if (call.hasOption("token") && call.getString("token") == null) SafetyService.stop(c);
        call.resolve();
    }

    @PluginMethod
    public void sendSos(PluginCall call) {
        if (getPermissionState("sms") != PermissionState.GRANTED) { requestPermissionForAlias("sms", call, "smsPermissionDone"); return; }
        doSendSms(call);
    }

    @PermissionCallback
    private void smsPermissionDone(PluginCall call) { doSendSms(call); }

    private void doSendSms(PluginCall call) {
        List<String> numbers = new ArrayList<>();
        try {
            JSArray a = call.getArray("numbers");
            if (a != null) for (int i = 0; i < a.length(); i++) numbers.add(a.getString(i));
        } catch (Exception ignored) {}
        if (Boolean.TRUE.equals(call.getBoolean("sms112", false))) numbers.add("112");
        int sent = SmsSender.send(getContext(), numbers, call.getString("message", "SOS! I need help. — Beti Bachao"));
        JSObject r = new JSObject();
        r.put("sent", sent);
        r.put("failed", numbers.size() - sent);
        r.put("permission", SmsSender.allowed(getContext()));
        call.resolve(r);
    }

    @PluginMethod
    public void startSafety(PluginCall call) {
        String mode = call.getString("mode", "armed");
        if (!"armed".equals(mode) || getPermissionState("location") == PermissionState.GRANTED) {
            SafetyService.start(getContext(), mode);
            call.resolve();
            return;
        }
        requestPermissionForAlias("location", call, "locationForSafetyDone");
    }

    @PermissionCallback
    private void locationForSafetyDone(PluginCall call) {
        SafetyService.start(getContext(), call.getString("mode", "armed"));
        call.resolve();
    }

    @PluginMethod
    public void stopSafety(PluginCall call) {
        SafetyService.stop(getContext());
        call.resolve();
    }

    @PluginMethod
    public void requestPermissions(PluginCall call) {
        requestAllPermissions(call, "allPermissionsDone");
    }

    @PermissionCallback
    private void allPermissionsDone(PluginCall call) {
        // Android 10+: "Allow all the time" must be asked separately after foreground location.
        if (Build.VERSION.SDK_INT >= 29 && getPermissionState("location") == PermissionState.GRANTED
                && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_BACKGROUND_LOCATION) != PackageManager.PERMISSION_GRANTED
                && getActivity() != null) {
            ActivityCompat.requestPermissions(getActivity(), new String[]{ Manifest.permission.ACCESS_BACKGROUND_LOCATION }, 9071);
        }
        permissionStatus(call);
    }

    @PluginMethod
    public void permissionStatus(PluginCall call) {
        Context c = getContext();
        JSObject r = new JSObject();
        r.put("location", getPermissionState("location").toString());
        r.put("locationAllTheTime", Build.VERSION.SDK_INT < 29 || ContextCompat.checkSelfPermission(c, Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED ? "granted" : "not granted");
        r.put("sms", getPermissionState("sms").toString());
        r.put("notifications", Build.VERSION.SDK_INT < 33 ? "granted" : getPermissionState("notifications").toString());
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        r.put("fullScreenAlerts", Build.VERSION.SDK_INT < 34 || nm.canUseFullScreenIntent() ? "allowed" : "not allowed");
        PowerManager pm = (PowerManager) c.getSystemService(Context.POWER_SERVICE);
        r.put("batteryOptimisation", pm != null && pm.isIgnoringBatteryOptimizations(c.getPackageName()) ? "off (good)" : "on (alerts may be delayed)");
        call.resolve(r);
    }

    @PluginMethod
    public void canUseFullScreenAlerts(PluginCall call) {
        NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        JSObject r = new JSObject();
        r.put("allowed", Build.VERSION.SDK_INT < 34 || nm.canUseFullScreenIntent());
        call.resolve(r);
    }

    @PluginMethod
    public void getPushToken(PluginCall call) {
        JSObject r = new JSObject();
        r.put("appVersion", BuildConfig.VERSION_NAME);
        if (FirebaseApp.getApps(getContext()).isEmpty()) { r.put("token", null); r.put("reason", "firebase-not-configured"); call.resolve(r); return; }
        FirebaseMessaging.getInstance().getToken().addOnCompleteListener(t -> {
            r.put("token", t.isSuccessful() ? t.getResult() : null);
            if (t.isSuccessful()) Store.put(getContext(), "fcmToken", t.getResult());
            call.resolve(r);
        });
    }

    /** What opened the app (lock-screen SOS, tile, widget, notification), consumed once. */
    @PluginMethod
    public void takeLaunchAction(PluginCall call) {
        Context c = getContext();
        String url = Store.get(c, "launch_url");
        Store.put(c, "launch_url", null);
        if (url == null) { call.resolve(new JSObject()); return; }
        JSObject r = new JSObject();
        r.put("url", url);
        call.resolve(r);
    }

    @PluginMethod
    public void openSystemSettings(PluginCall call) {
        String which = call.getString("which", "app");
        Context c = getContext();
        Intent i;
        if ("fullScreenIntent".equals(which) && Build.VERSION.SDK_INT >= 34) {
            i = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + c.getPackageName()));
        } else if ("batteryOptimization".equals(which)) {
            i = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
        } else {
            i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + c.getPackageName()));
        }
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try { c.startActivity(i); } catch (Exception e) {
            Intent f = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + c.getPackageName()));
            f.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(f);
        }
        call.resolve();
    }
}
