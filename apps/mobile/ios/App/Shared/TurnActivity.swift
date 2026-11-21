import ActivityKit
import AppIntents
import CryptoKit
import Foundation
import Security

/// A bot's turn on the lock screen and in the Dynamic Island. The bot host pushes the same JSON (content-state,
/// attributes), so a field here is a field there.
struct MadaniTurnAttributes: ActivityAttributes {
    struct Ask: Codable, Hashable {
        /// "approve" or "answer"
        var kind: String
        var requestId: String
    }

    struct ContentState: Codable, Hashable {
        /// "working", "needs-you", "done" or "stopped"
        var phase: String
        /// what the running step does: write, edit, command, web, read, fetch, search, tool; nil while thinking
        var step: String?
        var steps: Int
        /// epoch seconds: a pushed Date would be read from 2001
        var startedAt: Double
        var ask: Ask?
        /// the reply's first line, sealed to this phone's line key
        var sealed: String?
        /// the reply's first line, set by the app itself
        var line: String?
    }

    var botId: String
    var botName: String
    var threadId: String
    var groupId: String?
    var color: String
    var body: String
}

extension MadaniTurnAttributes.ContentState {
    var started: Date { Date(timeIntervalSince1970: startedAt) }
    var ended: Bool { phase == "done" || phase == "stopped" }

    /// the line under "Done": the app's own, else the sealed one opened with this phone's key
    var doneLine: String? {
        if let line, !line.isEmpty { return line }
        guard let sealed else { return nil }
        return TurnLineKey.open(sealed)
    }
}

/// The X25519 key a done reply's first line is sealed to. It lives in the keychain group the app and its Live Activity
/// share, readable after the first unlock so a locked phone can show the line.
enum TurnLineKey {
    private static let service = "bot.madani.turn-line"
    private static let account = "line-key"
    private static var group: String? { Bundle.main.object(forInfoDictionaryKey: "MadaniKeychainGroup") as? String }

    private static func query() -> [String: Any] {
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        if let group, !group.hasPrefix("$(") { query[kSecAttrAccessGroup as String] = group }
        return query
    }

    static func stored() -> Curve25519.KeyAgreement.PrivateKey? {
        var item = query()
        item[kSecReturnData as String] = true
        item[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(item as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: data)
    }

    static func storedOrNew() -> Curve25519.KeyAgreement.PrivateKey? {
        if let key = stored() { return key }
        let key = Curve25519.KeyAgreement.PrivateKey()
        var item = query()
        item[kSecValueData as String] = key.rawRepresentation
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess ? key : nil
    }

    static func publicKey() -> String? {
        storedOrNew().map { base64url($0.publicKey.rawRepresentation) }
    }

    /// ephemeral public key (32) | nonce (12) | ciphertext | tag (16), base64url
    static func open(_ sealed: String) -> String? {
        guard let key = stored(), let raw = unbase64url(sealed), raw.count > 60 else { return nil }
        do {
            let ephemeral = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: raw.prefix(32))
            let shared = try key.sharedSecretFromKeyAgreement(with: ephemeral)
            let symmetric = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: Data("madani-turn-line-v1".utf8), sharedInfo: Data("seal".utf8), outputByteCount: 32)
            let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: raw.subdata(in: 32..<44)), ciphertext: raw.subdata(in: 44..<(raw.count - 16)), tag: raw.suffix(16))
            return String(data: try AES.GCM.open(box, using: symmetric), encoding: .utf8)
        } catch {
            return nil
        }
    }

    private static func base64url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    private static func unbase64url(_ text: String) -> Data? {
        var value = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while value.count % 4 != 0 { value += "=" }
        return Data(base64Encoded: value)
    }
}

/// What a Live Activity button asked the app to do, kept until the page takes it: the button opens the app, and the page
/// may not be listening yet.
enum PhoneActionInbox {
    static let posted = Notification.Name("MadaniPhoneActionPosted")
    private static let key = "madani.phoneActions"

    static func post(_ action: [String: Any]) {
        var list = UserDefaults.standard.array(forKey: key) ?? []
        list.append(action)
        UserDefaults.standard.set(Array(list.suffix(8)), forKey: key)
        NotificationCenter.default.post(name: posted, object: nil)
    }

    static func take() -> [[String: Any]] {
        let list = UserDefaults.standard.array(forKey: key) as? [[String: Any]] ?? []
        UserDefaults.standard.removeObject(forKey: key)
        return list
    }
}

/// The Live Activity's close button: that thread's activity leaves the Lock Screen, the Dynamic Island and a paired Mac's
/// menu bar now, without opening the app.
struct CloseTurnActivityIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Close"
    static var isDiscoverable = false

    @Parameter(title: "Conversation") var threadId: String

    init() {}

    init(threadId: String) {
        self.threadId = threadId
    }

    func perform() async throws -> some IntentResult {
        for activity in Activity<MadaniTurnAttributes>.activities where activity.attributes.threadId == threadId {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
        return .result()
    }
}

/// Approve on the Live Activity. Runs in the app (a LiveActivityIntent does), after Face ID, and opens the chat.
struct ApproveAskIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Approve"
    static var isDiscoverable = false
    static var openAppWhenRun = true
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Ask") var requestId: String
    @Parameter(title: "Conversation") var threadId: String
    @Parameter(title: "Bot") var botId: String
    @Parameter(title: "Room") var groupId: String

    init() {}

    init(requestId: String, threadId: String, botId: String, groupId: String?) {
        self.requestId = requestId
        self.threadId = threadId
        self.botId = botId
        self.groupId = groupId ?? ""
    }

    func perform() async throws -> some IntentResult {
        var data: [String: Any] = ["requestId": requestId, "threadId": threadId, "botId": botId]
        if !groupId.isEmpty { data["groupId"] = groupId }
        PhoneActionInbox.post(["actionId": "madani.approve", "data": data])
        return .result()
    }
}
