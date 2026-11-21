import Capacitor
import UIKit

/// The phone's haptics with one generator per kind, made once and kept prepared, so a tap's feedback lands with the
/// touch instead of a bridge round trip later. One call per haptic.
@objc(MadaniHapticsPlugin)
public class MadaniHapticsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MadaniHapticsPlugin"
    public let jsName = "MadaniHaptics"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnNone),
        CAPPluginMethod(name: "prepare", returnType: CAPPluginReturnNone),
    ]

    private lazy var light = UIImpactFeedbackGenerator(style: .light)
    private lazy var soft = UIImpactFeedbackGenerator(style: .soft)
    private lazy var medium = UIImpactFeedbackGenerator(style: .medium)
    private lazy var selection = UISelectionFeedbackGenerator()
    private lazy var notice = UINotificationFeedbackGenerator()

    @objc func prepare(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [self] in
            light.prepare(); soft.prepare(); medium.prepare(); selection.prepare()
        }
    }

    @objc func play(_ call: CAPPluginCall) {
        let kind = call.getString("kind") ?? "light"
        DispatchQueue.main.async { [self] in
            switch kind {
            case "soft": soft.impactOccurred(intensity: 0.6); soft.prepare()
            case "medium": medium.impactOccurred(); medium.prepare()
            case "selection": selection.selectionChanged(); selection.prepare()
            case "success": notice.notificationOccurred(.success)
            case "error": notice.notificationOccurred(.warning)
            default: light.impactOccurred(intensity: 0.7); light.prepare()
            }
        }
    }
}
