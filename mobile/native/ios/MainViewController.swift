import UIKit
import Capacitor

/// Registers the app's own native plugin with Capacitor and forwards a Siri SOS
/// that arrives while the app is already open.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(BetiNativePlugin())
        NotificationCenter.default.addObserver(forName: Notification.Name("BetiBachaoSOS"), object: nil, queue: .main) { [weak self] _ in
            self?.bridge?.triggerJSEvent(eventName: "resume", target: "document")
        }
    }
}
