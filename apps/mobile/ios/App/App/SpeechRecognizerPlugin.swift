import AVFoundation
import Capacitor
import Speech
import UIKit

/// Dictation through the phone's own recognizer (SFSpeechRecognizer), on the device where it can be. The page gets the
/// whole session's words so far ("transcript"), the input loudness ("level") and one "end"; every event carries the
/// session number the page started it with, so a late event from an earlier session is easy to drop.
@objc(SpeechRecognizerPlugin)
public class SpeechRecognizerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SpeechRecognizerPlugin"
    public let jsName = "MadaniSpeech"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finish", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise)
    ]

    private struct SessionLook {
        let category: AVAudioSession.Category
        let mode: AVAudioSession.Mode
        let options: AVAudioSession.CategoryOptions
    }

    /// The request the audio tap feeds; swapped from the main thread when a recognition task restarts.
    private final class Feed {
        private let lock = NSLock()
        private var request: SFSpeechAudioBufferRecognitionRequest?
        private var lastLevel: TimeInterval = 0
        func set(_ next: SFSpeechAudioBufferRecognitionRequest?) {
            lock.lock(); request = next; lock.unlock()
        }
        func append(_ buffer: AVAudioPCMBuffer) {
            lock.lock(); let current = request; lock.unlock()
            current?.append(buffer)
        }
        /// Audio thread only.
        func levelDue(at now: TimeInterval) -> Bool {
            guard now - lastLevel >= 0.05 else { return false }
            lastLevel = now
            return true
        }
    }

    // all state below is touched on the main thread only
    private var session = 0
    private var active = false
    private var finishing = false
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var taskNumber = 0
    private var failures = 0
    private var serverOnly = false
    private var taskStarted: TimeInterval = 0
    private var engine: AVAudioEngine?
    private var feed = Feed()
    private var look: SessionLook?
    private var transcript = SpeechTranscript()
    private var finishTimer: DispatchWorkItem?
    private var interruptionObserver: NSObjectProtocol?

    private func micState() -> String {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return "granted"
        case .denied: return "denied"
        default: return "prompt"
        }
    }

    private func speechState() -> String {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: return "granted"
        case .denied, .restricted: return "denied"
        default: return "prompt"
        }
    }

    @objc override public func checkPermissions(_ call: CAPPluginCall) {
        call.resolve(["microphone": micState(), "speech": speechState()])
    }

    @objc override public func requestPermissions(_ call: CAPPluginCall) {
        SFSpeechRecognizer.requestAuthorization { [weak self] _ in
            AVAudioApplication.requestRecordPermission { _ in
                DispatchQueue.main.async {
                    call.resolve(["microphone": self?.micState() ?? "denied", "speech": self?.speechState() ?? "denied"])
                }
            }
        }
    }

    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString) else {
                call.reject("settings unavailable")
                return
            }
            UIApplication.shared.open(url) { _ in call.resolve() }
        }
    }

    /// The recognizer for the page's language. SFSpeechRecognizer takes only the locales it lists (es-ES, es-MX, never
    /// bare "es"), so a language without its region listens in the phone's own region for it, else the language's main one.
    static func recognizer(for identifier: String?) -> SFSpeechRecognizer? {
        guard let identifier, !identifier.isEmpty else { return SFSpeechRecognizer() }
        let tag = { (locale: Locale) in locale.identifier.replacingOccurrences(of: "_", with: "-").lowercased() }
        let wanted = Locale(identifier: identifier)
        let supported = SFSpeechRecognizer.supportedLocales()
        if let exact = supported.first(where: { tag($0) == tag(wanted) }) { return SFSpeechRecognizer(locale: exact) }
        guard let language = wanted.language.languageCode?.identifier else { return nil }
        let same = supported.filter { $0.language.languageCode?.identifier == language }.sorted { tag($0) < tag($1) }
        let home = Locale(identifier: wanted.language.maximalIdentifier).region?.identifier
        let pick = same.first { $0.region?.identifier == wanted.region?.identifier && wanted.region != nil }
            ?? same.first { $0.region?.identifier == Locale.current.region?.identifier }
            ?? same.first { $0.region?.identifier == home }
            ?? same.first
        return pick.flatMap { SFSpeechRecognizer(locale: $0) }
    }

    @objc func start(_ call: CAPPluginCall) {
        let locale = call.getString("locale")
        let number = call.getInt("session") ?? 0
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.teardown()
            self.session = number
            guard self.micState() == "granted", self.speechState() == "granted" else {
                call.reject("the microphone or speech recognition is not allowed", "microphone-blocked")
                return
            }
            let found = Self.recognizer(for: locale)
            guard let recognizer = found else {
                call.reject("speech recognition does not support this language", "unsupported-locale")
                return
            }
            guard recognizer.isAvailable else {
                call.reject("speech recognition is not available right now", "recognizer-unavailable")
                return
            }
            self.recognizer = recognizer
            do {
                try self.openAudio()
            } catch let failure as StartFailure {
                self.teardown()
                call.reject(failure.message, failure.code)
                return
            } catch {
                self.teardown()
                call.reject("the microphone could not be started", "microphone-failed")
                return
            }
            self.active = true
            call.resolve()
        }
    }

    @objc func finish(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.beginFinish()
            call.resolve()
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.teardown()
            call.resolve()
        }
    }

    private struct StartFailure: Error {
        let code: String
        let message: String
    }

    private func openAudio() throws {
        let audio = AVAudioSession.sharedInstance()
        look = SessionLook(category: audio.category, mode: audio.mode, options: audio.categoryOptions)
        try audio.setCategory(.record, mode: .measurement, options: .duckOthers)
        try audio.setActive(true, options: .notifyOthersOnDeactivation)

        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw StartFailure(code: "microphone-missing", message: "no microphone is available")
        }
        transcript = SpeechTranscript()
        failures = 0
        beginTask()
        let feed = self.feed
        let number = session
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            feed.append(buffer)
            guard feed.levelDue(at: ProcessInfo.processInfo.systemUptime) else { return }
            let level = SpeechRecognizerPlugin.levelOf(buffer)
            DispatchQueue.main.async {
                guard let self, self.active, !self.finishing, self.session == number else { return }
                self.notifyListeners("level", data: ["level": level, "session": number])
                NotificationCenter.default.post(name: .madaniSpeechLevel, object: nil, userInfo: ["level": level])
            }
        }
        engine.prepare()
        try engine.start()
        self.engine = engine
        interruptionObserver = NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: audio, queue: .main) { [weak self] note in
            let kind = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init(rawValue:))
            // a call or Siri took the microphone: keep the words heard so far
            if kind == .began { self?.beginFinish() }
        }
    }

    /// Root mean square of the first channel, lifted by a square root like the page's levelOf so a soft voice still shows.
    private static func levelOf(_ buffer: AVAudioPCMBuffer) -> Double {
        guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
        let count = Int(buffer.frameLength)
        var sum: Float = 0
        for index in 0..<count { sum += samples[index] * samples[index] }
        let rms = (sum / Float(count)).squareRoot()
        return Double(min(1, (rms * 6).squareRoot()))
    }

    private func beginTask() {
        guard let recognizer else { return }
        task?.cancel()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        request.addsPunctuation = true
        if recognizer.supportsOnDeviceRecognition && !serverOnly { request.requiresOnDeviceRecognition = true }
        self.request = request
        feed.set(request)
        transcript.newTask()
        taskNumber += 1
        taskStarted = ProcessInfo.processInfo.systemUptime
        let number = taskNumber
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            DispatchQueue.main.async { self?.handle(result: result, error: error, task: number) }
        }
    }

    private func handle(result: SFSpeechRecognitionResult?, error: Error?, task number: Int) {
        guard active, number == taskNumber else { return }
        if let result {
            failures = 0
            let metadata = result.speechRecognitionMetadata
            let text = transcript.feed(
                result.bestTranscription.formattedString,
                partial: !result.isFinal,
                utteranceFinal: result.isFinal || metadata != nil,
                speechStart: metadata?.speechStartTimestamp
            )
            notifyListeners("transcript", data: ["text": text, "partial": true, "session": session])
            if result.isFinal {
                if finishing { complete() } else { beginTask() }
            }
            return
        }
        guard error != nil else { return }
        if finishing { return complete() }
        // the recognizer ends a task on a long quiet spell or its own time limit; keep dictating with a fresh one, unless
        // tasks keep failing the moment they start
        let quick = ProcessInfo.processInfo.systemUptime - taskStarted < 2
        // the on-device model can be listed and still not be ready (its download unfinished): Apple's servers listen instead
        if quick, request?.requiresOnDeviceRecognition == true { serverOnly = true }
        failures = quick ? failures + 1 : 0
        if failures >= 3 { return end(code: 1, reason: "recognition-error") }
        beginTask()
    }

    private func beginFinish() {
        guard active, !finishing else { return }
        finishing = true
        stopAudio()
        request?.endAudio()
        let timer = DispatchWorkItem { [weak self] in self?.complete() }
        finishTimer = timer
        DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: timer)
    }

    private func complete() {
        guard active else { return }
        let text = transcript.text
        if !text.isEmpty { notifyListeners("transcript", data: ["text": text, "partial": false, "session": session]) }
        end(code: 0, reason: "completed")
    }

    private func end(code: Int, reason: String) {
        let number = session
        let wasActive = active
        teardown()
        if wasActive { notifyListeners("end", data: ["code": code, "reason": reason, "session": number]) }
    }

    private func stopAudio() {
        feed.set(nil)
        if let engine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        engine = nil
        if let observer = interruptionObserver { NotificationCenter.default.removeObserver(observer) }
        interruptionObserver = nil
        guard let look else { return }
        self.look = nil
        let audio = AVAudioSession.sharedInstance()
        try? audio.setActive(false, options: .notifyOthersOnDeactivation)
        try? audio.setCategory(look.category, mode: look.mode, options: look.options)
    }

    private func teardown() {
        finishTimer?.cancel()
        finishTimer = nil
        active = false
        finishing = false
        taskNumber += 1
        task?.cancel()
        task = nil
        request = nil
        recognizer = nil
        stopAudio()
    }
}

/// The session's words across utterances and recognition tasks. Apple's recognizer can report a finished utterance
/// (metadata, sometimes without isFinal) and then start the next one from an empty transcript; this keeps what came
/// before. Same rules as electron/speech-transcript.mjs.
struct SpeechTranscript {
    private var committed = ""
    private var current = ""
    private var boundary = false
    private var boundaryText = ""
    private var finalStart: Double?

    static func join(_ left: String, _ right: String) -> String {
        !left.isEmpty && !right.isEmpty ? "\(left) \(right)" : left.isEmpty ? right : left
    }

    var text: String { Self.join(committed, current) }

    /// A new recognition task hears from nothing, so everything so far is kept.
    mutating func newTask() {
        committed = text
        current = ""
        boundary = false
        boundaryText = ""
        finalStart = nil
    }

    mutating func feed(_ raw: String, partial: Bool, utteranceFinal: Bool, speechStart: Double?) -> String {
        var next = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if next.isEmpty { return text }
        let start = utteranceFinal ? speechStart : nil
        let newUtterance = start != nil && finalStart != nil && start! > finalStart! + 0.01
        if !newUtterance, !committed.isEmpty, next.hasPrefix(committed) {
            next = String(next.dropFirst(committed.count)).trimmingCharacters(in: .whitespaces)
        }
        if next.isEmpty { return text }
        if boundary {
            let sameFinalAudio = start != nil && start == finalStart && (next.hasPrefix(boundaryText) || boundaryText.hasPrefix(next))
            if !newUtterance && (next == boundaryText || sameFinalAudio) {
                current = next
                boundaryText = next
                return text
            }
            if newUtterance || !next.hasPrefix(boundaryText) {
                committed = Self.join(committed, boundaryText)
                boundary = false
            }
        }
        current = next
        if utteranceFinal || !partial {
            boundary = true
            boundaryText = current
        }
        if start != nil { finalStart = start }
        return text
    }
}

extension Notification.Name {
    /// the microphone's loudness while dictation listens, 0 to about 1, for native views that draw it
    static let madaniSpeechLevel = Notification.Name("MadaniSpeechLevel")
}
