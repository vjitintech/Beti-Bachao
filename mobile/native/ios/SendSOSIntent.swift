import AppIntents
import Foundation

/// "Hey Siri, Beti Bachao SOS" — also available in the Shortcuts app, on the
/// iPhone 15 Pro+ Action Button and as a Lock Screen / Control Center shortcut.
/// Opens Beti Bachao and starts the SOS immediately (same flow as holding the button).
@available(iOS 16.0, *)
struct SendSOSIntent: AppIntent {
    static var title: LocalizedStringResource = "Send SOS"
    static var description = IntentDescription("Alert verified Beti Bachao volunteers nearby and your trusted contacts, and share your live location.")
    static var openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        UserDefaults.standard.set("siri", forKey: "bb.launchSos")
        NotificationCenter.default.post(name: Notification.Name("BetiBachaoSOS"), object: nil)
        return .result()
    }
}

@available(iOS 16.0, *)
struct BetiBachaoShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: SendSOSIntent(),
            phrases: [
                "\(.applicationName) SOS",
                "Send SOS with \(.applicationName)",
                "Help me with \(.applicationName)"
            ],
            shortTitle: "Send SOS",
            systemImageName: "sos"
        )
    }
}
