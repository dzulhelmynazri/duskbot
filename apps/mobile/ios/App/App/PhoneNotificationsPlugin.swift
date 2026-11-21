import Capacitor
import UserNotifications

/// Sits in front of Capacitor's notification delegate (its NotificationRouter, set when the bridge starts) so a push
/// that lands while the app is open shows as the system's banner, or not at all for the conversation on screen. Taps
/// and button presses go on to Capacitor's push plugin unchanged.
final class ForegroundNotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    static let shared = ForegroundNotificationDelegate()
    /// the conversation the page shows, main thread only
    var viewing: String?
    private var next: UNUserNotificationCenterDelegate?

    func install() {
        let center = UNUserNotificationCenter.current()
        guard center.delegate !== self else { return }
        next = center.delegate
        center.delegate = self
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let shown = NotificationPresentation.options(threadId: NotificationPresentation.threadId(of: notification.request.content), viewing: viewing)
        guard let next, next.responds(to: #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:willPresent:withCompletionHandler:))) else {
            return completionHandler(shown)
        }
        next.userNotificationCenter?(center, willPresent: notification) { _ in completionHandler(shown) }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        guard let next, next.responds(to: #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:didReceive:withCompletionHandler:))) else {
            return completionHandler()
        }
        next.userNotificationCenter?(center, didReceive: response, withCompletionHandler: completionHandler)
    }
}

@objc(PhoneNotificationsPlugin)
public class PhoneNotificationsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PhoneNotificationsPlugin"
    public let jsName = "MadaniNotifications"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setViewing", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "delivered", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
    ]

    override public func load() {
        DispatchQueue.main.async { ForegroundNotificationDelegate.shared.install() }
    }

    @objc func setViewing(_ call: CAPPluginCall) {
        let thread = call.getString("threadId")
        DispatchQueue.main.async {
            ForegroundNotificationDelegate.shared.viewing = thread?.isEmpty == false ? thread : nil
            call.resolve()
        }
    }

    /// What Notification Center holds from the bot host: its identifier, conversation and notification id.
    @objc func delivered(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().getDeliveredNotifications { notifications in
            let list: [JSObject] = notifications.map { one in
                var entry: JSObject = ["id": one.request.identifier]
                if let thread = NotificationPresentation.threadId(of: one.request.content) { entry["threadId"] = thread }
                if let madani = one.request.content.userInfo["madani"] as? [AnyHashable: Any], let id = madani["id"] as? String { entry["notificationId"] = id }
                return entry
            }
            call.resolve(["notifications": list])
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        let ids = (call.getArray("ids") ?? []).compactMap { $0 as? String }
        if !ids.isEmpty { UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ids) }
        call.resolve()
    }
}
