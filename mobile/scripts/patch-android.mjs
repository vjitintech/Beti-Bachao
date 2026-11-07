// Runs after `npx cap add android`: copies the native safety modules into the
// generated project and patches the manifest, Gradle files and icons.
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const mobile = path.resolve(here, '..');
const app = path.join(mobile, 'android', 'app');
const main = path.join(app, 'src', 'main');
if (!fs.existsSync(main)) throw new Error('Run `npx cap add android` first');

const must = (s, needle, file) => { if (!s.includes(needle)) throw new Error(`patch-android: "${needle}" not found in ${file}`); };

// 1) Java sources (replaces the generated MainActivity) and resources
const pkgDir = path.join(main, 'java', 'app', 'betibachao', 'safety');
fs.mkdirSync(pkgDir, { recursive: true });
fs.cpSync(path.join(mobile, 'native', 'android', 'java', 'app', 'betibachao', 'safety'), pkgDir, { recursive: true });
fs.cpSync(path.join(mobile, 'native', 'android', 'res'), path.join(main, 'res'), { recursive: true });

// 2) Launcher icon: use the Beti Bachao icon at every density
const icon = path.resolve(mobile, '..', 'public', 'icons', 'icon-512.png');
for (const d of fs.readdirSync(path.join(main, 'res'))) {
  if (d.startsWith('mipmap-anydpi')) fs.rmSync(path.join(main, 'res', d), { recursive: true, force: true });
  else if (d.startsWith('mipmap-')) for (const f of ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png']) fs.copyFileSync(icon, path.join(main, 'res', d, f));
}

// 3) AndroidManifest.xml: permissions + components
const manPath = path.join(main, 'AndroidManifest.xml');
let man = fs.readFileSync(manPath, 'utf8');
const perms = [
  'ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION', 'ACCESS_BACKGROUND_LOCATION', 'FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_LOCATION',
  'POST_NOTIFICATIONS', 'SEND_SMS', 'VIBRATE', 'RECEIVE_BOOT_COMPLETED', 'USE_FULL_SCREEN_INTENT', 'WAKE_LOCK',
  'RECORD_AUDIO', 'CAMERA', 'MODIFY_AUDIO_SETTINGS',
].filter((p) => !man.includes(`android.permission.${p}"`)).map((p) => `    <uses-permission android:name="android.permission.${p}" />`).join('\n');
const features = ['android.hardware.telephony', 'android.hardware.location.gps', 'android.hardware.camera', 'android.hardware.sensor.accelerometer']
  .map((f) => `    <uses-feature android:name="${f}" android:required="false" />`).join('\n'); // tablets without SIM can install
must(man, '<application', 'AndroidManifest.xml');
man = man.replace('<application', `${perms}\n${features}\n\n    <application`);
const components = `
        <service android:name=".SafetyService" android:exported="false" android:foregroundServiceType="location" />
        <receiver android:name=".SosReceiver" android:exported="false" />
        <receiver android:name=".BootReceiver" android:exported="true">
            <intent-filter><action android:name="android.intent.action.BOOT_COMPLETED" /></intent-filter>
        </receiver>
        <receiver android:name=".SosWidget" android:exported="true" android:label="Beti Bachao SOS">
            <intent-filter><action android:name="android.appwidget.action.APPWIDGET_UPDATE" /></intent-filter>
            <meta-data android:name="android.appwidget.provider" android:resource="@xml/sos_widget_info" />
        </receiver>
        <service android:name=".SosTileService" android:exported="true" android:label="Beti Bachao SOS"
            android:icon="@drawable/ic_sos" android:permission="android.permission.BIND_QUICK_SETTINGS_TILE">
            <intent-filter><action android:name="android.service.quicksettings.action.QS_TILE" /></intent-filter>
            <meta-data android:name="android.service.quicksettings.TOGGLEABLE_TILE" android:value="false" />
        </service>
        <service android:name=".AlertMessagingService" android:exported="false">
            <intent-filter><action android:name="com.google.firebase.MESSAGING_EVENT" /></intent-filter>
        </service>
        <meta-data android:name="com.google.firebase.messaging.default_notification_channel_id" android:value="sos_alerts" />
        <meta-data android:name="com.google.firebase.messaging.default_notification_icon" android:resource="@drawable/ic_sos" />
    </application>`;
must(man, '</application>', 'AndroidManifest.xml');
man = man.replace('</application>', components);
fs.writeFileSync(manPath, man);

// 4) app/build.gradle: native dependencies, version, release signing from CI secrets
const gPath = path.join(app, 'build.gradle');
let g = fs.readFileSync(gPath, 'utf8');
const code = process.env.BB_VERSION_CODE || '1';
const name = process.env.BB_VERSION_NAME || '1.0.' + code;
g = g.replace(/versionCode \d+/, `versionCode ${code}`).replace(/versionName "[^"]*"/, `versionName "${name}"`);
g += `
// ---- Beti Bachao native safety modules ----
dependencies {
    implementation 'com.google.android.gms:play-services-location:21.3.0'
    implementation platform('com.google.firebase:firebase-bom:33.7.0')
    implementation 'com.google.firebase:firebase-messaging'
}
android {
    buildFeatures { buildConfig true }
    signingConfigs {
        release {
            if (System.getenv('BB_KEYSTORE_FILE')) {
                storeFile file(System.getenv('BB_KEYSTORE_FILE'))
                storePassword System.getenv('BB_KEYSTORE_PASSWORD')
                keyAlias System.getenv('BB_KEY_ALIAS')
                keyPassword System.getenv('BB_KEY_PASSWORD')
            }
        }
    }
    buildTypes {
        release {
            if (System.getenv('BB_KEYSTORE_FILE')) signingConfig signingConfigs.release
        }
    }
}
`;
fs.writeFileSync(gPath, g);

// 5) Minimum Android 8.0 (API 26): quick tile, adaptive notifications, Keystore AES
const vPath = path.join(mobile, 'android', 'variables.gradle');
let v = fs.readFileSync(vPath, 'utf8');
v = v.replace(/minSdkVersion\s*=\s*\d+/, 'minSdkVersion = 26');
fs.writeFileSync(vPath, v);

console.log(`android patched: version ${name} (${code}); ${fs.readdirSync(pkgDir).length} native files`);
