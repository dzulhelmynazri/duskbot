// Run by apps/mobile/ios/notification-presentation.node-test.mjs, which builds it with the app's NotificationPresentation.swift.
import Foundation
import UserNotifications

var failures = 0
func check(_ ok: Bool, _ what: String) {
    if !ok { failures += 1; print("FAIL: \(what)") }
}

let banner: UNNotificationPresentationOptions = [.banner, .sound, .list]
check(NotificationPresentation.options(threadId: "t1", viewing: "t1") == [], "the conversation on screen shows nothing")
check(NotificationPresentation.options(threadId: "t1", viewing: "t2") == banner, "another conversation shows the system banner")
check(NotificationPresentation.options(threadId: "t1", viewing: nil) == banner, "the chat list or a sheet shows the system banner")
check(NotificationPresentation.options(threadId: nil, viewing: nil) == banner, "a notification about no conversation shows the banner")
check(NotificationPresentation.options(threadId: "", viewing: "") == banner, "an empty id never matches")

let fromHost = UNMutableNotificationContent()
fromHost.threadIdentifier = "aps-thread"
fromHost.userInfo = ["madani": ["threadId": "t9", "id": "n1"]]
check(NotificationPresentation.threadId(of: fromHost) == "t9", "the bot host's own thread id comes first")
let apsOnly = UNMutableNotificationContent()
apsOnly.threadIdentifier = "t3"
check(NotificationPresentation.threadId(of: apsOnly) == "t3", "else the APNs thread-id")
check(NotificationPresentation.threadId(of: UNMutableNotificationContent()) == nil, "none at all is nil")

if failures > 0 { exit(1) }
print("ok")
