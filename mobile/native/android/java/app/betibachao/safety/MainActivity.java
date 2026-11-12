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
        Notify.channels(this);
        rememberLaunch(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        rememberLaunch(intent);
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
