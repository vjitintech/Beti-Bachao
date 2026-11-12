package app.betibachao.safety;

import android.content.Context;
import android.location.Location;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Talks to the Beti Bachao server from native code (works while the app is closed). */
public final class Api {
    private static final ExecutorService IO = Executors.newSingleThreadExecutor();

    private Api() {}

    public interface Callback { void done(int status, JSONObject body); }

    public static void post(Context ctx, String path, JSONObject body, Callback cb) {
        final Context app = ctx.getApplicationContext();
        IO.execute(() -> {
            int status = 0;
            JSONObject out = null;
            HttpURLConnection con = null;
            try {
                String server = Store.server(app);
                String token = Store.token(app);
                if (server.isEmpty() || token == null) { if (cb != null) cb.done(0, null); return; }
                con = (HttpURLConnection) new URL(server + "/api/v1" + path).openConnection();
                con.setRequestMethod("POST");
                con.setConnectTimeout(10000);
                con.setReadTimeout(15000);
                con.setDoOutput(true);
                con.setRequestProperty("Content-Type", "application/json");
                con.setRequestProperty("Authorization", "Bearer " + token);
                con.setRequestProperty("X-BB-CSRF", "1");
                try (OutputStream os = con.getOutputStream()) { os.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
                status = con.getResponseCode();
                BufferedReader br = new BufferedReader(new InputStreamReader(status < 400 ? con.getInputStream() : con.getErrorStream(), StandardCharsets.UTF_8));
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = br.readLine()) != null) sb.append(line);
                br.close();
                if (sb.length() > 0) out = new JSONObject(sb.toString());
            } catch (Exception ignored) {
            } finally {
                if (con != null) con.disconnect();
            }
            if (cb != null) cb.done(status, out);
        });
    }

    public static JSONObject locationJson(Location l) {
        JSONObject j = new JSONObject();
        try {
            j.put("lat", l.getLatitude());
            j.put("lng", l.getLongitude());
            j.put("accuracyM", l.hasAccuracy() ? Math.round(l.getAccuracy()) : 9999);
            if (l.hasAltitude()) j.put("altitudeM", l.getAltitude());
            if (android.os.Build.VERSION.SDK_INT >= 26 && l.hasVerticalAccuracy()) j.put("verticalAccuracyM", l.getVerticalAccuracyMeters());
            j.put("source", l.hasAccuracy() && l.getAccuracy() <= 100 ? "gps" : "network");
            j.put("observedAt", new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US) {{ setTimeZone(java.util.TimeZone.getTimeZone("UTC")); }}.format(new java.util.Date(l.getTime())));
        } catch (Exception ignored) {}
        return j;
    }

    public static void postLocation(Context ctx, Location l) {
        final Context app = ctx.getApplicationContext();
        post(app, "/me/location", locationJson(l), (status, body) -> {
            // Police auto-connect started on the server: call now (also works when push is not configured).
            JSONObject pc = body == null ? null : body.optJSONObject("policeCall");
            if (pc != null && "user".equals(Store.get(app, "role"))) {
                final String number = pc.optString("number"), id = pc.optString("incidentId");
                new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> PoliceCaller.call(app, number, id));
            }
        });
    }

    public static void registerDevice(Context ctx, String fcmToken) {
        try {
            JSONObject j = new JSONObject();
            j.put("platform", "android");
            j.put("token", fcmToken);
            j.put("appVersion", BuildConfig.VERSION_NAME);
            post(ctx, "/me/devices", j, null);
        } catch (Exception ignored) {}
    }
}
