import ActivityKit
import Capacitor
import UIKit
import UserNotifications

/// Starts, updates and ends a bot turn's Live Activity, hands the page each activity's push token (and the push-to-start
/// one) to register with the bot host, and passes on what a Live Activity button asked for.
@objc(TurnActivityPlugin)
public class TurnActivityPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TurnActivityPlugin"
    public let jsName = "MadaniTurnActivity"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "end", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "lineKey", returnType: CAPPluginReturnPromise),
    ]

    /// how long a finished activity stays on the lock screen
    private static let dismissAfter: TimeInterval = 20
    private var watched = Set<String>()
    private var tasks: [Task<Void, Never>] = []

    override public func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(flushActions), name: PhoneActionInbox.posted, object: nil)
        flushActions()
        for activity in Activity<MadaniTurnAttributes>.activities { watch(activity) }
        tasks.append(Task { [weak self] in
            for await activity in Activity<MadaniTurnAttributes>.activityUpdates { self?.watch(activity) }
        })
        if #available(iOS 17.2, *) {
            tasks.append(Task { [weak self] in
                for await token in Activity<MadaniTurnAttributes>.pushToStartTokenUpdates {
                    self?.notifyListeners("startToken", data: ["token": Self.hex(token)], retainUntilConsumed: true)
                }
            })
        }
    }

    deinit {
        for task in tasks { task.cancel() }
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func flushActions() {
        for action in PhoneActionInbox.take() { notifyListeners("action", data: action, retainUntilConsumed: true) }
    }

    private func watch(_ activity: Activity<MadaniTurnAttributes>) {
        guard !watched.contains(activity.id) else { return }
        watched.insert(activity.id)
        tasks.append(Task { [weak self] in
            for await token in activity.pushTokenUpdates {
                self?.notifyListeners("token", data: [
                    "id": activity.id, "threadId": activity.attributes.threadId, "token": Self.hex(token),
                    "startedAt": activity.content.state.startedAt,
                ], retainUntilConsumed: true)
            }
        })
    }

    private static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

    private func decode<T: Decodable>(_ type: T.Type, _ value: JSObject?) -> T? {
        guard let value, let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    private func activity(_ id: String?) -> Activity<MadaniTurnAttributes>? {
        Activity<MadaniTurnAttributes>.activities.first { $0.id == id }
    }

    /// the line under "Done" is shown only where the person lets notifications show their text
    private func withPreviewSetting(_ state: MadaniTurnAttributes.ContentState) async -> MadaniTurnAttributes.ContentState {
        guard state.line != nil else { return state }
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        var shown = state
        if settings.showPreviewsSetting == .never { shown.line = nil }
        return shown
    }

    @objc func start(_ call: CAPPluginCall) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { call.resolve([:]); return }
        guard let attributes = decode(MadaniTurnAttributes.self, call.getObject("attributes")),
              let state = decode(MadaniTurnAttributes.ContentState.self, call.getObject("state")) else {
            call.reject("attributes and state are required", "invalid")
            return
        }
        do {
            let activity = try Activity.request(attributes: attributes, content: ActivityContent(state: state, staleDate: nil), pushType: .token)
            watch(activity)
            call.resolve(["id": activity.id])
        } catch {
            call.resolve([:])
        }
    }

    @objc func update(_ call: CAPPluginCall) {
        guard let activity = activity(call.getString("id")), let state = decode(MadaniTurnAttributes.ContentState.self, call.getObject("state")) else { call.resolve(); return }
        Task {
            await activity.update(ActivityContent(state: state, staleDate: nil))
            call.resolve()
        }
    }

    @objc func end(_ call: CAPPluginCall) {
        guard let activity = activity(call.getString("id")), let state = decode(MadaniTurnAttributes.ContentState.self, call.getObject("state")) else { call.resolve(); return }
        let now = call.getBool("now") ?? false
        Task {
            let shown = await withPreviewSetting(state)
            await activity.end(ActivityContent(state: shown, staleDate: nil), dismissalPolicy: now ? .immediate : .after(Date().addingTimeInterval(Self.dismissAfter)))
            call.resolve()
        }
    }

    @objc func list(_ call: CAPPluginCall) {
        let activities = Activity<MadaniTurnAttributes>.activities.filter { $0.activityState == .active || $0.activityState == .stale }.map { activity -> JSObject in
            ["id": activity.id, "botId": activity.attributes.botId, "threadId": activity.attributes.threadId, "startedAt": activity.content.state.startedAt]
        }
        call.resolve(["activities": activities])
    }

    @objc func lineKey(_ call: CAPPluginCall) {
        Task {
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            if settings.showPreviewsSetting == .never { call.resolve([:]); return }
            if let key = TurnLineKey.publicKey() { call.resolve(["key": key]) } else { call.resolve([:]) }
        }
    }
}
