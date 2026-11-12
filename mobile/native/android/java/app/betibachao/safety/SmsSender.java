package app.betibachao.safety;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.telephony.SmsManager;

import androidx.core.content.ContextCompat;

import java.util.ArrayList;
import java.util.List;

/**
 * Sends the SOS SMS directly from her phone (no tap needed). Google Play allows
 * SEND_SMS for apps whose core purpose is physical-safety emergency alerts,
 * after a Permissions Declaration review.
 */
public final class SmsSender {
    private SmsSender() {}

    public static boolean allowed(Context ctx) {
        return ContextCompat.checkSelfPermission(ctx, Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED;
    }

    /** @return number of recipients the message was handed to the radio for. */
    public static int send(Context ctx, List<String> numbers, String message) {
        if (!allowed(ctx) || numbers == null || numbers.isEmpty()) return 0;
        SmsManager sms = SimPicker.smsManager(ctx); // default SIM, no "choose SIM" pop-up
        if (sms == null) return 0;
        int sent = 0;
        for (String n : numbers) {
            if (n == null || n.trim().isEmpty()) continue;
            try {
                ArrayList<String> parts = sms.divideMessage(message);
                if (parts.size() > 1) sms.sendMultipartTextMessage(n.trim(), null, parts, null, null);
                else sms.sendTextMessage(n.trim(), null, message, null, null);
                sent++;
            } catch (Exception ignored) {}
        }
        return sent;
    }
}
