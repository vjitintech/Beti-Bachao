package app.betibachao.safety;

import android.content.Context;
import android.location.Location;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Location-based contacts on the phone itself (same rule as the server, public/core/protect.js):
 * the 3–5 contacts of the saved place she is at (or the nearest within 25 km), plus every
 * "important" contact. Falls back to the default list when she is away from all places.
 */
public final class Places {
    private Places() {}

    public static List<String> numbersFor(Context ctx, Location loc) {
        Set<String> out = new LinkedHashSet<>();
        try {
            JSONArray defaults = new JSONArray(orEmpty(Store.get(ctx, "contacts")));
            for (int i = 0; i < defaults.length(); i++) { JSONObject c = defaults.getJSONObject(i); if (c.optBoolean("always")) out.add(c.optString("phone")); }
            JSONObject place = null;
            if (loc != null) {
                JSONArray places = new JSONArray(orEmpty(Store.get(ctx, "places")));
                double best = Double.MAX_VALUE; JSONObject nearest = null;
                for (int i = 0; i < places.length(); i++) {
                    JSONObject p = places.getJSONObject(i);
                    float[] d = new float[1];
                    Location.distanceBetween(loc.getLatitude(), loc.getLongitude(), p.optDouble("lat"), p.optDouble("lng"), d);
                    if (d[0] <= p.optDouble("radiusM", 2000) && d[0] < best) { best = d[0]; place = p; }
                    if (nearest == null || d[0] < bestOf(nearest, loc)) nearest = p;
                }
                if (place == null && nearest != null && bestOf(nearest, loc) <= 25000) place = nearest;
            }
            JSONArray base = place != null ? place.optJSONArray("contacts") : defaults;
            if (base != null) for (int i = 0; i < base.length(); i++) out.add(base.getJSONObject(i).optString("phone"));
        } catch (Exception ignored) {}
        out.remove("");
        return new ArrayList<>(out);
    }

    private static float bestOf(JSONObject p, Location loc) {
        float[] d = new float[1];
        Location.distanceBetween(loc.getLatitude(), loc.getLongitude(), p.optDouble("lat"), p.optDouble("lng"), d);
        return d[0];
    }

    private static String orEmpty(String s) { return s == null || s.isEmpty() ? "[]" : s; }
}
