# Beti Bachao phone & tablet apps

| App | Who | Download / build |
|---|---|---|
| **Android** (phones + tablets, Android 8+) | Women & girls, volunteers | [Latest APK](https://github.com/vjitintech/Beti-Bachao/releases/download/android-latest/BetiBachao-debug.apk). Built automatically by GitHub Actions ("Android app" workflow) |
| **iPhone / iPad** (iOS 16+) | Women & girls, volunteers | Built by the "iPhone/iPad app" workflow. Simulator build: [ios-latest](https://github.com/vjitintech/Beti-Bachao/releases/tag/ios-latest). A real iPhone needs an Apple Developer account and TestFlight (see below) |
| **Web dashboard** (laptop/desktop browser) | Operators, admins | The server's address, e.g. `https://your-server/#/ops` |

**What stays on the web, and why:** the operator console and the admin console (live incident queue, radars, 112 handoff log, volunteer approvals, the Aadhaar video-call checklist, abuse reports, audit log, backups). Staff need to see a lot at once on a large screen, they log in with an authenticator app, and they work from a fixed desk, so they don't need a phone app. Women and volunteers use the phone apps. The website also still works on any phone as a fallback, for example on a borrowed phone.

## What the native apps add over the website

| Feature | Android | iPhone/iPad |
|---|---|---|
| SOS SMS to trusted contacts | **Sent automatically, no tap** (SEND_SMS), plus optional SMS to 112 (ERSS) | Opens the SMS composer pre-filled, and she taps Send. Apple doesn't allow apps to send SMS on their own. The **server SMS gateway** also sends it (if set up) |
| Location while the screen is locked | Foreground service, every 5 s during SOS, 10 s while responding, 2 min on duty | Background location updates: continuous during SOS/responding, significant-change while on duty |
| Start SOS without opening the app | Quick Settings tile, home-screen widget, power button ×5, shake ×3, lock-screen notification button | "Hey Siri, Beti Bachao SOS", Shortcuts app, Action Button (iPhone 15 Pro+), Lock Screen / Control Center shortcut |
| Volunteer SOS alerts | Loud alarm channel, full-screen over the lock screen (when allowed), via Firebase (FCM) | Time-sensitive notification (breaks through Focus), via Apple Push (APNs) |
| Voice SOS ("bachao", "help", "kapadandi") | ✅ on-device recognizer in the background service (screen locked) | While the app is open; locked → "Hey Siri, Beti Bachao SOS" |
| Blink SOS (3 slow blinks) | Blink SOS screen open | Blink SOS screen open |
| 15 s evidence audio | Recorded and uploaded automatically, also for lock-screen/power-button SOS | Recorded when the SOS starts in the app |
| Contacts by place | Picked on the phone from her saved places | Server SMS gateway |
| Screen reader / spoken status | TalkBack + text-to-speech | VoiceOver + speech |
| 5-second cancel window | Notification with CANCEL / SEND NOW | In-app countdown |
| Login token | Android Keystore (AES-GCM) | Keychain (this device only) |
| Survives reboot | Yes (boot receiver restores protection/duty) | iOS relaunches the app for location events |

No app can dial 112 by itself, on any phone. The 112 / 181 / 1091 / 108 buttons dial with a single tap.

## Install on Android (testing)

1. On the phone, open the APK link above and download it.
2. Allow "Install unknown apps" for your browser when asked, then install.
3. When the app opens, enter your server address (for example the Codespaces address from [RUN_ON_GITHUB.md](RUN_ON_GITHUB.md), or your deployed server). To build the address in so this step is skipped, set the repository variable `BB_SERVER_URL` under Settings → Secrets and variables → Actions → Variables, then re-run the "Android app" workflow.
4. Settings → **Phone permissions** → allow Location **all the time**, SMS, Notifications, and (Android 14+) **full-screen alerts**.

## Google Play release

1. Create an upload keystore once (`keytool -genkey -v -keystore release.jks -alias beti -keyalg RSA -keysize 2048 -validity 10000`). Add these repository secrets: `BB_KEYSTORE_BASE64` (`base64 -w0 release.jks`), `BB_KEYSTORE_PASSWORD`, `BB_KEY_ALIAS`, `BB_KEY_PASSWORD`. The workflow then also builds `BetiBachao-release.aab`.
2. In the Play Console fill in the **Permissions declaration**:
   - **SMS (SEND_SMS)**: choose the *"Safety / emergency alert"* use case. Explain that SOS messages go only to contacts the user chose, and only when she starts an SOS.
   - **Background location**: needed for live SOS tracking and on-duty volunteer matching. Upload a short video of the flow.
   - **Full-screen intent**: volunteer SOS alarms.
   - **Foreground service (location)**: the same reasons.
3. Data safety form: location, phone number and contacts are collected. Data is encrypted in transit and is not sold.

## iPhone / iPad release (TestFlight → App Store)

1. Join the Apple Developer Program (US$99 per year). Create the App ID `app.betibachao.safety` with the **Push Notifications** and **Time Sensitive Notifications** capabilities.
2. Create an *Apple Distribution* certificate (.p12) and an *App Store* provisioning profile for that App ID.
3. Add these repository secrets: `IOS_CERT_P12_BASE64`, `IOS_CERT_PASSWORD`, `IOS_PROFILE_BASE64`. Add the repository variable `APPLE_TEAM_ID`. The workflow then builds `BetiBachao.ipa`. Upload it with Transporter or `xcrun altool` to TestFlight.
4. Push for iPhones: in Apple Developer → Keys, create an **APNs key (.p8)**, then set these on the server: `APNS_KEY` (the .p8 text or base64), `APNS_KEY_ID`, `APNS_TEAM_ID`. Add `APNS_SANDBOX=1` for TestFlight/debug builds signed with a development profile.
5. App Review notes: explain the background location use (SOS tracking) and the Siri shortcut.

## Push alerts for Android (Firebase)

1. Go to console.firebase.google.com → Add project → Add an Android app with the package `app.betibachao.safety` → download `google-services.json`. Put its full contents in the repository secret `GOOGLE_SERVICES_JSON` and re-run the Android workflow.
2. Project settings → Service accounts → *Generate new private key*. Put that JSON (raw or base64) in the server's `FCM_SERVICE_ACCOUNT`.
3. Admin console → Integrations should now show **App push: ACTIVE**.

## Build locally (optional)

```bash
cd mobile && npm install
node scripts/prepare-www.mjs                     # BB_SERVER_URL=https://your-server to bake it in
npx cap add android && node scripts/patch-android.mjs && npx cap sync android && npx cap open android
npx cap add ios && node scripts/patch-ios.mjs && npx cap sync ios && npx cap open ios   # macOS + Xcode 16
```

The app screens are the same code as the website (`public/`). The native safety parts live in `mobile/native/android` (Java) and `mobile/native/ios` (Swift).
