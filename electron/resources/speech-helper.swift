// Native macOS speech-to-text helper. Streams NDJSON lines to stdout:
//   {"partial":true,"text":"…"}   while recognizing
//   {"partial":false,"text":"…"}  final result, then exit 0
//   {"error":"…"}                 then exit 1
//   {"level":0.42}                input loudness 0…1, about 20 times a second
// Runs until the final result or a per-session stop marker. Launched by
// electron/speech.mjs as this background app bundle so macOS can resolve the
// microphone and speech purpose strings in its Info.plist.
//
// `--endpoint-ms N` ends the audio stream after N milliseconds without a
// transcript change. SFSpeechRecognizer does not finalize a buffer-backed
// request on silence by itself; it only produces `isFinal` after endAudio().
// Composer dictation omits this flag and keeps its existing press-to-stop
// behavior, while call mode opts into silence endpointing.
//
// `--locale en-US` listens in that language first; unset follows the person's
// preferred languages.
//
// `--finish-on-release control,option` finishes recognition once any of the
// listed modifiers (control, option, shift, command) is no longer held.
import AVFoundation
import CoreGraphics
import Foundation
import Speech

// The audio tap and the recognizer call back on different threads: one line at a time.
let emitQueue = DispatchQueue(label: "bot.madani.speech.emit")
func emit(_ obj: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: obj),
    let line = String(data: data, encoding: .utf8)
  {
    emitQueue.sync {
      print(line)
      fflush(stdout)
    }
  }
}

func fail(_ message: String) -> Never {
  emit(["error": message])
  exit(1)
}

let endpointMs: Int = {
  let args = CommandLine.arguments
  guard
    let index = args.firstIndex(of: "--endpoint-ms"),
    index + 1 < args.count,
    let value = Int(args[index + 1])
  else { return 0 }
  return min(5_000, max(250, value))
}()

let localeArg: String? = {
  let args = CommandLine.arguments
  guard let index = args.firstIndex(of: "--locale"), index + 1 < args.count else { return nil }
  let value = args[index + 1]
  return value.isEmpty ? nil : value
}()

/// Loudness for the composer's waveform: rms lifted by a square root so a soft
/// voice still moves it. Matches levelOf in src/lib/voice-input/bridge.ts.
var lastLevelAt = DispatchTime(uptimeNanoseconds: 0)
func emitLevel(_ buffer: AVAudioPCMBuffer) {
  guard let channel = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
  let now = DispatchTime.now()
  guard now.uptimeNanoseconds - lastLevelAt.uptimeNanoseconds >= 45_000_000 else { return }
  lastLevelAt = now
  var sum: Float = 0
  for i in 0..<Int(buffer.frameLength) { sum += channel[i] * channel[i] }
  let rms = (sum / Float(buffer.frameLength)).squareRoot()
  let level = min(1, (rms * 6).squareRoot())
  emit(["level": (Double(level) * 1000).rounded() / 1000])
}

let stopFile: String? = {
  let args = CommandLine.arguments
  guard let index = args.firstIndex(of: "--stop-file"), index + 1 < args.count else { return nil }
  return args[index + 1]
}()

let finishFile: String? = {
  let args = CommandLine.arguments
  guard let index = args.firstIndex(of: "--finish-file"), index + 1 < args.count else { return nil }
  return args[index + 1]
}()

func releaseModifiers(_ list: String) -> CGEventFlags? {
  var flags = CGEventFlags()
  for name in list.split(separator: ",", omittingEmptySubsequences: false) {
    switch name {
    case "control": flags.insert(.maskControl)
    case "option": flags.insert(.maskAlternate)
    case "shift": flags.insert(.maskShift)
    case "command": flags.insert(.maskCommand)
    default: return nil
    }
  }
  return flags.isEmpty ? nil : flags
}

func released(_ required: CGEventFlags, _ current: CGEventFlags) -> Bool {
  !current.contains(required)
}

if let index = CommandLine.arguments.firstIndex(of: "--release-check") {
  let args = CommandLine.arguments
  guard index + 2 < args.count, let required = releaseModifiers(args[index + 1]),
    let raw = UInt64(args[index + 2])
  else { fail("bad-modifiers") }
  emit(["released": released(required, CGEventFlags(rawValue: raw))])
  exit(0)
}

let finishOnRelease: CGEventFlags? = {
  let args = CommandLine.arguments
  guard let index = args.firstIndex(of: "--finish-on-release") else { return nil }
  guard index + 1 < args.count, let flags = releaseModifiers(args[index + 1]) else {
    fail("bad-modifiers")
  }
  return flags
}()

// LaunchServices gives the helper the bundle identity TCC needs, but it also
// means the parent cannot terminate it by killing the `open -W` process. A
// per-session stop marker keeps intentional mute/hang-up deterministic.
var stopTimer: DispatchSourceTimer?
if let stopFile {
  let timer = DispatchSource.makeTimerSource(queue: .global(qos: .userInitiated))
  timer.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100))
  timer.setEventHandler {
    if FileManager.default.fileExists(atPath: stopFile) { exit(0) }
  }
  stopTimer = timer
  timer.resume()
}

// Push-to-talk release must finalize recognition rather than cancel it. The
// handler is installed once the audio engine exists; the timer keeps polling
// if an unusually fast key release beats authorization/setup.
var finishHandler: (() -> Void)?
var finishTimer: DispatchSourceTimer?
if finishFile != nil || finishOnRelease != nil {
  let timer = DispatchSource.makeTimerSource(queue: .global(qos: .userInitiated))
  timer.schedule(deadline: .now() + .milliseconds(50), repeating: .milliseconds(50))
  timer.setEventHandler {
    let finishRequested =
      finishFile.map { FileManager.default.fileExists(atPath: $0) } == true
      || finishOnRelease.map { released($0, CGEventSource.flagsState(.combinedSessionState)) } == true
    guard finishRequested, let finish = finishHandler else { return }
    timer.cancel()
    finish()
  }
  finishTimer = timer
  timer.resume()
}

/// SFSpeechRecognizer can keep revising/re-emitting a partial transcript
/// after the user stops talking. Only a changed transcript resets the timer.
final class SilenceEndpointer {
  private let queue = DispatchQueue(label: "bot.madani.speech.endpoint")
  private let gap: TimeInterval
  private let finish: () -> Void
  private var timer: DispatchSourceTimer?
  private var lastText = ""
  private var lastChange = DispatchTime.now()
  private var finished = false

  init(gapMs: Int, finish: @escaping () -> Void) {
    gap = Double(gapMs) / 1_000
    self.finish = finish
  }

  func start() {
    let source = DispatchSource.makeTimerSource(queue: queue)
    source.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100))
    source.setEventHandler { [weak self] in self?.tick() }
    timer = source
    source.resume()
  }

  func saw(_ text: String) {
    queue.async {
      guard !self.finished, !text.isEmpty, text != self.lastText else { return }
      self.lastText = text
      self.lastChange = .now()
    }
  }

  private func tick() {
    // Never terminate an empty turn: a call may be quiet for as long as the
    // user needs before they begin speaking.
    guard !finished, !lastText.isEmpty else { return }
    let silentFor = Double(DispatchTime.now().uptimeNanoseconds - lastChange.uptimeNanoseconds) / 1_000_000_000
    guard silentFor >= gap else { return }
    finished = true
    timer?.cancel()
    timer = nil
    finish()
  }
}

func runRecognizer() {
SFSpeechRecognizer.requestAuthorization { status in
  guard status == .authorized else { fail("speech-not-authorized") }
  // Recognize in the user's language: a hardcoded en-US recognizer
  // transcribes everyone else into nonsense. First preference that has an
  // available recognizer wins, with en-US as the last resort.
  let candidates =
    (localeArg.map { [Locale(identifier: $0)] } ?? [])
    + Locale.preferredLanguages.map { Locale(identifier: $0) }
    + [Locale.current, Locale(identifier: "en-US")]
  guard
    let recognizer = candidates.lazy.compactMap({ SFSpeechRecognizer(locale: $0) })
      .first(where: { $0.isAvailable })
  else { fail("recognizer-unavailable") }

  let request = SFSpeechAudioBufferRecognitionRequest()
  request.shouldReportPartialResults = true
  if recognizer.supportsOnDeviceRecognition {
    request.requiresOnDeviceRecognition = true
  }

  let engine = AVAudioEngine()
  let node = engine.inputNode
  var audioFinished = false
  let finishAudio = {
    DispatchQueue.main.async {
      guard !audioFinished else { return }
      audioFinished = true
      engine.stop()
      node.removeTap(onBus: 0)
      request.endAudio()
    }
  }
  finishHandler = finishAudio
  var endpointer: SilenceEndpointer?
  if endpointMs > 0 {
    endpointer = SilenceEndpointer(gapMs: endpointMs) {
      // Stop capture before ending the request: appending another audio
      // buffer after endAudio() can make the recognition task fail instead
      // of delivering its final transcript.
      finishAudio()
    }
    endpointer?.start()
  }
  node.installTap(onBus: 0, bufferSize: 1024, format: node.outputFormat(forBus: 0)) { buffer, _ in
    request.append(buffer)
    emitLevel(buffer)
  }
  do {
    engine.prepare()
    try engine.start()
  } catch { fail("mic-failed") }

  recognizer.recognitionTask(with: request) { result, error in
    if let result = result {
      let text = result.bestTranscription.formattedString
      endpointer?.saw(text)
      var line: [String: Any] = ["partial": !result.isFinal, "text": text]
      // Apple's on-device recognizer can end an utterance without isFinal,
      // then return only the next utterance: developer.apple.com/forums/thread/762952
      if let metadata = result.speechRecognitionMetadata, metadata.speechDuration > 0 {
        line["utteranceFinal"] = true
        line["speechStart"] = metadata.speechStartTimestamp
        line["speechDuration"] = metadata.speechDuration
      }
      emit(line)
      if result.isFinal { exit(0) }
    }
    if let error {
      let nsError = error as NSError
      // macOS can authorize this helper while system Dictation is disabled.
      // Preserve that distinction so the UI points to the right setting.
      if nsError.domain == "kLSRErrorDomain" && nsError.code == 201 {
        fail("dictation-disabled")
      }
      fail("recognition-error")
    }
  }
}

}

let filePath: String? = {
  let args = CommandLine.arguments
  guard let index = args.firstIndex(of: "--file"), index + 1 < args.count else { return nil }
  return args[index + 1]
}()

let localeCandidates: [Locale] =
  (localeArg.map { [Locale(identifier: $0)] } ?? [])
  + Locale.preferredLanguages.map { Locale(identifier: $0) }
  + [Locale.current, Locale(identifier: "en-US")]

/// Finalized pieces plus the words still being revised, as one line.
final class Heard {
  private let lock = NSLock()
  private var settled: [String] = []
  private var pending = ""
  func take(_ text: String, final: Bool) -> String {
    lock.lock()
    defer { lock.unlock() }
    let piece = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if final {
      if !piece.isEmpty { settled.append(piece) }
      pending = ""
    } else {
      pending = piece
    }
    return (settled + (pending.isEmpty ? [] : [pending])).joined(separator: " ")
  }
}

// macOS 26+: SpeechAnalyzer runs fully on device with the system's own models. It needs no Siri, no Dictation and
// no speech-recognition permission (only the microphone), so it works on Macs where SFSpeechRecognizer reports no
// available recognizer. Returns false when no language here is supported, so the older recognizer can try.
@available(macOS 26.0, *)
func analyzerLocale() async -> Locale? {
  for candidate in localeCandidates {
    if let found = await SpeechTranscriber.supportedLocale(equivalentTo: candidate) { return found }
  }
  return nil
}

@available(macOS 26.0, *)
func prepareTranscriber(live: Bool) async throws -> SpeechTranscriber? {
  guard SpeechTranscriber.isAvailable, let locale = await analyzerLocale() else { return nil }
  let transcriber = SpeechTranscriber(
    locale: locale, transcriptionOptions: [], reportingOptions: live ? [.volatileResults, .fastResults] : [],
    attributeOptions: [])
  // the language's model downloads once, the first time it is used
  if let install = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
    try await install.downloadAndInstall()
  }
  return transcriber
}

@available(macOS 26.0, *)
func transcribeFile(_ path: String) async throws -> Bool {
  guard let transcriber = try await prepareTranscriber(live: false) else { return false }
  let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
  let analyzer = SpeechAnalyzer(modules: [transcriber])
  let heard = Heard()
  let results = Task {
    var text = ""
    for try await result in transcriber.results { text = heard.take(String(result.text.characters), final: result.isFinal) }
    return text
  }
  if let end = try await analyzer.analyzeSequence(from: file) {
    try await analyzer.finalizeAndFinish(through: end)
  } else {
    await analyzer.cancelAndFinishNow()
  }
  emit(["partial": false, "text": try await results.value])
  return true
}

@available(macOS 26.0, *)
func listenWithAnalyzer() async throws -> Bool {
  guard let transcriber = try await prepareTranscriber(live: true),
    let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])
  else { return false }
  let analyzer = SpeechAnalyzer(modules: [transcriber])
  let (stream, input) = AsyncStream<AnalyzerInput>.makeStream()
  let heard = Heard()
  var endpointer: SilenceEndpointer?
  let results = Task {
    var text = ""
    for try await result in transcriber.results {
      text = heard.take(String(result.text.characters), final: result.isFinal)
      endpointer?.saw(text)
      if !text.isEmpty { emit(["partial": true, "text": text]) }
    }
    return text
  }
  try await analyzer.start(inputSequence: stream)

  let engine = AVAudioEngine()
  let node = engine.inputNode
  let micFormat = node.outputFormat(forBus: 0)
  guard micFormat.sampleRate > 0, micFormat.channelCount > 0 else { fail("mic-failed") }
  let converter = AVAudioConverter(from: micFormat, to: format)
  node.installTap(onBus: 0, bufferSize: 1024, format: micFormat) { buffer, _ in
    emitLevel(buffer)
    guard let converter else { return }
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * format.sampleRate / micFormat.sampleRate + 64)
    guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
    var fed = false
    var error: NSError?
    converter.convert(to: out, error: &error) { _, status in
      if fed {
        status.pointee = .noDataNow
        return nil
      }
      fed = true
      status.pointee = .haveData
      return buffer
    }
    if error == nil, out.frameLength > 0 { input.yield(AnalyzerInput(buffer: out)) }
  }
  do {
    engine.prepare()
    try engine.start()
  } catch { fail("mic-failed") }

  var finishing = false
  let finishAudio = {
    DispatchQueue.main.async {
      guard !finishing else { return }
      finishing = true
      engine.stop()
      node.removeTap(onBus: 0)
      input.finish()
      Task {
        do {
          try await analyzer.finalizeAndFinishThroughEndOfInput()
          emit(["partial": false, "text": try await results.value])
          exit(0)
        } catch { fail("recognition-error") }
      }
    }
  }
  finishHandler = finishAudio
  if endpointMs > 0 {
    endpointer = SilenceEndpointer(gapMs: endpointMs) { finishAudio() }
    endpointer?.start()
  }
  return true
}

/// The microphone first: a refusal is reported plainly instead of as silence. Asking happens only when macOS has
/// never been asked, and only because the person pressed the mic.
func withMicrophone(_ then: @escaping () -> Void) {
  switch AVCaptureDevice.authorizationStatus(for: .audio) {
  case .authorized: then()
  case .notDetermined:
    AVCaptureDevice.requestAccess(for: .audio) { granted in
      if granted { DispatchQueue.main.async(execute: then) } else { fail("mic-denied") }
    }
  default: fail("mic-denied")
  }
}

if let filePath {
  // a recording instead of the microphone: for tests, never asks for anything
  Task {
    if #available(macOS 26.0, *) {
      do {
        if try await transcribeFile(filePath) { exit(0) }
      } catch { fail("recognition-error") }
    }
    fail("recognizer-unavailable")
  }
} else {
  withMicrophone {
    if #available(macOS 26.0, *) {
      Task {
        do {
          if try await listenWithAnalyzer() { return }
        } catch {
          // no model for this language, or the analyzer refused: the older recognizer may still hear it
        }
        DispatchQueue.main.async { runRecognizer() }
      }
    } else {
      runRecognizer()
    }
  }
}

RunLoop.main.run()
