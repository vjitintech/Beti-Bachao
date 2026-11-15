package app.betibachao.safety;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.Service;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import java.util.ArrayDeque;
import java.util.UUID;

/**
 * Bluetooth SOS button (iTag-style keychain / pendant). Separate from SafetyService so the
 * existing protection, SOS and notifications behave exactly as before; this runs only when
 * she has paired a button. Keeps the button connected (auto-reconnects), and a double press
 * starts the normal native SOS (5-second cancel countdown, SMS, server incident, police call).
 */
public class ButtonService extends Service {
    static final int NOTIF_ID = 7020;
    static final UUID SVC_BUTTON = uuid16(0xFFE0), CHR_BUTTON = uuid16(0xFFE1);
    static final UUID SVC_LINK_LOSS = uuid16(0x1803), CHR_ALERT_LEVEL = uuid16(0x2A06);
    static final UUID SVC_BATTERY = uuid16(0x180F), CHR_BATTERY = uuid16(0x2A19);
    static final UUID CCCD = uuid16(0x2902);

    /** Plugin hook so the open app can show live status / test presses. */
    interface Listener { void onButtonEvent(String type, String detail); }
    static volatile Listener listener;
    static volatile long testUntil = 0; // test mode ends by itself, so a forgotten test can never block a real SOS
    static volatile boolean connected = false;
    static volatile int battery = -1;

    private static final PressDetector DETECTOR = new PressDetector();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ArrayDeque<Runnable> ops = new ArrayDeque<>(); // BLE allows one GATT operation at a time
    private boolean opBusy = false;
    private BluetoothGatt gatt;
    private BroadcastReceiver btState;
    private String address, gattAddr;

    static UUID uuid16(int v) { return UUID.fromString(String.format("0000%04x-0000-1000-8000-00805f9b34fb", v)); }

    public static boolean paired(Context ctx) { return Store.get(ctx, "btnAddr") != null; }

    public static void start(Context ctx) {
        if (!paired(ctx) || !hasBtPermission(ctx)) return;
        try { ContextCompat.startForegroundService(ctx, new Intent(ctx, ButtonService.class)); } catch (Exception ignored) {}
    }

    public static void stop(Context ctx) {
        connected = false;
        ctx.stopService(new Intent(ctx, ButtonService.class));
    }

    static boolean hasBtPermission(Context ctx) {
        if (Build.VERSION.SDK_INT >= 31) return ContextCompat.checkSelfPermission(ctx, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
        return true;
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        MainActivity.installCrashRecorder(getApplicationContext());
        Notify.channels(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        address = Store.get(this, "btnAddr");
        if (address == null || !hasBtPermission(this)) { stopSelf(); return START_NOT_STICKY; }
        int type = Build.VERSION.SDK_INT >= 29 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE : 0;
        try { ServiceCompat.startForeground(this, NOTIF_ID, notification(), type); }
        catch (Exception e) { stopSelf(); return START_NOT_STICKY; }
        watchBluetooth();
        if (gatt == null || !address.equals(gattAddr)) { DETECTOR.reset(); connect(false); }
        return START_STICKY;
    }

    private Notification notification() {
        BluetoothAdapter a = adapter();
        String title, text;
        if (a == null || !a.isEnabled()) { title = "SOS button: Bluetooth is off"; text = "Turn on Bluetooth so your SOS button works."; }
        else if (connected) { title = "SOS button connected" + (battery >= 0 ? " · battery " + battery + "%" : ""); text = "Press your button twice quickly for SOS."; }
        else { title = "SOS button not connected"; text = "Keep your button near your phone. It reconnects by itself."; }
        return new NotificationCompat.Builder(this, Notify.CH_STATUS)
                .setSmallIcon(R.drawable.ic_sos)
                .setContentTitle(title)
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setContentIntent(Notify.openApp(this, "#/settings", 41))
                .build();
    }

    private void refreshNotification() {
        try {
            android.app.NotificationManager nm = (android.app.NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            nm.notify(NOTIF_ID, notification());
        } catch (Exception ignored) {}
    }

    private BluetoothAdapter adapter() {
        BluetoothManager m = (BluetoothManager) getSystemService(BLUETOOTH_SERVICE);
        return m == null ? null : m.getAdapter();
    }

    private void watchBluetooth() {
        if (btState != null) return;
        btState = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent i) {
                int s = i.getIntExtra(BluetoothAdapter.EXTRA_STATE, -1);
                if (s == BluetoothAdapter.STATE_ON) connect(false);
                if (s == BluetoothAdapter.STATE_OFF) { closeGatt(); setConnected(false); }
                refreshNotification();
            }
        };
        ContextCompat.registerReceiver(this, btState, new IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED), ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    // First try a direct connection (fast while she is pairing); after that Android's
    // autoConnect waits in the background and reconnects whenever the button comes back in range.
    @SuppressLint("MissingPermission")
    private void connect(boolean auto) {
        BluetoothAdapter a = adapter();
        if (a == null || !a.isEnabled() || address == null) return;
        closeGatt();
        try {
            BluetoothDevice d = a.getRemoteDevice(address);
            gattAddr = address;
            gatt = Build.VERSION.SDK_INT >= 23 ? d.connectGatt(this, auto, cb, BluetoothDevice.TRANSPORT_LE) : d.connectGatt(this, auto, cb);
        } catch (Exception e) { emit("error", e.getMessage()); }
    }

    @SuppressLint("MissingPermission")
    private void closeGatt() {
        ops.clear(); opBusy = false;
        if (gatt != null) { try { gatt.close(); } catch (Exception ignored) {} gatt = null; }
        gattAddr = null;
    }

    private void setConnected(boolean c) {
        connected = c;
        emit(c ? "connected" : "disconnected", address);
        refreshNotification();
    }

    private void queue(Runnable r) { main.post(() -> { ops.add(r); next(); }); }
    private void next() {
        if (opBusy || ops.isEmpty()) return;
        opBusy = true;
        try { ops.poll().run(); } catch (Exception e) { opBusy = false; next(); }
    }
    private void done() { main.post(() -> { opBusy = false; next(); }); }

    private final BluetoothGattCallback cb = new BluetoothGattCallback() {
        @SuppressLint("MissingPermission")
        @Override public void onConnectionStateChange(BluetoothGatt g, int status, int state) {
            main.post(() -> {
                if (state == BluetoothProfile.STATE_CONNECTED) {
                    setConnected(true);
                    queue(g::discoverServices);
                } else if (state == BluetoothProfile.STATE_DISCONNECTED) {
                    setConnected(false);
                    ops.clear(); opBusy = false;
                    // Out of range / error (e.g. 133): hand over to autoConnect, which waits for the button.
                    main.postDelayed(() -> connect(true), status == BluetoothGatt.GATT_SUCCESS ? 1000 : 5000);
                }
            });
        }

        @SuppressLint("MissingPermission")
        @Override public void onServicesDiscovered(BluetoothGatt g, int status) {
            done();
            BluetoothGattService s = g.getService(SVC_BUTTON);
            BluetoothGattCharacteristic c = s == null ? null : s.getCharacteristic(CHR_BUTTON);
            if (c != null) {
                g.setCharacteristicNotification(c, true);
                BluetoothGattDescriptor d = c.getDescriptor(CCCD);
                if (d != null) queue(() -> writeDescriptor(g, d, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE));
            } else emit("error", "This device has no button we can read. Try another tag.");
            // iTags beep loudly when the phone goes out of range — switch that off (it could draw attention).
            BluetoothGattService ll = g.getService(SVC_LINK_LOSS);
            BluetoothGattCharacteristic lvl = ll == null ? null : ll.getCharacteristic(CHR_ALERT_LEVEL);
            if (lvl != null) queue(() -> writeChar(g, lvl, new byte[]{ 0 }));
            BluetoothGattService bs = g.getService(SVC_BATTERY);
            BluetoothGattCharacteristic bc = bs == null ? null : bs.getCharacteristic(CHR_BATTERY);
            if (bc != null) queue(() -> { if (!g.readCharacteristic(bc)) done(); });
        }

        @Override public void onDescriptorWrite(BluetoothGatt g, BluetoothGattDescriptor d, int status) { done(); }
        @Override public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic c, int status) { done(); }

        @Override public void onCharacteristicRead(BluetoothGatt g, BluetoothGattCharacteristic c, int status) {
            onRead(c.getUuid(), c.getValue());
            done();
        }
        @Override public void onCharacteristicRead(BluetoothGatt g, BluetoothGattCharacteristic c, byte[] value, int status) {
            onRead(c.getUuid(), value);
            done();
        }

        @Override public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c) { onChanged(c.getUuid()); }
        @Override public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c, byte[] value) { onChanged(c.getUuid()); }
    };

    @SuppressLint("MissingPermission")
    @SuppressWarnings("deprecation")
    private void writeDescriptor(BluetoothGatt g, BluetoothGattDescriptor d, byte[] v) {
        boolean ok;
        if (Build.VERSION.SDK_INT >= 33) ok = g.writeDescriptor(d, v) == 0;
        else { d.setValue(v); ok = g.writeDescriptor(d); }
        if (!ok) done();
    }

    @SuppressLint("MissingPermission")
    @SuppressWarnings("deprecation")
    private void writeChar(BluetoothGatt g, BluetoothGattCharacteristic c, byte[] v) {
        boolean ok;
        if (Build.VERSION.SDK_INT >= 33) ok = g.writeCharacteristic(c, v, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == 0;
        else { c.setValue(v); c.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT); ok = g.writeCharacteristic(c); }
        if (!ok) done();
    }

    private void onRead(UUID id, byte[] v) {
        if (CHR_BATTERY.equals(id) && v != null && v.length > 0) {
            battery = v[0] & 0xFF;
            main.post(() -> { emit("battery", String.valueOf(battery)); refreshNotification(); });
        }
    }

    private void onChanged(UUID id) {
        if (!CHR_BUTTON.equals(id)) return;
        long now = System.currentTimeMillis();
        main.post(() -> {
            emit("press", null);
            if (!DETECTOR.press(now)) return;
            if (System.currentTimeMillis() < testUntil) { emit("test-ok", null); return; }
            if (!"user".equals(Store.get(this, "role")) || Store.token(this) == null) return;
            NativeSos.trigger(this, "button");
        });
    }

    private static void emit(String type, String detail) {
        Listener l = listener;
        if (l != null) { try { l.onButtonEvent(type, detail); } catch (Exception ignored) {} }
    }

    @Override
    public void onDestroy() {
        main.removeCallbacksAndMessages(null);
        closeGatt();
        connected = false;
        if (btState != null) { try { unregisterReceiver(btState); } catch (Exception ignored) {} btState = null; }
        super.onDestroy();
    }
}
