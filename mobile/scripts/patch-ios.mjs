// Runs after `npx cap add ios` (on macOS): copies the native safety modules into the
// generated Xcode project and sets permissions, background modes, Siri shortcut and icon.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const here = path.dirname(new URL(import.meta.url).pathname);
const mobile = path.resolve(here, '..');
const appDir = path.join(mobile, 'ios', 'App', 'App');
if (!fs.existsSync(appDir)) throw new Error('Run `npx cap add ios` first');
const must = (s, needle, file) => { if (!s.includes(needle)) throw new Error(`patch-ios: "${needle}" not found in ${file}`); };

// 1) Swift sources
const swift = ['BetiNativePlugin.swift', 'SendSOSIntent.swift', 'MainViewController.swift'];
for (const f of swift) fs.copyFileSync(path.join(mobile, 'native', 'ios', f), path.join(appDir, f));

// 2) Info.plist: why we need each permission (shown by iOS), background modes
const plistPath = path.join(appDir, 'Info.plist');
let plist = fs.readFileSync(plistPath, 'utf8');
const keys = {
  NSLocationWhenInUseUsageDescription: 'Beti Bachao shares your live location with verified volunteers and your trusted contacts only while an SOS is active.',
  NSLocationAlwaysAndWhenInUseUsageDescription: 'Allow "Always" so your location keeps updating during an SOS even when the phone is locked, and so on-duty volunteers can be matched to nearby SOS alerts.',
  NSLocationAlwaysUsageDescription: 'Allow "Always" so your location keeps updating during an SOS even when the phone is locked.',
  NSMicrophoneUsageDescription: 'Used for Voice SOS, voice commands, 15 seconds of SOS evidence audio and the volunteer verification video call.',
  NSCameraUsageDescription: 'Used for Blink SOS (three slow blinks — processed only on this iPhone) and the volunteer verification video call.',
  NSMotionUsageDescription: 'Used to detect a shake gesture to start an SOS.',
  NSSpeechRecognitionUsageDescription: 'Voice SOS and voice commands: say "bachao" or "help" to start an SOS, or ask for your SOS status. Speech is recognised on this iPhone.',
  NSContactsUsageDescription: 'Lets you pick trusted contacts who receive your SOS message.',
};
let add = '';
for (const [k, v] of Object.entries(keys)) if (!plist.includes(`<key>${k}</key>`)) add += `\t<key>${k}</key>\n\t<string>${v}</string>\n`;
if (!plist.includes('<key>UIBackgroundModes</key>')) add += '\t<key>UIBackgroundModes</key>\n\t<array>\n\t\t<string>location</string>\n\t\t<string>remote-notification</string>\n\t\t<string>fetch</string>\n\t</array>\n';
if (!plist.includes('<key>CFBundleDisplayName</key>')) add += '\t<key>CFBundleDisplayName</key>\n\t<string>Beti Bachao</string>\n';
const end = plist.lastIndexOf('</dict>');
if (end < 0) throw new Error('patch-ios: Info.plist has no </dict>');
plist = plist.slice(0, end) + add + plist.slice(end);
plist = plist.replace(/(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*(<\/string>)/, '$1Beti Bachao$2');
fs.writeFileSync(plistPath, plist);

// 3) Entitlements: push + time-sensitive alerts (used when the app is signed)
fs.writeFileSync(path.join(appDir, 'App.entitlements'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>aps-environment</key>
\t<string>${process.env.BB_APS_ENV || 'development'}</string>
\t<key>com.apple.developer.usernotifications.time-sensitive</key>
\t<true/>
</dict>
</plist>
`);

// 4) Storyboard: use our MainViewController (registers the BetiNative plugin)
const sbPath = path.join(appDir, 'Base.lproj', 'Main.storyboard');
let sb = fs.readFileSync(sbPath, 'utf8');
must(sb, 'customClass="CAPBridgeViewController"', 'Main.storyboard');
sb = sb.replace(/customClass="CAPBridgeViewController"\s+customModule="Capacitor"(\s+customModuleProvider="target")?/, 'customClass="MainViewController" customModule="App" customModuleProvider="target"');
fs.writeFileSync(sbPath, sb);

// 5) AppDelegate: hand APNs tokens to @capacitor/push-notifications, open from notifications
const adPath = path.join(appDir, 'AppDelegate.swift');
let ad = fs.readFileSync(adPath, 'utf8');
if (!ad.includes('didRegisterForRemoteNotificationsWithDeviceToken')) {
  const last = ad.lastIndexOf('}');
  ad = ad.slice(0, last) + `
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }
}
`;
}
fs.writeFileSync(adPath, ad);

// 6) App icon (1024×1024, resized with macOS `sips` when available)
const icon = path.join(mobile, 'native', 'ios', 'icon-1024.png'); // App Store needs 1024×1024, no transparency
const iconSet = path.join(appDir, 'Assets.xcassets', 'AppIcon.appiconset');
if (fs.existsSync(iconSet)) {
  for (const f of fs.readdirSync(iconSet).filter((x) => x.endsWith('.png'))) {
    const out = path.join(iconSet, f);
    fs.copyFileSync(icon, out);
  }
}

// 7) Xcode project: add Swift files + entitlements, iOS 16 minimum (App Intents / Siri)
execFileSync('ruby', [path.join(here, 'patch-ios-project.rb'), path.join(mobile, 'ios', 'App', 'App.xcodeproj'), ...swift], { stdio: 'inherit' });
console.log('patch-ios: done');
