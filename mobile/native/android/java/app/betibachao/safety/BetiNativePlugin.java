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
                @Permission(alias = "notifications", strings = { "android.permission.POST_NOTIFICATIONS" }),
                @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }),
                @Permission(alias = "phone", strings = { Manifest.permission.CALL_PHONE, Manifest.permission.READ_PHONE_STATE }),
                @Permission(alias = "bluetooth", strings = { "android.permission.BLUETOOTH_SCAN", "android.permission.BLUETOOTH_CONNECT" })
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
        if (call.hasOption("places")) { JSArray a = call.getArray("places"); Store.put(c, "places", a == null ? "[]" : a.toString()); }
        if (call.hasOption("keywords")) { JSArray a = call.getArray("keywords"); Store.put(c, "keywords", a == null ? "[]" : a.toString()); }
        if (call.hasOption("lang")) Store.put(c, "lang", call.getString("lang"));
        if (call.hasOption("voiceLang")) Store.put(c, "voiceLang", call.getString("voiceLang"));
        for (String k : new String[]{ "sms112", "autoSms", "shake", "powerButton", "armed", "voice", "autoEvidence" }) {
            if (call.hasOption(k)) Store.putBool(c, k, Boolean.TRUE.equals(call.getBoolean(k)));
        }
        if (call.hasOption("role")) Store.put(c, "role", call.getString("role"));
        if (call.hasOption("token") && call.getString("token") == null) SafetyService.stop(c);
        // SOS button (only if she paired one): stop on sign-out, keep running while she is signed in.
        if (call.hasOption("token") && call.getString("token") == null) ButtonService.stop(c);
        else if ("user".equals(Store.get(c, "role")) && Store.token(c) != null) ButtonService.start(c);
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
        JSArray list = call.getArray("aliases");
        if (list != null && list.length() > 0) {
            List<String> a = new ArrayList<>();
            for (int k = 0; k < list.length(); k++) { String v = list.optString(k); if (v != null && !v.isEmpty()) a.add(v); }
            requestPermissionForAliases(a.toArray(new String[0]), call, "allPermissionsDone");
            return;
        }
        if ("microphone".equals(call.getString("which"))) { requestPermissionForAlias("microphone", call, "allPermissionsDone"); return; }
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
        r.put("microphone (voice SOS, evidence)", getPermissionState("microphone").toString());
        r.put("notifications", Build.VERSION.SDK_INT < 33 ? "granted" : getPermissionState("notifications").toString());
        r.put("phone calls (police auto-call)", getPermissionState("phone").toString());
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

    // ---------------- accessibility & voice ----------------
    private android.speech.tts.TextToSpeech tts;
    private boolean ttsReady = false;

    @PluginMethod
    public void speak(PluginCall call) {
        final String text = call.getString("text", "");
        final String lang = call.getString("lang", "en-IN");
        if (tts == null) {
            tts = new android.speech.tts.TextToSpeech(getContext(), status -> { ttsReady = status == android.speech.tts.TextToSpeech.SUCCESS; if (ttsReady) say(text, lang); });
        } else if (ttsReady) say(text, lang);
        call.resolve();
    }

    private void say(String text, String lang) {
        try { tts.setLanguage(java.util.Locale.forLanguageTag(lang)); } catch (Exception ignored) {}
        tts.speak(text, android.speech.tts.TextToSpeech.QUEUE_FLUSH, null, "bb");
    }

    @PluginMethod
    public void announce(PluginCall call) {
        final String text = call.getString("text", "");
        getActivity().runOnUiThread(() -> { try { getBridge().getWebView().announceForAccessibility(text); } catch (Exception ignored) {} });
        call.resolve();
    }

    @PluginMethod
    public void screenReader(PluginCall call) {
        android.view.accessibility.AccessibilityManager am = (android.view.accessibility.AccessibilityManager) getContext().getSystemService(Context.ACCESSIBILITY_SERVICE);
        JSObject r = new JSObject();
        r.put("on", am != null && am.isEnabled() && am.isTouchExplorationEnabled());
        call.resolve(r);
    }

    /** The last native crash (stack trace), once — then forgotten. */
    @PluginMethod
    public void takeLastCrash(PluginCall call) {
        String v = Store.get(getContext(), "lastCrash");
        Store.put(getContext(), "lastCrash", null);
        JSObject r = new JSObject();
        r.put("crash", v);
        call.resolve(r);
    }

    /** Silent 15 s evidence clip after the SOS is active. */
    @PluginMethod
    public void recordEvidence(PluginCall call) {
        String id = call.getString("incidentId");
        int secs = call.getInt("seconds", 15);
        getActivity().runOnUiThread(() -> EvidenceRecorder.record(getContext(), id, secs));
        call.resolve();
    }

    /** Police auto-connect from the app: places the call straight away (asks for the permission first if needed). */
    @PluginMethod
    public void placeCall(PluginCall call) {
        if (getPermissionState("phone") != PermissionState.GRANTED) { requestPermissionForAlias("phone", call, "phoneForCallDone"); return; }
        doPlaceCall(call);
    }

    @PermissionCallback
    private void phoneForCallDone(PluginCall call) { doPlaceCall(call); }

    private void doPlaceCall(PluginCall call) {
        String number = call.getString("number");
        boolean placed = PoliceCaller.call(getContext(), number, call.getString("key"));
        if (!placed && number != null && getActivity() != null) {
            // No permission: open the dialler with the number ready — one tap to call.
            try { getActivity().startActivity(new Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", number.replaceAll("[^0-9+]", ""), null))); } catch (Exception ignored) {}
        }
        JSObject r = new JSObject();
        r.put("placed", placed);
        call.resolve(r);
    }

    /** One spoken phrase (voice commands in the app). */
    @PluginMethod
    public void listenOnce(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) { requestPermissionForAlias("microphone", call, "micForListenDone"); return; }
        doListen(call);
    }

    @PermissionCallback
    private void micForListenDone(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) doListen(call);
        else { JSObject r = new JSObject(); r.put("text", ""); call.resolve(r); }
    }

    private void doListen(PluginCall call) {
        // Free the microphone first: two recognisers at once is what makes Google say it "can't record now".
        getActivity().runOnUiThread(() -> VoiceGuard.pause(getContext(), (call.getInt("timeoutMs", 7000)) + 8000));
        new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
            if (!android.speech.SpeechRecognizer.isRecognitionAvailable(getContext())) { JSObject r = new JSObject(); r.put("text", ""); r.put("error", "unavailable"); call.resolve(r); return; }
            final android.speech.SpeechRecognizer sr = android.speech.SpeechRecognizer.createSpeechRecognizer(getContext());
            final boolean[] done = { false };
            final int[] err = { 0 };
            final java.util.function.Consumer<String> finish = (t) -> { if (done[0]) return; done[0] = true; try { sr.destroy(); } catch (Exception ignored) {} JSObject r = new JSObject(); r.put("text", t == null ? "" : t); if (err[0] != 0) r.put("error", err[0] == 8 ? "busy" : err[0] == 9 ? "permission" : err[0] == 3 ? "audio" : "nomatch"); call.resolve(r); };
            sr.setRecognitionListener(new android.speech.RecognitionListener() {
                @Override public void onResults(android.os.Bundle b) { java.util.ArrayList<String> l = b.getStringArrayList(android.speech.SpeechRecognizer.RESULTS_RECOGNITION); finish.accept(l == null || l.isEmpty() ? "" : l.get(0)); }
                @Override public void onError(int e) { err[0] = e; finish.accept(""); }
                @Override public void onReadyForSpeech(android.os.Bundle p) {}
                @Override public void onBeginningOfSpeech() {}
                @Override public void onRmsChanged(float v) {}
                @Override public void onBufferReceived(byte[] b) {}
                @Override public void onEndOfSpeech() {}
                @Override public void onPartialResults(android.os.Bundle b) {}
                @Override public void onEvent(int t, android.os.Bundle b) {}
            });
            Intent i = new Intent(android.speech.RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            i.putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE_MODEL, android.speech.RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            i.putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE, call.getString("lang", "en-IN"));
            i.putExtra(android.speech.RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
            try { sr.startListening(i); } catch (Exception e) { finish.accept(""); }
            new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> finish.accept(""), call.getInt("timeoutMs", 7000) + 3000);
        }, 450);
    }

    // ---------------------------------------------------------------- Bluetooth SOS button
    @Override
    public void load() {
        ButtonService.listener = (type, detail) -> {
            JSObject e = new JSObject();
            e.put("type", type);
            e.put("detail", detail);
            notifyListeners("sosButton", e);
        };
    }

    private android.bluetooth.BluetoothAdapter btAdapter() {
        android.bluetooth.BluetoothManager m = (android.bluetooth.BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        return m == null ? null : m.getAdapter();
    }

    private boolean btPermitted() {
        Context c = getContext();
        if (Build.VERSION.SDK_INT >= 31)
            return ContextCompat.checkSelfPermission(c, "android.permission.BLUETOOTH_SCAN") == PackageManager.PERMISSION_GRANTED
                    && ContextCompat.checkSelfPermission(c, "android.permission.BLUETOOTH_CONNECT") == PackageManager.PERMISSION_GRANTED;
        return ContextCompat.checkSelfPermission(c, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    @PluginMethod
    public void btState(PluginCall call) {
        Context c = getContext();
        android.bluetooth.BluetoothAdapter a = btAdapter();
        JSObject r = new JSObject();
        r.put("supported", a != null && c.getPackageManager().hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE));
        r.put("bluetoothOn", a != null && a.isEnabled());
        r.put("permission", btPermitted());
        r.put("paired", ButtonService.paired(c));
        r.put("address", Store.get(c, "btnAddr"));
        r.put("name", Store.get(c, "btnName"));
        r.put("connected", ButtonService.connected);
        r.put("battery", ButtonService.battery);
        call.resolve(r);
    }

    /** Asks for "Nearby devices" (Android 12+) or location (older), then scans for ~8 s. */
    @PluginMethod
    public void btScan(PluginCall call) {
        if (btPermitted()) { doBtScan(call); return; }
        requestPermissionForAlias(Build.VERSION.SDK_INT >= 31 ? "bluetooth" : "location", call, "btPermissionDone");
    }

    @PermissionCallback
    private void btPermissionDone(PluginCall call) {
        if (!btPermitted()) { JSObject r = new JSObject(); r.put("error", "permission"); call.resolve(r); return; }
        doBtScan(call);
    }

    @android.annotation.SuppressLint("MissingPermission")
    private void doBtScan(PluginCall call) {
        android.bluetooth.BluetoothAdapter a = btAdapter();
        JSObject r = new JSObject();
        if (a == null) { r.put("error", "unsupported"); call.resolve(r); return; }
        if (!a.isEnabled()) { r.put("error", "bluetooth-off"); call.resolve(r); return; }
        android.bluetooth.le.BluetoothLeScanner sc = a.getBluetoothLeScanner();
        if (sc == null) { r.put("error", "bluetooth-off"); call.resolve(r); return; }
        final java.util.Map<String, JSObject> found = new java.util.LinkedHashMap<>();
        final android.os.ParcelUuid ffe0 = new android.os.ParcelUuid(ButtonService.SVC_BUTTON);
        final android.bluetooth.le.ScanCallback cb = new android.bluetooth.le.ScanCallback() {
            @Override public void onScanResult(int type, android.bluetooth.le.ScanResult res) {
                android.bluetooth.BluetoothDevice d = res.getDevice();
                String name = null;
                try { name = d.getName(); } catch (SecurityException ignored) {}
                android.bluetooth.le.ScanRecord rec = res.getScanRecord();
                if (name == null && rec != null) name = rec.getDeviceName();
                boolean button = rec != null && rec.getServiceUuids() != null && rec.getServiceUuids().contains(ffe0);
                if (name == null && !button) return; // nameless devices can't be told apart
                String n = name == null ? "SOS button" : name;
                boolean likely = button || n.toLowerCase(java.util.Locale.ROOT).matches(".*(itag|i-tag|tag|sos|button|key|finder|anti|lost|pendant|alarm).*");
                JSObject o = new JSObject();
                o.put("address", d.getAddress());
                o.put("name", n);
                o.put("rssi", res.getRssi());
                o.put("likely", likely);
                synchronized (found) { found.put(d.getAddress(), o); }
            }
        };
        android.bluetooth.le.ScanSettings settings = new android.bluetooth.le.ScanSettings.Builder()
                .setScanMode(android.bluetooth.le.ScanSettings.SCAN_MODE_LOW_LATENCY).build();
        try { sc.startScan(null, settings, cb); } catch (Exception e) { r.put("error", "scan"); call.resolve(r); return; }
        int ms = Math.max(3000, Math.min(15000, call.getInt("ms", 8000)));
        new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
            try { sc.stopScan(cb); } catch (Exception ignored) {}
            java.util.List<JSObject> list;
            synchronized (found) { list = new ArrayList<>(found.values()); }
            list.sort((x, y) -> {
                boolean lx = x.optBoolean("likely"), ly = y.optBoolean("likely");
                if (lx != ly) return lx ? -1 : 1;
                return Integer.compare(y.optInt("rssi"), x.optInt("rssi"));
            });
            JSArray arr = new JSArray();
            for (JSObject o : list) arr.put(o);
            JSObject out = new JSObject();
            out.put("devices", arr);
            call.resolve(out);
        }, ms);
    }

    /** Opens Android's "Turn on Bluetooth?" prompt. */
    @PluginMethod
    public void btEnable(PluginCall call) {
        try {
            Intent i = new Intent(android.bluetooth.BluetoothAdapter.ACTION_REQUEST_ENABLE);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        } catch (Exception e) {
            try { Intent i = new Intent(Settings.ACTION_BLUETOOTH_SETTINGS); i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); getContext().startActivity(i); } catch (Exception ignored) {}
        }
        call.resolve();
    }

    @PluginMethod
    public void btPair(PluginCall call) {
        Context c = getContext();
        String addr = call.getString("address");
        if (addr == null || !android.bluetooth.BluetoothAdapter.checkBluetoothAddress(addr)) { call.reject("Invalid address"); return; }
        Store.putNow(c, "btnAddr", addr);
        Store.putNow(c, "btnName", call.getString("name", "SOS button"));
        ButtonService.connected = false;
        ButtonService.battery = -1;
        ButtonService.start(c);
        call.resolve();
    }

    @PluginMethod
    public void btForget(PluginCall call) {
        Context c = getContext();
        ButtonService.stop(c);
        Store.putNow(c, "btnAddr", null);
        Store.putNow(c, "btnName", null);
        ButtonService.battery = -1;
        call.resolve();
    }

    /** Test mode: a double press is reported to the app instead of starting an SOS. */
    @PluginMethod
    public void btTest(PluginCall call) {
        ButtonService.testUntil = Boolean.TRUE.equals(call.getBoolean("on", false)) ? System.currentTimeMillis() + 60_000 : 0;
        call.resolve();
    }
}
