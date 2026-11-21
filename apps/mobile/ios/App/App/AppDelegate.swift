import UIKit
import Capacitor
import UserNotifications

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        registerNotificationActions()
        return true
    }

    /// The buttons a push from the bot host offers, by its category. Each opens the app, which does what was pressed:
    /// talking to the bot host needs the page's own connection. Approve and Deny ask for Face ID first.
    private func registerNotificationActions() {
        let approve = UNNotificationAction(identifier: "madani.approve", title: "Approve", options: [.authenticationRequired, .foreground])
        let deny = UNNotificationAction(identifier: "madani.deny", title: "Deny", options: [.authenticationRequired, .destructive, .foreground])
        let answer = UNNotificationAction(identifier: "madani.answer", title: "Answer", options: [.foreground])
        let reply = UNTextInputNotificationAction(identifier: "madani.reply", title: "Reply", options: [.authenticationRequired, .foreground], textInputButtonTitle: "Send", textInputPlaceholder: "Message")
        UNUserNotificationCenter.current().setNotificationCategories([
            UNNotificationCategory(identifier: "madani.approval", actions: [approve, deny], intentIdentifiers: []),
            UNNotificationCategory(identifier: "madani.question", actions: [answer], intentIdentifiers: []),
            UNNotificationCategory(identifier: "madani.message", actions: [reply], intentIdentifiers: []),
        ])
    }

    // the push plugin hears the device token only through these
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
