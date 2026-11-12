package app.betibachao.safety;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        installCrashRecorder(getApplicationContext());
        registerPlugin(BetiNativePlugin.class);
        super.onCreate(savedInstanceState);
        keepClearOfSystemBars();
        Notify.channels(this);
        rememberLaunch(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        rememberLaunch(intent);
    }

    // Android 15 draws apps edge-to-edge: without this the top of the app sits under the
    // status bar (clock, battery) and the bottom under the gesture bar.
    private void keepClearOfSystemBars() {
        try {
            android.view.View root = findViewById(android.R.id.content);
            androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
                androidx.core.graphics.Insets b = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.systemBars() | androidx.core.view.WindowInsetsCompat.Type.displayCutout());
                androidx.core.graphics.Insets ime = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.ime());
                v.setPadding(b.left, b.top, b.right, Math.max(b.bottom, ime.bottom));
                return androidx.core.view.WindowInsetsCompat.CONSUMED;
            });
            getWindow().setStatusBarColor(0xFF2A1B3D);
            getWindow().setNavigationBarColor(0xFFFFFFFF);
            androidx.core.view.WindowInsetsControllerCompat c = androidx.core.view.WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
            c.setAppearanceLightStatusBars(false);
            c.setAppearanceLightNavigationBars(true);
        } catch (Throwable ignored) {}
    }

    // A crash is written to the app's storage before Android closes the app; the next start
    // sends it to the server (Admin → Integrations → App errors) so it can be fixed.
    static void installCrashRecorder(android.content.Context ctx) {
        final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
        if (prev instanceof CrashTag) return;
        Thread.setDefaultUncaughtExceptionHandler(new CrashTag() {
            @Override public void uncaughtException(Thread t, Throwable e) {
                try {
                    java.io.StringWriter sw = new java.io.StringWriter();
                    e.printStackTrace(new java.io.PrintWriter(sw));
                    String trace = sw.toString();
                    Store.putNow(ctx, "lastCrash", "thread=" + t.getName() + " android=" + android.os.Build.VERSION.SDK_INT + " model=" + android.os.Build.MODEL + "\n" + (trace.length() > 6000 ? trace.substring(0, 6000) : trace));
                } catch (Throwable ignored) {}
                if (prev != null) prev.uncaughtException(t, e);
            }
        });
    }
    private abstract static class CrashTag implements Thread.UncaughtExceptionHandler {}

    // A tapped notification (alert, SOS sent) tells the app which screen to open.
    private void rememberLaunch(Intent intent) {
        if (intent == null) return;
        String url = intent.getStringExtra("bb_url");
        if (url != null) Store.put(this, "launch_url", url);
    }
}
