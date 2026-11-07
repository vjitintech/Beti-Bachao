package app.betibachao.safety;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Handles the lock-screen SOS button, widget taps and countdown Cancel / Send now. */
public class SosReceiver extends BroadcastReceiver {
    public static final String ACTION_TRIGGER = "app.betibachao.safety.SOS_TRIGGER";
    public static final String ACTION_CANCEL = "app.betibachao.safety.SOS_CANCEL";
    public static final String ACTION_SEND_NOW = "app.betibachao.safety.SOS_SEND_NOW";

    @Override
    public void onReceive(Context ctx, Intent intent) {
        String a = intent.getAction();
        String trigger = intent.getStringExtra("trigger");
        if (ACTION_TRIGGER.equals(a)) NativeSos.trigger(ctx, trigger == null ? "widget" : trigger);
        else if (ACTION_CANCEL.equals(a)) NativeSos.cancel(ctx);
        else if (ACTION_SEND_NOW.equals(a)) NativeSos.sendNow(ctx, trigger == null ? "widget" : trigger);
    }
}
