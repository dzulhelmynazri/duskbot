import Foundation
import UserNotifications

/// What a notification shows while the app is open: the system's own banner, sound and list entry, except for the
/// conversation on screen, which shows nothing.
enum NotificationPresentation {
    static func options(threadId: String?, viewing: String?) -> UNNotificationPresentationOptions {
        if let threadId, !threadId.isEmpty, threadId == viewing { return [] }
        return [.banner, .sound, .list]
    }

    /// The conversation a notification is about: the bot host's `madani.threadId`, else the APNs `thread-id`.
    static func threadId(of content: UNNotificationContent) -> String? {
        if let madani = content.userInfo["madani"] as? [AnyHashable: Any], let thread = madani["threadId"] as? String, !thread.isEmpty {
            return thread
        }
        return content.threadIdentifier.isEmpty ? nil : content.threadIdentifier
    }
}
