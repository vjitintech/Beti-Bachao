package app.betibachao.safety;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.telecom.PhoneAccountHandle;
import android.telecom.TelecomManager;
import android.telephony.SmsManager;
import android.telephony.SubscriptionInfo;
import android.telephony.SubscriptionManager;

import androidx.core.content.ContextCompat;

import java.util.List;

/**
 * Dual-SIM phones: SOS SMS and the police call always go out on the phone's DEFAULT SIM,
 * without a "choose SIM" pop-up. If the phone is set to "Ask every time", the default
 * SIM for mobile data (or else the first active SIM) is used.
 */
final class SimPicker {
    private SimPicker() {}

    private static boolean canRead(Context c) {
        return ContextCompat.checkSelfPermission(c, Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED;
    }

    /** Subscription id for SMS, or INVALID when the phone decides. */
    @SuppressLint("MissingPermission")
    static int smsSubscription(Context c) {
        int id = SubscriptionManager.getDefaultSmsSubscriptionId();
        if (id == SubscriptionManager.INVALID_SUBSCRIPTION_ID) id = SubscriptionManager.getDefaultVoiceSubscriptionId();
        if (id == SubscriptionManager.INVALID_SUBSCRIPTION_ID) id = SubscriptionManager.getDefaultDataSubscriptionId();
        if (id == SubscriptionManager.INVALID_SUBSCRIPTION_ID) id = SubscriptionManager.getDefaultSubscriptionId();
        if (id == SubscriptionManager.INVALID_SUBSCRIPTION_ID && canRead(c)) {
            try {
                SubscriptionManager sm = c.getSystemService(SubscriptionManager.class);
                List<SubscriptionInfo> l = sm == null ? null : sm.getActiveSubscriptionInfoList();
                if (l != null && !l.isEmpty()) id = l.get(0).getSubscriptionId();
            } catch (Exception ignored) {}
        }
        return id;
    }

    static SmsManager smsManager(Context c) {
        int id = smsSubscription(c);
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                SmsManager m = c.getSystemService(SmsManager.class);
                if (m == null) return null;
                return id != SubscriptionManager.INVALID_SUBSCRIPTION_ID ? m.createForSubscriptionId(id) : m;
            }
            return id != SubscriptionManager.INVALID_SUBSCRIPTION_ID ? SmsManager.getSmsManagerForSubscriptionId(id) : SmsManager.getDefault();
        } catch (Exception e) {
            return Build.VERSION.SDK_INT >= 31 ? c.getSystemService(SmsManager.class) : SmsManager.getDefault();
        }
    }

    /** The calling account to use, or null to let the phone use its own default. */
    @SuppressLint("MissingPermission")
    static PhoneAccountHandle callAccount(Context c) {
        if (!canRead(c)) return null; // without it the phone's default calling SIM is used anyway
        try {
            TelecomManager tm = c.getSystemService(TelecomManager.class);
            if (tm == null) return null;
            PhoneAccountHandle def = tm.getDefaultOutgoingPhoneAccount("tel");
            if (def != null) return def; // the SIM chosen in Settings → SIM → Calls
            List<PhoneAccountHandle> all = tm.getCallCapablePhoneAccounts(); // "Ask every time": take the first SIM
            return all == null || all.isEmpty() ? null : all.get(0);
        } catch (Exception e) { return null; }
    }
}
