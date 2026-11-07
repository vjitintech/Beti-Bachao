import Foundation
import Capacitor
import CoreLocation
import MessageUI
import Security
import UIKit
import UserNotifications

/// JavaScript bridge "BetiNative" for iPhone/iPad (see public/js/native.js).
/// iOS never lets apps send SMS or place calls by themselves, so sendSos opens
/// the SMS composer pre-filled; the server SMS gateway covers the rest.
@objc(BetiNativePlugin)
public class BetiNativePlugin: CAPPlugin, CAPBridgedPlugin, MFMessageComposeViewControllerDelegate {
    public let identifier = "BetiNativePlugin"
    public let jsName = "BetiNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "secureGet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secureSet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sendSos", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startSafety", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopSafety", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "permissionStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "takeLaunchAction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSystemSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "canUseFullScreenAlerts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPushToken", returnType: CAPPluginReturnPromise),
    ]
    private var smsCall: CAPPluginCall?

    @objc func secureGet(_ call: CAPPluginCall) {
        call.resolve(["value": Keychain.get(call.getString("key") ?? "") as Any])
    }

    @objc func secureSet(_ call: CAPPluginCall) {
        Keychain.set(call.getString("key") ?? "", call.getString("value"))
        call.resolve()
    }

    @objc func configure(_ call: CAPPluginCall) {
        let d = UserDefaults.standard
        if let s = call.getString("serverUrl") { d.set(s, forKey: "bb.serverUrl") }
        if call.options.keys.contains("token") { Keychain.set("token", call.getString("token")) }
        if let c = call.getArray("contacts") { d.set(c, forKey: "bb.contacts") }
        for k in ["sms112", "autoSms", "armed"] { if let b = call.getBool(k) { d.set(b, forKey: "bb.\(k)") } }
        if call.options.keys.contains("token") && call.getString("token") == nil { SafetyLocation.shared.stop() }
        call.resolve()
    }

    @objc func sendSos(_ call: CAPPluginCall) {
        var numbers = (call.getArray("numbers") as? [String]) ?? []
        if call.getBool("sms112") == true { numbers.append("112") }
        let message = call.getString("message") ?? "SOS! I need help. — Beti Bachao"
        DispatchQueue.main.async {
            guard MFMessageComposeViewController.canSendText(), !numbers.isEmpty, let vc = self.bridge?.viewController else {
                call.resolve(["sent": 0, "composer": false]); return
            }
            let m = MFMessageComposeViewController()
            m.recipients = numbers
            m.body = message
            m.messageComposeDelegate = self
            self.smsCall = call
            vc.present(m, animated: true)
            // Resolve immediately so the SOS is created on the server at once; the composer stays open.
            call.resolve(["sent": 0, "composer": true])
        }
    }

    public func messageComposeViewController(_ controller: MFMessageComposeViewController, didFinishWith result: MessageComposeResult) {
        controller.dismiss(animated: true)
        smsCall = nil
    }

    @objc func startSafety(_ call: CAPPluginCall) {
        let mode = call.getString("mode") ?? "armed"
        DispatchQueue.main.async { SafetyLocation.shared.start(mode: mode) }
        call.resolve()
    }

    @objc func stopSafety(_ call: CAPPluginCall) {
        DispatchQueue.main.async { SafetyLocation.shared.stop() }
        call.resolve()
    }

    @objc override public func requestPermissions(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            SafetyLocation.shared.requestAlways()
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in
                DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
                self.permissionStatus(call)
            }
        }
    }

    @objc func permissionStatus(_ call: CAPPluginCall) {
        let loc: String
        switch SafetyLocation.shared.manager.authorizationStatus {
        case .authorizedAlways: loc = "always"
        case .authorizedWhenInUse: loc = "while using the app"
        case .denied, .restricted: loc = "denied"
        default: loc = "not asked"
        }
        UNUserNotificationCenter.current().getNotificationSettings { s in
            call.resolve(["location": loc, "notifications": s.authorizationStatus == .authorized ? "granted" : "not granted", "sms": MFMessageComposeViewController.canSendText() ? "composer (one tap)" : "unavailable"])
        }
    }

    /// Set by the Siri / Shortcuts / Action Button "Send SOS" intent.
    @objc func takeLaunchAction(_ call: CAPPluginCall) {
        let d = UserDefaults.standard
        if let trig = d.string(forKey: "bb.launchSos") {
            d.removeObject(forKey: "bb.launchSos")
            call.resolve(["action": "sos", "trigger": trig]); return
        }
        if let url = d.string(forKey: "bb.launchUrl") {
            d.removeObject(forKey: "bb.launchUrl")
            call.resolve(["url": url]); return
        }
        call.resolve([:])
    }

    @objc func openSystemSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let u = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(u) }
            call.resolve()
        }
    }

    @objc func canUseFullScreenAlerts(_ call: CAPPluginCall) { call.resolve(["allowed": true]) }

    /// iOS push tokens come from @capacitor/push-notifications (APNs); see native.js.
    @objc func getPushToken(_ call: CAPPluginCall) { call.resolve(["token": NSNull(), "reason": "use-push-notifications-plugin"]) }
}

/// Background location for SOS / responding / on-duty, posted straight to the server.
final class SafetyLocation: NSObject, CLLocationManagerDelegate {
    static let shared = SafetyLocation()
    let manager = CLLocationManager()
    private var mode = "armed"
    private var lastPost = Date.distantPast

    override init() {
        super.init()
        manager.delegate = self
        manager.pausesLocationUpdatesAutomatically = false
        manager.activityType = .otherNavigation
    }

    func requestAlways() {
        if manager.authorizationStatus == .notDetermined { manager.requestWhenInUseAuthorization() }
        else if manager.authorizationStatus == .authorizedWhenInUse { manager.requestAlwaysAuthorization() }
    }

    func start(mode: String) {
        self.mode = mode
        requestAlways()
        if mode == "armed" { stop(); return } // location is read only when an SOS starts
        manager.allowsBackgroundLocationUpdates = true
        manager.showsBackgroundLocationIndicator = true
        if mode == "duty" {
            manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
            manager.stopUpdatingLocation()
            manager.startMonitoringSignificantLocationChanges()
        } else {
            manager.desiredAccuracy = kCLLocationAccuracyBest
            manager.distanceFilter = 5
            manager.startUpdatingLocation()
        }
    }

    func stop() {
        manager.stopUpdatingLocation()
        manager.stopMonitoringSignificantLocationChanges()
        manager.allowsBackgroundLocationUpdates = false
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let l = locations.last else { return }
        let minGap: TimeInterval = mode == "sos" ? 5 : mode == "assigned" ? 10 : 110
        if Date().timeIntervalSince(lastPost) < minGap { return }
        lastPost = Date()
        var body: [String: Any] = ["lat": l.coordinate.latitude, "lng": l.coordinate.longitude, "accuracyM": Int(l.horizontalAccuracy.rounded()),
                                   "source": l.horizontalAccuracy <= 100 ? "gps" : "network", "observedAt": ISO8601DateFormatter().string(from: l.timestamp)]
        if l.verticalAccuracy >= 0 { body["altitudeM"] = l.altitude; body["verticalAccuracyM"] = l.verticalAccuracy }
        NativeApi.post("/me/location", body)
    }
}

enum NativeApi {
    static func post(_ path: String, _ body: [String: Any]) {
        guard let server = UserDefaults.standard.string(forKey: "bb.serverUrl"), !server.isEmpty,
              let token = Keychain.get("token"), let url = URL(string: server + "/api/v1" + path),
              let data = try? JSONSerialization.data(withJSONObject: body) else { return }
        var r = URLRequest(url: url)
        r.httpMethod = "POST"
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        r.setValue("1", forHTTPHeaderField: "X-BB-CSRF")
        r.httpBody = data
        r.timeoutInterval = 15
        URLSession.shared.dataTask(with: r).resume()
    }
}

/// Keychain storage for the login token (device-only, available after first unlock
/// so background location updates can still authenticate).
enum Keychain {
    static func set(_ key: String, _ value: String?) {
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "app.betibachao.safety", kSecAttrAccount as String: key]
        SecItemDelete(base as CFDictionary)
        guard let v = value, !v.isEmpty, let data = v.data(using: .utf8) else { return }
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }
    static func get(_ key: String) -> String? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "app.betibachao.safety", kSecAttrAccount as String: key, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }
}
