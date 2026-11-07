package app.betibachao.safety;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
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

    // A tapped notification (alert, SOS sent) tells the app which screen to open.
    private void rememberLaunch(Intent intent) {
        if (intent == null) return;
        String url = intent.getStringExtra("bb_url");
        if (url != null) Store.put(this, "launch_url", url);
    }
}
