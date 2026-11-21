import Capacitor
import UIKit
import WebKit

/// The chat's header and composer in the system's Liquid Glass (iOS 26+), drawn over the web view so the glass bends the
/// transcript scrolling under it. A web view cannot draw this material itself. The page keeps its own header and
/// composer in place, invisible, and this plugin hands every tap and keystroke back to them. Older iOS answers
/// unsupported and the page draws its own chrome.
@objc(GlassChromePlugin)
public class GlassChromePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "GlassChromePlugin"
    public let jsName = "MadaniGlass"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "supported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnNone),
        CAPPluginMethod(name: "setText", returnType: CAPPluginReturnNone),
        CAPPluginMethod(name: "clearText", returnType: CAPPluginReturnNone),
        CAPPluginMethod(name: "setAvatar", returnType: CAPPluginReturnNone),
        CAPPluginMethod(name: "focus", returnType: CAPPluginReturnNone),
        CAPPluginMethod(name: "blur", returnType: CAPPluginReturnNone),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnNone),
        CAPPluginMethod(name: "slide", returnType: CAPPluginReturnNone),
        CAPPluginMethod(name: "glyphs", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "home", returnType: CAPPluginReturnNone),
    ]

    private var chrome: AnyObject?

    /// The page asks once at startup: the chrome is built then, hidden, so the first chat opened never waits for its
    /// glass views to be made.
    @objc func supported(_ call: CAPPluginCall) {
        if #available(iOS 26.0, *) {
            // a page that asks has just loaded, maybe in place of one the system reclaimed with a chat open: the chrome
            // outlives the page, so nothing that page showed (header, composer, Home's bar, focus, text) stays up
            withChrome { chrome in
                chrome.blur()
                chrome.dropStrandedLift("reload")
                chrome.stopSlide()
                chrome.apply([:])
                chrome.pageGone()
                chrome.applyHome(nil)
                chrome.resetText()
            }
            call.resolve(["supported": true, "acks": true])
        } else {
            call.resolve(["supported": false])
        }
    }

    @available(iOS 26.0, *)
    private func withChrome(_ body: @escaping (ChatGlassChrome) -> Void) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if let chrome = self.chrome as? ChatGlassChrome { body(chrome); return }
            guard let host = self.bridge?.nativeHost else {
                KeyboardTrace.log("composer ack", ["shown": 0, "host": 0])
                self.notifyListeners("glass", data: ["type": "composer", "shown": false, "reason": "no host"])
                return
            }
            let chrome = ChatGlassChrome(host: host) { [weak self] event in self?.notifyListeners("glass", data: event) }
            self.chrome = chrome
            body(chrome)
        }
    }

    @objc func update(_ call: CAPPluginCall) {
        guard #available(iOS 26.0, *) else { return }
        let options = call.options as? [String: Any] ?? [:]
        withChrome { $0.apply(options) }
    }

    @objc func setText(_ call: CAPPluginCall) {
        guard #available(iOS 26.0, *) else { return }
        let text = call.getString("text") ?? ""
        let seq = call.getInt("seq") ?? 0
        withChrome { $0.setText(text, seq: seq) }
    }

    @objc func clearText(_ call: CAPPluginCall) {
        guard #available(iOS 26.0, *) else { return }
        let id = call.getInt("id") ?? 0
        withChrome { $0.clearText(id: id) }
    }

    @objc func setAvatar(_ call: CAPPluginCall) {
        guard #available(iOS 26.0, *) else { return }
        let data = call.getString("data")
        withChrome { $0.setAvatar(data) }
    }

    @objc func focus(_ call: CAPPluginCall) {
        guard #available(iOS 26.0, *) else { return }
        withChrome { $0.focus() }
    }

    @objc func blur(_ call: CAPPluginCall) {
        guard #available(iOS 26.0, *) else { return }
        withChrome { $0.blur() }
    }

    @objc func clear(_ call: CAPPluginCall) {
        guard #available(iOS 26.0, *) else { return }
        withChrome { chrome in
            chrome.apply([:])
            chrome.pageGone()
            chrome.resetText()
        }
    }

    @objc func home(_ call: CAPPluginCall) {
        guard #available(iOS 26.0, *) else { return }
        let state = call.options["state"] as? [String: Any]
        withChrome { $0.applyHome(state) }
    }

    /// The header's own symbols as the page can draw them: while a sheet covers the chat the page shows its header in
    /// the glass's place, and with these its back and computer buttons are the same glyphs, so nothing changes there.
    @objc func glyphs(_ call: CAPPluginCall) {
        guard #available(iOS 26.0, *) else { call.resolve([:]); return }
        DispatchQueue.main.async { call.resolve(ChatGlassChrome.glyphImages()) }
    }

    @objc func slide(_ call: CAPPluginCall) {
        guard #available(iOS 26.0, *) else { return }
        let path = call.options["path"] as? [String: Any]
        let points = (path?["points"] as? [Any] ?? []).compactMap { ($0 as? NSNumber).map { CGFloat($0.doubleValue) } }
        let duration = ((path?["duration"] as? NSNumber)?.doubleValue ?? 0) / 1000
        let startedAt = (call.options["at"] as? NSNumber)?.doubleValue
        withChrome { chrome in
            if points.isEmpty { chrome.stopSlide() } else { chrome.slide(points, duration: duration, elapsed: ChatGlassChrome.sinceEpoch(ms: startedAt)) }
        }
    }
}

/// Each keyboard step with the native clock in the device log, when the app's defaults have MadaniKeyboardTrace
/// (`xcrun simctl spawn booted defaults write bot.madani.mobile MadaniKeyboardTrace -bool YES`).
enum KeyboardTrace {
    static let on = UserDefaults.standard.bool(forKey: "MadaniKeyboardTrace")

    static func log(_ step: String, _ detail: [String: CGFloat]) {
        guard on else { return }
        let fields = detail.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " ")
        NSLog("[kb] %.4f %@ %@", CACurrentMediaTime(), step, fields)
    }
}

/// A vertical fade from one colour, solid down to `solidUntil` (0...1), clear at the bottom.
final class GradientView: UIView {
    override class var layerClass: AnyClass { CAGradientLayer.self }

    func paint(_ color: UIColor, solidUntil: CGFloat) {
        guard let gradient = layer as? CAGradientLayer else { return }
        gradient.colors = [color.cgColor, color.cgColor, color.withAlphaComponent(0).cgColor]
        gradient.locations = [0, NSNumber(value: Double(solidUntil)), 1]
    }
}

/// Lets touches through everywhere but on its own controls.
class PassthroughView: UIView {
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let hit = super.hitTest(point, with: event)
        return hit === self ? nil : hit
    }
}

/// A 32pt disc that answers the 44pt square around it (HIG minimum hit region).
private class DiscButton: UIButton {
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        bounds.insetBy(dx: min(0, (bounds.width - 44) / 2), dy: min(0, (bounds.height - 44) / 2)).contains(point)
    }
}

/// The round button at the end of the composer: a solid disc in the page's own colours for it, not glass. A prominent
/// glass button (iOS 26) lays its tint over what is behind it and adapts its glyph to that backdrop, so a near-black or
/// near-white fill read washed out or inverted; this one is exactly the page's fill and ink. Fill and glyph change in
/// one spring, the old glyph shrinking out as the new one grows in.
@available(iOS 26.0, *)
private final class SlotButton: DiscButton {
    private var glyph = UIImageView()
    private var symbol = ""
    private var ink: UIColor?

    override init(frame: CGRect) {
        super.init(frame: frame)
        layer.cornerCurve = .circular
        glyph.isUserInteractionEnabled = false
        glyph.contentMode = .center
        addSubview(glyph)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layoutSubviews() {
        super.layoutSubviews()
        layer.cornerRadius = bounds.height / 2
        for view in subviews where view is UIImageView {
            view.bounds = bounds
            view.center = CGPoint(x: bounds.midX, y: bounds.midY)
        }
    }

    override var isHighlighted: Bool {
        didSet {
            guard isHighlighted != oldValue, !UIAccessibility.isReduceMotionEnabled else { return }
            let pressed = isHighlighted
            UIView.animate(springDuration: pressed ? 0.12 : 0.3, bounce: 0, initialSpringVelocity: 0, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState]) {
                self.transform = pressed ? CGAffineTransform(scaleX: 1.08, y: 1.08) : .identity
                self.alpha = pressed ? 0.88 : 1
            }
        }
    }

    func show(symbol name: String, configuration: UIImage.SymbolConfiguration, fill: UIColor, ink newInk: UIColor, animated: Bool) {
        let glyphChanged = name != symbol || newInk != ink
        let fillChanged = backgroundColor != fill
        guard glyphChanged || fillChanged else { return }
        let image = UIImage(systemName: name, withConfiguration: configuration)?.withRenderingMode(.alwaysTemplate)
        // a button just made arrives with its own entrance (or none): it starts in its colours
        let first = symbol.isEmpty
        symbol = name
        ink = newInk
        guard animated, !first, window != nil else {
            backgroundColor = fill
            glyph.image = image
            glyph.tintColor = newInk
            return
        }
        let reduced = UIAccessibility.isReduceMotionEnabled
        let small = CGAffineTransform(scaleX: 0.5, y: 0.5)
        var incoming: UIImageView?
        var outgoing: UIImageView?
        if glyphChanged {
            let next = UIImageView(image: image)
            next.tintColor = newInk
            next.contentMode = .center
            next.isUserInteractionEnabled = false
            next.bounds = bounds
            next.center = CGPoint(x: bounds.midX, y: bounds.midY)
            next.alpha = 0
            if !reduced { next.transform = small }
            addSubview(next)
            outgoing = glyph
            glyph = next
            incoming = next
        }
        UIView.animate(springDuration: 0.3, bounce: 0, initialSpringVelocity: 0, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState]) {
            self.backgroundColor = fill
            incoming?.alpha = 1
            incoming?.transform = .identity
            outgoing?.alpha = 0
            if !reduced { outgoing?.transform = small }
        } completion: { _ in
            outgoing?.removeFromSuperview()
        }
    }
}

struct Frame {
    let rect: CGRect
    init?(_ value: Any?) {
        guard let d = value as? [String: Any], let x = (d["x"] as? NSNumber)?.doubleValue, let y = (d["y"] as? NSNumber)?.doubleValue,
              let w = (d["w"] as? NSNumber)?.doubleValue, let h = (d["h"] as? NSNumber)?.doubleValue else { return nil }
        rect = CGRect(x: x, y: y, width: w, height: h)
    }
}

@available(iOS 26.0, *)
final class ChatGlassChrome: NSObject, UITextViewDelegate {
    /// The reference composer's metrics (the page's mobile.css draws the same): 48 high, 32pt controls 8 in from the
    /// capsule's edge and 8 apart, the field 10 after the +.
    private static let capsuleHeight: CGFloat = 48
    private static let inset: CGFloat = 8
    private static let disc: CGFloat = 32
    private static let between: CGFloat = 8
    private static let maxLines: CGFloat = 5

    private weak var host: UIView?
    private let emit: ([String: Any]) -> Void

    private let header = PassthroughView()
    private let back = UIButton(configuration: .glass())
    private let pill = UIButton(configuration: .glass())
    private let right = UIButton(configuration: .glass())
    private let liveDot = UIView()

    private let composer = PassthroughView()
    private var home: GlassHomeBar!
    private let capsule = UIVisualEffectView(effect: ChatGlassChrome.interactiveGlass())
    private let plus = DiscButton(configuration: .plain())
    private let text = PastingTextView()
    private let placeholder = UILabel()
    private let voice = UILabel()
    private let wave = GlassVoiceWave()
    private var listening = false
    private var actions: [UIButton] = []
    private var actionKinds: [String] = []
    /// the page's text size over the system body size; 0 until the page says, and the field follows Larger Text alone
    private var fontScale: CGFloat = 0
    /// The page's 24 line for 17 text, times its scale: the field's lines stand as tall as the page's, so a wrapping
    /// draft grows both composers by the same steps.
    private var lineHeight: CGFloat = 24

    /// iOS 26 interactive glass: the capsule answers a touch by growing and brightening, as the system's glass buttons do
    static func interactiveGlass() -> UIGlassEffect {
        let effect = UIGlassEffect(style: .regular)
        effect.isInteractive = true
        return effect
    }

    private var leading: NSLayoutConstraint!
    private var width: NSLayoutConstraint!
    private var height: NSLayoutConstraint!
    private var bottom: NSLayoutConstraint!

    private var headerShown = false
    private var composerShown = false
    /// the page draws its own chrome in the same place (a sheet over the chat), or did until now: the two swap at once,
    /// never crossfade, or both show (or neither) for the length of the fade
    private var handoff = false
    private var instant = false
    /// a call's bar has the composer's place on the page
    private var inCall = false
    private var returnSends = true
    private var textSeq = 0
    private var reportedHeight: CGFloat = 0
    private var accent = UIColor.systemBlue
    private var avatar: UIImage?
    private var avatarData: String?
    private var name = ""
    private var titleRect: CGRect?

    /// the chat page's distance right of where it rests: the header and composer sit on it, so they move with it
    private var offset: CGFloat = 0
    private var slideEnd: CFTimeInterval = 0
    private var sliding: Bool { CACurrentMediaTime() < slideEnd }
    private static let slideKey = "page-slide"

    /// from the composer's bottom to the line it rests on: the home indicator's edge, or the keyboard's top
    private var gap: CGFloat = 8
    private var keyboardOverlap: CGFloat = 0
    /// where the page rests the composer; with the keyboard up it widens to `typingInset` from each edge
    private var restingFrame: CGRect = .zero
    private static let typingInset: CGFloat = 6

    /// The composer's keyboard is moving the page: the whole web view rises with it, in the same animation, and the page
    /// takes the space itself only once the keyboard has stopped (see `keyboardSettled`).
    private var keyboardRide = false
    /// how far the page is lifted now; it rises less than the keyboard by the empty space under a short transcript
    private var lift: CGFloat = 0
    /// the empty space under the transcript's last row, as the page last measured it at rest
    private var transcriptRoom: CGFloat = 0
    private var keyboardMove = 0
    /// a keyboard move came while the host had no window, so the composer and lift still stand where it found them
    private var keyboardMissed = false
    private var fieldEditing = false
    /// the page's status bar band, drawn here while the page is lifted out from under it
    private let topBand = GradientView()
    private var ground: UIColor?

    init(host: UIView, emit: @escaping ([String: Any]) -> Void) {
        self.host = host
        self.emit = emit
        super.init()
        build(in: host)
    }

    private func build(in host: UIView) {
        header.frame = host.bounds
        header.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        header.alpha = 0
        header.isHidden = true
        host.addSubview(header)
        round(back, symbol: Self.headerSymbols["back"]!, label: "Back") { [weak self] in self?.emit(["type": "tap", "target": "back"]) }
        round(right, symbol: Self.headerSymbols["right"]!, label: "Computer") { [weak self] in self?.emit(["type": "tap", "target": "right"]) }
        pill.configuration?.cornerStyle = .capsule
        pill.configuration?.imagePadding = 8
        pill.configuration?.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 7, bottom: 0, trailing: 16)
        pill.configuration?.titleLineBreakMode = .byTruncatingTail
        // the bot's sheet rises as the finger lands, not when it lifts
        pill.addAction(UIAction { [weak self] _ in self?.emit(["type": "tap", "target": "title"]) }, for: .touchDown)
        liveDot.backgroundColor = .systemGreen
        liveDot.layer.cornerRadius = 4
        liveDot.isUserInteractionEnabled = false
        liveDot.isHidden = true
        right.addSubview(liveDot)
        topBand.isUserInteractionEnabled = false
        topBand.isHidden = true
        [topBand, back, pill, right].forEach(header.addSubview)
        home = GlassHomeBar(host: host, below: header, emit: emit)

        composer.translatesAutoresizingMaskIntoConstraints = false
        composer.alpha = 0
        composer.isHidden = true
        host.addSubview(composer)
        capsule.cornerConfiguration = .capsule(maximumRadius: Self.capsuleHeight / 2)
        capsule.frame = composer.bounds
        capsule.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        capsule.contentView.isUserInteractionEnabled = true
        composer.addSubview(capsule)

        round(plus, symbol: "plus", label: "Add") { [weak self] in self?.emit(["type": "tap", "target": "plus"]) }
        text.backgroundColor = .clear
        text.font = .preferredFont(forTextStyle: .body)
        text.adjustsFontForContentSizeCategory = true
        text.textContainerInset = .zero
        text.textContainer.lineFragmentPadding = 0
        text.isScrollEnabled = false
        if let font = text.font { text.typingAttributes = fieldAttributes(font) }
        text.returnKeyType = .send
        text.delegate = self
        text.onPasteImages = { [weak self] files in self?.emit(["type": "paste", "files": files]) }
        placeholder.font = text.font
        placeholder.adjustsFontForContentSizeCategory = true
        placeholder.textColor = .placeholderText
        placeholder.lineBreakMode = .byTruncatingTail
        placeholder.isUserInteractionEnabled = false
        voice.font = text.font
        voice.textColor = .secondaryLabel
        voice.lineBreakMode = .byTruncatingHead
        voice.alpha = 0
        wave.alpha = 0
        wave.tintColor = .secondaryLabel
        [plus, text, placeholder, voice, wave].forEach(capsule.contentView.addSubview)
        capsule.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(capsuleTapped)))

        leading = composer.leadingAnchor.constraint(equalTo: host.leadingAnchor)
        width = composer.widthAnchor.constraint(equalToConstant: 300)
        height = composer.heightAnchor.constraint(equalToConstant: Self.capsuleHeight)
        bottom = composer.bottomAnchor.constraint(equalTo: host.bottomAnchor, constant: -gap)
        NSLayoutConstraint.activate([leading, width, height, bottom])

        NotificationCenter.default.addObserver(self, selector: #selector(contentSizeChanged), name: UIContentSizeCategory.didChangeNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardWillChangeFrame(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardDidHide), name: UIResponder.keyboardDidHideNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(becameActive), name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    /// the page's own frame at rest, nearly the full width while typing
    private func applyComposerWidth() {
        let typing = keyboardOverlap > 0 && (host?.bounds.width ?? 0) > 0
        leading.constant = typing ? Self.typingInset : restingFrame.minX
        width.constant = typing ? (host?.bounds.width ?? restingFrame.width) - Self.typingInset * 2 : restingFrame.width
    }

    private func restingBottom() -> CGFloat {
        -(max(host?.safeAreaInsets.bottom ?? 0, keyboardOverlap) + gap)
    }

    /// The composer rides the keyboard in the keyboard's own animation: the duration and curve its notification carries.
    /// With the composer's own field focused the page rides in the same animation, lifted whole by a transform: one
    /// clock for the keyboard, composer and transcript, and no page layout until the keyboard has stopped.
    @objc private func keyboardWillChangeFrame(_ note: Notification) {
        guard let host, let info = note.userInfo, let end = (info[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        guard let window = host.window else { keyboardMissed = true; return }
        keyboardMissed = false
        let local = host.convert(end, from: window.screen.coordinateSpace)
        let overlap = max(0, host.bounds.maxY - local.minY)
        guard overlap != keyboardOverlap else { return }
        let safe = host.safeAreaInsets.bottom
        let wasCovering = max(0, keyboardOverlap - safe)
        let covering = max(0, overlap - safe)
        keyboardOverlap = overlap
        bottom.constant = restingBottom()
        if restingFrame.width > 0 { applyComposerWidth() }
        if covering > 0 && (text.isFirstResponder || fieldEditing) && page != nil { keyboardRide = true }
        let newLift: CGFloat? = keyboardRide
            ? (wasCovering == 0 ? max(0, covering - transcriptRoom) : min(covering, max(0, lift + covering - wasCovering)))
            : nil
        let duration = (info[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0
        let curve = (info[UIResponder.keyboardAnimationCurveUserInfoKey] as? NSNumber)?.uintValue ?? 7
        var event: [String: Any] = ["type": "keyboard", "height": overlap, "duration": duration, "at": Date().timeIntervalSince1970 * 1000]
        if let newLift { event["lift"] = newLift }
        KeyboardTrace.log("will", ["overlap": overlap, "lift": newLift ?? -1, "duration": CGFloat(duration), "room": transcriptRoom])
        emit(event)
        if let newLift, newLift > 0 { showTopBand() }
        keyboardMove += 1
        let move = keyboardMove
        let change = {
            host.layoutIfNeeded()
            self.layoutComposer(animated: false)
            if let newLift { self.setLift(newLift) }
        }
        let settled = { [weak self] in
            guard let self, move == self.keyboardMove, let newLift else { return }
            self.keyboardSettled(height: overlap, lift: newLift)
        }
        guard composerShown || newLift != nil, duration > 0 else {
            UIView.performWithoutAnimation(change)
            settled()
            return
        }
        UIView.animate(withDuration: duration, delay: 0, options: [UIView.AnimationOptions(rawValue: curve << 16), .beginFromCurrentState, .allowUserInteraction], animations: change) { _ in settled() }
    }

    /// UIKit skips the frame change while the host has no window (a full screen camera or picker over the app): once the
    /// keyboard is gone, the composer and the page come down from wherever that left them.
    @objc private func keyboardDidHide() {
        guard keyboardMissed else { return }
        settleKeyboardGone("did hide")
    }

    @objc private func becameActive() { dropStrandedLift("active") }

    /// The page is lifted for a keyboard the field no longer has (back from the background, a page reload): it comes
    /// down at once.
    func dropStrandedLift(_ why: String) {
        guard lift > 0, !text.isFirstResponder, !fieldEditing else { return }
        settleKeyboardGone(why)
    }

    private func settleKeyboardGone(_ why: String) {
        KeyboardTrace.log("gone (\(why))", ["overlap": keyboardOverlap, "lift": lift])
        keyboardMissed = false
        keyboardMove += 1
        keyboardOverlap = 0
        bottom.constant = restingBottom()
        if restingFrame.width > 0 { applyComposerWidth() }
        UIView.performWithoutAnimation {
            host?.layoutIfNeeded()
            layoutComposer(animated: false)
            setLift(0)
        }
        emit(["type": "keyboard", "height": 0, "duration": 0, "at": Date().timeIntervalSince1970 * 1000, "lift": 0])
        keyboardSettled(height: 0, lift: 0)
    }

    private var page: PageWebView? { host?.subviews.lazy.compactMap { $0 as? PageWebView }.first }

    private func setLift(_ value: CGFloat) {
        lift = value
        page?.keyboardLift = value
    }

    /// The keyboard has stopped: the page lays itself out for it and offsets its scroll by the lift in one frame, so
    /// nothing on screen moves. Back down, the page is whole again and the band goes.
    private func keyboardSettled(height: CGFloat, lift: CGFloat) {
        KeyboardTrace.log("settled", ["overlap": height, "lift": lift])
        emit(["type": "keyboard", "height": height, "lift": lift, "settled": true])
        guard height <= (host?.safeAreaInsets.bottom ?? 0) else { return }
        keyboardRide = false
        topBand.isHidden = true
        page?.landed()
    }

    private func showTopBand() {
        guard let host, let ground else { return }
        let height = host.safeAreaInsets.top + 16
        UIView.performWithoutAnimation {
            topBand.frame = CGRect(x: 0, y: 0, width: host.bounds.width, height: height)
            topBand.paint(ground, solidUntil: (height - 16) / max(1, height))
            topBand.isHidden = false
        }
    }

    // MARK: riding on the page

    private func setOffset(_ x: CGFloat, homeFollows: Bool = true) {
        offset = x
        let moved = CGAffineTransform(translationX: x, y: 0)
        for view in [header, composer] where view.transform != moved { view.transform = moved }
        if homeFollows { home.follow(page: x) }
    }

    /// The chat's page is gone: Home's bar is the list's again, whole and in place.
    func pageGone() { home.follow(page: nil) }

    func applyHome(_ state: [String: Any]?) {
        home.apply(state)
        keepOnTop()
    }

    /// Plays the page's own slide: the same positions, one per 60 Hz frame and linear between, which is what the page
    /// hands its compositor in the same frame. Both views share one transaction, so they start together.
    /// The page's slide started `elapsed` seconds before its message got here (the bridge hop): the chrome starts that far
    /// into the same path, so it sits on the page from its first frame instead of trailing it.
    func slide(_ points: [CGFloat], duration: TimeInterval, elapsed: TimeInterval = 0) {
        guard let to = points.last else { return }
        let skipped = min(max(0, elapsed), Self.maxCatchUp)
        guard points.count > 1, duration > skipped else {
            stopSlide()
            setOffset(to)
            return
        }
        let now = CACurrentMediaTime()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for view in [header, composer] {
            view.layer.removeAnimation(forKey: Self.slideKey)
            let animation = CAKeyframeAnimation(keyPath: "transform.translation.x")
            animation.values = points.map { NSNumber(value: Double($0)) }
            animation.duration = duration
            animation.calculationMode = .linear
            animation.beginTime = view.layer.convertTime(now, from: nil) - skipped
            animation.fillMode = .backwards
            animation.preferredFrameRateRange = CAFrameRateRange(minimum: 80, maximum: 120, preferred: 120)
            view.layer.add(animation, forKey: Self.slideKey)
        }
        home.slide(points, duration: duration, beginTime: now - skipped)
        setOffset(to, homeFollows: false)
        CATransaction.commit()
        slideEnd = now + duration - skipped
    }

    /// a message older than this is a stalled page, not a bridge hop: the chrome plays the rest from where it is due
    private static let maxCatchUp: TimeInterval = 0.12

    /// Seconds since a page clock reading in epoch milliseconds (performance.timeOrigin + now()), 0 without one.
    static func sinceEpoch(ms: Double?) -> TimeInterval {
        guard let ms, ms > 0 else { return 0 }
        return max(0, Date().timeIntervalSince1970 - ms / 1000)
    }

    /// A finger took the page mid-slide: the chrome stays where it is drawn, and follows the page's frames from here.
    func stopSlide() {
        guard sliding else { return }
        let drawn = (header.layer.presentation()?.value(forKeyPath: "transform.translation.x") as? NSNumber).map { CGFloat($0.doubleValue) }
        for view in [header, composer] { view.layer.removeAnimation(forKey: Self.slideKey) }
        slideEnd = 0
        setOffset(drawn ?? offset)
    }

    private func round(_ button: UIButton, symbol: String, label: String, action: @escaping () -> Void) {
        button.configuration?.cornerStyle = .capsule
        button.configuration?.image = UIImage(systemName: symbol, withConfiguration: Self.headerGlyph)
        button.configuration?.baseForegroundColor = .label
        button.accessibilityLabel = label
        button.addAction(UIAction { _ in action() }, for: .touchUpInside)
    }

    // MARK: state from the page

    func apply(_ state: [String: Any]) {
        if let dark = state["dark"] as? Bool {
            let style: UIUserInterfaceStyle = dark ? .dark : .light
            header.overrideUserInterfaceStyle = style
            composer.overrideUserInterfaceStyle = style
        }
        if let hex = state["accent"] as? String, let color = UIColor(cssHex: hex) { accent = color }
        if let hex = state["ground"] as? String, let color = UIColor(cssHex: hex) {
            ground = color
            host?.backgroundColor = color
        }
        if let x = (state["offset"] as? NSNumber).map({ CGFloat($0.doubleValue) }), !sliding { setOffset(x) }
        let handing = state["handoff"] as? Bool ?? false
        let calling = state["call"] as? Bool ?? false
        // off its resting place the chrome is riding a page in or out: it comes and goes with the page, never fades. A
        // call's bar coming into the composer's place, or leaving it, crossfades with the composer instead
        instant = ((handing || handoff) && !calling && !inCall) || sliding || abs(offset) > 0.5
        handoff = handing
        inCall = calling
        applyHeader(state["header"] as? [String: Any])
        let wanted = state["composer"] as? [String: Any]
        applyComposer(wanted)
        keepOnTop()
        if wanted != nil { ackComposer() }
    }

    /// tells the page whether the composer it asked for is on screen, so it hides its own only then
    private func ackComposer() {
        let shown = host != nil && composerShown && composer.superview === host && !composer.isHidden
        KeyboardTrace.log("composer ack", ["shown": shown ? 1 : 0, "host": host == nil ? 0 : 1])
        var event: [String: Any] = ["type": "composer", "shown": shown]
        if shown {
            let f = composer.frame
            event["frame"] = ["x": f.minX, "y": f.minY, "w": f.width, "h": f.height]
        } else {
            event["reason"] = host == nil ? "no host" : "not drawn"
        }
        emit(event)
    }

    /// views the system adds to the host later must not land over the chrome and take its taps
    private func keepOnTop() {
        guard let host, headerShown || composerShown || !home.view.isHidden else { return }
        let tail = Array(host.subviews.suffix(3))
        if tail.count < 3 || tail[0] !== home.view || tail[1] !== header || tail[2] !== composer {
            host.bringSubviewToFront(home.view)
            host.bringSubviewToFront(header)
            host.bringSubviewToFront(composer)
        }
    }

    private func applyHeader(_ data: [String: Any]?) {
        guard let data, let backFrame = Frame(data["back"]), let titleFrame = Frame(data["title"]) else {
            show(header, false, &headerShown)
            return
        }
        back.frame = backFrame.rect
        if let label = data["backLabel"] as? String, !label.isEmpty { back.accessibilityLabel = label }
        let newName = data["name"] as? String ?? ""
        if newName != name { name = newName; refreshPill() }
        pill.accessibilityLabel = data["titleLabel"] as? String ?? newName
        if let rightFrame = Frame(data["right"]) {
            right.isHidden = false
            right.frame = rightFrame.rect
            right.accessibilityLabel = data["rightLabel"] as? String
            liveDot.isHidden = !(data["live"] as? Bool ?? false)
            liveDot.frame = CGRect(x: rightFrame.rect.width - 14, y: 6, width: 8, height: 8)
        } else {
            right.isHidden = true
        }
        titleRect = titleFrame.rect
        layoutPill()
        show(header, true, &headerShown)
    }

    private func layoutPill() {
        guard let titleRect else { return }
        let side: CGFloat = 16 + 44 + 8
        let maxWidth = max(80, (host?.bounds.width ?? 390) - side * 2)
        let fitted = pill.sizeThatFits(CGSize(width: maxWidth, height: 44))
        let pillWidth = min(maxWidth, ceil(fitted.width))
        let frame = CGRect(x: titleRect.midX - pillWidth / 2, y: titleRect.midY - 22, width: pillWidth, height: 44)
        if pill.frame != frame { pill.frame = frame }
    }

    /// name and avatar swap in one go, with no crossfade: a new chat's pill is drawn before its header shows
    private func refreshPill() {
        var title = AttributedString(name)
        title.font = UIFont.systemFont(ofSize: 17, weight: .medium)
        UIView.performWithoutAnimation {
            pill.configuration?.attributedTitle = title
            pill.configuration?.baseForegroundColor = .label
            pill.configuration?.image = avatar
            pill.layoutIfNeeded()
        }
        layoutPill()
    }

    func setAvatar(_ data: String?) {
        guard data != avatarData else { return }
        avatarData = data
        avatar = data.flatMap(Self.image(fromDataURL:)).map { Self.pixelScaled($0, to: CGSize(width: 24, height: 24)) }
        refreshPill()
    }

    private func applyComposer(_ data: [String: Any]?) {
        guard let data, let frame = Frame(data["frame"]), host != nil else {
            if text.isFirstResponder {
                KeyboardTrace.log("resign (page composer)", [:])
                text.resignFirstResponder()
            }
            show(composer, false, &composerShown)
            return
        }
        restingFrame = frame.rect
        applyComposerWidth()
        if let gap = (data["gap"] as? NSNumber)?.doubleValue { self.gap = CGFloat(max(0, gap)) }
        if let room = (data["room"] as? NSNumber)?.doubleValue { transcriptRoom = CGFloat(max(0, room)) }
        let resting = restingBottom()
        if abs(bottom.constant - resting) >= 1 { bottom.constant = resting }
        plus.isHidden = !(data["plus"] as? Bool ?? true)
        if let label = data["plusLabel"] as? String, !label.isEmpty { plus.accessibilityLabel = label }
        placeholder.text = data["placeholder"] as? String ?? ""
        if let scale = (data["fontScale"] as? NSNumber)?.doubleValue, scale > 0 { applyFontScale(CGFloat(scale)) }
        text.isEditable = !(data["disabled"] as? Bool ?? false)
        returnSends = data["returnSends"] as? Bool ?? true
        text.returnKeyType = returnSends ? .send : .default
        setListening(data["voice"] as? String, spoken: data["voiceHeard"] as? Bool ?? true)
        applyActions(data["buttons"] as? [[String: Any]] ?? [])
        updatePlaceholder()
        layoutComposer()
        show(composer, true, &composerShown)
    }

    /// Dictation shows in the capsule itself: the waveform and what it has heard take the field's place in one crossfade,
    /// and the field (with any draft) comes back the same way when it stops, is discarded or fails.
    private func setListening(_ heard: String?, spoken: Bool) {
        voice.text = heard
        voice.textColor = spoken ? .label : .placeholderText
        let now = heard != nil
        guard now != listening else { return }
        listening = now
        if now {
            if text.isFirstResponder { text.resignFirstResponder() }
            wave.start()
        }
        text.isUserInteractionEnabled = !now
        let change = { [self] in
            text.alpha = now ? 0 : 1
            placeholder.alpha = now ? 0 : 1
            voice.alpha = now ? 1 : 0
            wave.alpha = now ? 1 : 0
        }
        let done: (Bool) -> Void = { [self] _ in if !listening { wave.stop() } }
        guard composerShown, !instant, host?.window != nil else {
            change()
            done(true)
            return
        }
        UIView.animate(withDuration: UIAccessibility.isReduceMotionEnabled ? 0.12 : 0.2, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction], animations: change, completion: done)
    }

    /// the round button at the end of the pill: the mic at rest, Send once there is text, Stop while the bot works, keep
    /// while listening
    private static let slotKinds: Set<String> = ["mic", "send", "micSend", "stop", "waits", "keep"]
    /// the small control beside it: the mic, or discard while listening; one turns into the other in place
    private static let besideKinds: Set<String> = ["mic", "discard"]

    private func applyActions(_ buttons: [[String: Any]]) {
        let kinds = buttons.map { $0["kind"] as? String ?? "" }
        if kinds != actionKinds {
            let oldKinds = actionKinds
            // the mic beside the round button (Send, or a working bot's Stop): it springs out of the round button and
            // slips back into it, as composer-mic-in and composer-mic-out do on the page
            let hadBeside = oldKinds.dropLast().contains { Self.besideKinds.contains($0) }
            let hasBeside = kinds.dropLast().contains { Self.besideKinds.contains($0) }
            // the slot keeps one button and one frame through mic, Send and Stop: only its symbol changes
            let keep: UIButton? = {
                guard let last = actions.last, let was = oldKinds.last, let now = kinds.last,
                      Self.slotKinds.contains(was), Self.slotKinds.contains(now) else { return nil }
                return last
            }()
            // the mic beside turns into discard as listening starts, and back as it ends
            // the mic stays through the call turning into Send as well, where the round button itself is made anew
            let besideKept: UIButton? = {
                guard oldKinds.count == 2, kinds.count == 2, Self.besideKinds.contains(oldKinds[0]),
                      Self.besideKinds.contains(kinds[0]) else { return nil }
                return actions.first
            }()
            let leaving = zip(actions, oldKinds).filter { $0.0 !== keep && $0.0 !== besideKept }
            actions = kinds.enumerated().map { index, kind in
                if index == kinds.count - 1, let keep {
                    configure(keep, kind: kind, index: index)
                    return keep
                }
                if index == 0, let besideKept {
                    configure(besideKept, kind: kind, index: index)
                    return besideKept
                }
                let button: UIButton = index == kinds.count - 1 && Self.slotKinds.contains(kind) ? SlotButton() : DiscButton(configuration: .plain())
                configure(button, kind: kind, index: index)
                capsule.contentView.addSubview(button)
                return button
            }
            actionKinds = kinds
            layoutComposer()
            for (button, kind) in leaving {
                button.isUserInteractionEnabled = false
                if Self.besideKinds.contains(kind) && hadBeside && !hasBeside && keep != nil {
                    ComposerMotion.leave(button) { button.removeFromSuperview() }
                } else {
                    button.removeFromSuperview()
                }
            }
            let had = Set(oldKinds)
            for (index, (button, kind)) in zip(actions, kinds).enumerated() where button !== keep && button !== besideKept {
                if Self.besideKinds.contains(kind) && index < kinds.count - 1 && !hadBeside && keep != nil { ComposerMotion.micIn(button) }
                else if (kind == "send" || kind == "micSend" || kind == "call") && !had.contains(kind) { ComposerMotion.popIn(button) }
            }
        }
        for (button, data) in zip(actions, buttons) {
            button.isEnabled = !(data["disabled"] as? Bool ?? false)
            if let label = data["label"] as? String, !label.isEmpty { button.accessibilityLabel = label }
            paint(button, kind: data["kind"] as? String ?? "", fill: data["fill"] as? String, ink: data["ink"] as? String)
        }
    }

    private static func symbol(_ kind: String) -> (name: String, configuration: UIImage.SymbolConfiguration) {
        let (name, size, weight): (String, CGFloat, UIImage.SymbolWeight)
        switch kind {
        case "mic": (name, size, weight) = ("mic.fill", 17, .semibold)
        case "send", "micSend": (name, size, weight) = ("arrow.up", 16, .bold)
        // a filled square reads larger than an arrow at the same point size
        case "stop": (name, size, weight) = ("stop.fill", 13, .bold)
        case "waits": (name, size, weight) = ("clock", 16, .semibold)
        case "followUp": (name, size, weight) = ("chevron.up", 15, .semibold)
        case "discard": (name, size, weight) = ("xmark", 15, .semibold)
        case "keep": (name, size, weight) = ("checkmark", 15, .bold)
        // the call is the mic's quiet twin beside it: the same disc, glyph size and weight
        case "call": (name, size, weight) = ("waveform", 17, .semibold)
        case "hangUp": (name, size, weight) = ("phone.down.fill", 15, .semibold)
        default: (name, size, weight) = ("circle", 15, .semibold)
        }
        return (name, UIImage.SymbolConfiguration(pointSize: size, weight: weight))
    }

    /// Only Send (and keeping what dictation heard) is a filled disc, in the bot's colours; every other control in the
    /// slot is a plain glyph in the page's ink. Symbol, fill and ink change together in one animation
    private func paint(_ button: UIButton, kind: String, fill: String?, ink: String?) {
        guard let slot = button as? SlotButton else { return }
        let prominent = kind == "send" || kind == "micSend" || kind == "keep"
        let fillColor = prominent ? fill.flatMap(UIColor.init(cssHex:)) ?? accent : .clear
        let inkColor = ink.flatMap(UIColor.init(cssHex:)) ?? (prominent ? .white : .label)
        let symbol = Self.symbol(kind)
        slot.show(symbol: symbol.name, configuration: symbol.configuration, fill: fillColor, ink: inkColor, animated: true)
    }

    private func configure(_ button: UIButton, kind: String, index: Int) {
        button.enumerateEventHandlers { action, _, event, _ in if let action { button.removeAction(action, for: event) } }
        button.addAction(UIAction { [weak self] _ in
            KeyboardTrace.log("button \(kind)", ["index": CGFloat(index)])
            self?.emit(["type": "button", "index": index, "kind": kind])
        }, for: .touchUpInside)
        if button is SlotButton { return }
        var config = UIButton.Configuration.plain()
        let symbol = Self.symbol(kind)
        config.cornerStyle = .capsule
        config.contentInsets = .zero
        config.preferredSymbolConfigurationForImage = symbol.configuration
        config.image = UIImage(systemName: symbol.name)
        config.symbolContentTransition = UISymbolContentTransition(UIAccessibility.isReduceMotionEnabled ? .automatic : .replace)
        config.baseForegroundColor = kind == "mic" || kind == "call" ? .secondaryLabel : kind == "hangUp" ? .systemRed : .label
        button.configuration = config
    }

    private func show(_ view: UIView, _ visible: Bool, _ shown: inout Bool) {
        guard visible != shown else {
            if visible { reassert(view) }
            return
        }
        // a view riding a page's slide goes off with it and is hidden by the first update after the slide
        if !visible && sliding { return }
        shown = visible
        if instant {
            stopFades(view)
            view.alpha = visible ? 1 : 0
            view.isHidden = !visible
            return
        }
        if visible { view.isHidden = false }
        UIView.animate(withDuration: 0.18, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
            view.alpha = visible ? 1 : 0
        } completion: { _ in
            if !visible && view.alpha == 0 { view.isHidden = true }
        }
    }

    /// The page says this view shows: whatever hid it since (an animation cut short, a view put over it) is undone.
    private func reassert(_ view: UIView) {
        guard let host else { return }
        let lost = view.superview !== host || view.isHidden || (view.alpha < 1 && view.layer.animationKeys()?.isEmpty != false)
        guard lost else { return }
        KeyboardTrace.log("reassert", ["hidden": view.isHidden ? 1 : 0, "alpha": view.alpha, "attached": view.superview === host ? 1 : 0])
        if view.superview !== host {
            host.addSubview(view)
            if view === composer { NSLayoutConstraint.activate([leading, width, height, bottom]) }
        }
        stopFades(view)
        view.isHidden = false
        view.alpha = 1
        keepOnTop()
    }

    /// Ends a view's fades, never the page slide it plays.
    private func stopFades(_ view: UIView) {
        for key in view.layer.animationKeys() ?? [] where key != Self.slideKey { view.layer.removeAnimation(forKey: key) }
    }

    // MARK: layout

    /// `animated` false when the page set the text (a send clearing it): the page re-pins the chat to the new height in
    /// the same frame, so the capsule must not spring there behind it
    private func layoutComposer(animated: Bool = true) {
        let w = width.constant
        let line = lineHeight
        let side = Self.inset + Self.disc + 10
        let actionsWidth = actionKinds.reduce(CGFloat(0)) { $0 + Self.actionWidth($1) + Self.between }
        let leadingX = plus.isHidden ? 16 : side
        let fieldWidth = max(40, w - leadingX - actionsWidth - (actions.isEmpty ? 16 : Self.inset + 2))
        let fitted = text.sizeThatFits(CGSize(width: fieldWidth, height: .greatestFiniteMagnitude)).height
        let maxText = ceil(line * Self.maxLines)
        let textHeight = min(max(line, ceil(fitted)), maxText)
        text.isScrollEnabled = fitted > maxText
        let pad = (Self.capsuleHeight - line) / 2
        let h = max(Self.capsuleHeight, textHeight + pad * 2)
        // the discs sit on the capsule's bottom edge and the field fills it: they move in the capsule's own animation, or
        // a wrapping line drops them to the new bottom at once while the capsule is still growing toward it
        let place = { [self] in
            let discY = h - Self.inset - Self.disc
            plus.frame = CGRect(x: Self.inset, y: discY, width: Self.disc, height: Self.disc)
            text.frame = CGRect(x: leadingX, y: pad, width: fieldWidth, height: h - pad * 2)
            placeholder.frame = CGRect(x: leadingX, y: pad, width: fieldWidth, height: line)
            let waveHeight: CGFloat = 20
            wave.frame = CGRect(x: leadingX, y: (h - waveHeight) / 2, width: GlassVoiceWave.width, height: waveHeight)
            let afterWave = GlassVoiceWave.width + 10
            voice.frame = CGRect(x: leadingX + afterWave, y: (h - line) / 2, width: max(0, fieldWidth - afterWave), height: line)
            var x = w - Self.inset
            for (button, kind) in zip(actions, actionKinds).reversed() {
                let bw = Self.actionWidth(kind)
                x -= bw
                button.frame = CGRect(x: x, y: discY, width: bw, height: Self.disc)
                x -= Self.between
            }
        }
        if height.constant != h {
            height.constant = h
            if animated && composerShown && host?.window != nil {
                UIView.animate(springDuration: 0.3, bounce: 0, initialSpringVelocity: 0, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
                    self.host?.layoutIfNeeded()
                    place()
                }
            } else {
                UIView.performWithoutAnimation {
                    host?.layoutIfNeeded()
                    place()
                }
            }
        } else {
            place()
        }
        if h != reportedHeight {
            reportedHeight = h
            emit(["type": "height", "height": h])
        }
    }

    private static func actionWidth(_ kind: String) -> CGFloat { kind == "followUp" ? 24 : disc }

    @objc private func contentSizeChanged() { layoutComposer() }

    @objc private func capsuleTapped() { focus() }

    // MARK: text

    /// The chat is gone (or the page reloaded): the next one's text comes with a fresh sequence, and the field starts empty.
    func resetText() {
        textSeq = 0
        if !(text.text ?? "").isEmpty {
            text.text = ""
            updatePlaceholder()
            layoutComposer(animated: false)
        }
    }

    /// The page took a send out of the field: it empties whatever it holds and whatever sequence it last took, and a
    /// guess dictation or the keyboard still had open is settled first, so it cannot land in the emptied field after.
    func clearText(id: Int) {
        let had = (text.text ?? "").count
        if text.markedTextRange != nil { text.unmarkText() }
        textSeq = max(textSeq, id)
        if !(text.text ?? "").isEmpty {
            text.text = ""
            if let font = placeholder.font {
                text.font = font
                applyFieldAttributes(font)
            }
            text.isScrollEnabled = false
            updatePlaceholder()
            layoutComposer(animated: false)
        }
        KeyboardTrace.log("clearText", ["id": CGFloat(id), "had": CGFloat(had)])
        emit(["type": "cleared", "id": id])
    }

    func setText(_ value: String, seq: Int) {
        KeyboardTrace.log("setText", ["seq": CGFloat(seq), "length": CGFloat(value.count), "stale": seq > textSeq ? 0 : 1])
        guard seq > textSeq else { return }
        textSeq = seq
        if text.text != value {
            text.text = value
            // UIKit 26: text set after a dictation keeps the attributes dictation left in the field, its font among them
            if let font = placeholder.font {
                text.font = font
                applyFieldAttributes(font)
            }
            updatePlaceholder()
            layoutComposer(animated: false)
        }
    }

    /// The field's text at the size the page draws its own: the system body size times the page's scale.
    private func applyFontScale(_ scale: CGFloat) {
        guard abs(scale - fontScale) > 0.001 else { return }
        fontScale = scale
        let font = UIFont.systemFont(ofSize: (17 * scale).rounded())
        lineHeight = (24 * scale).rounded()
        for label in [placeholder, voice] { label.adjustsFontForContentSizeCategory = false; label.font = font }
        text.adjustsFontForContentSizeCategory = false
        text.font = font
        applyFieldAttributes(font)
        layoutComposer(animated: false)
    }

    /// Lines at the page's height, the glyphs centred in each (a minimum line height alone sets them on its floor).
    private func fieldAttributes(_ font: UIFont) -> [NSAttributedString.Key: Any] {
        let paragraph = NSMutableParagraphStyle()
        paragraph.minimumLineHeight = lineHeight
        paragraph.maximumLineHeight = lineHeight
        return [.font: font, .foregroundColor: UIColor.label, .paragraphStyle: paragraph, .baselineOffset: (lineHeight - font.lineHeight) / 4]
    }

    private func applyFieldAttributes(_ font: UIFont) {
        let attributes = fieldAttributes(font)
        text.typingAttributes = attributes
        text.textStorage.setAttributes(attributes, range: NSRange(location: 0, length: text.textStorage.length))
    }

    func focus() {
        guard composerShown, text.isEditable, !listening else { return }
        text.becomeFirstResponder()
    }

    func blur() {
        if text.isFirstResponder { text.resignFirstResponder() }
    }

    private func updatePlaceholder() {
        placeholder.isHidden = !(text.text ?? "").isEmpty
    }

    func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText replacement: String) -> Bool {
        if returnSends && replacement == "\n" {
            emit(["type": "submit"])
            return false
        }
        return true
    }

    func textViewDidChange(_ textView: UITextView) {
        updatePlaceholder()
        layoutComposer()
        emit(["type": "text", "text": textView.text ?? ""])
    }

    /// UIKit asks this before the field takes focus, so the keyboard's first frame notification already knows it is ours
    func textViewShouldBeginEditing(_ textView: UITextView) -> Bool {
        fieldEditing = true
        return true
    }

    func textViewDidBeginEditing(_ textView: UITextView) { emit(["type": "focus", "focused": true]) }
    func textViewDidEndEditing(_ textView: UITextView) {
        fieldEditing = false
        emit(["type": "focus", "focused": false])
    }

    // MARK: images

    static let headerSymbols = ["back": "chevron.left", "right": "display"]
    static let headerGlyph = UIImage.SymbolConfiguration(pointSize: 17, weight: .semibold)

    /// Each header symbol as a black-on-clear png the page uses as a mask, with its size in points.
    static func glyphImages() -> [String: Any] {
        var out: [String: Any] = [:]
        for (key, name) in headerSymbols {
            guard let symbol = UIImage(systemName: name, withConfiguration: headerGlyph)?.withTintColor(.black, renderingMode: .alwaysOriginal) else { continue }
            let format = UIGraphicsImageRendererFormat.preferred()
            format.opaque = false
            let drawn = UIGraphicsImageRenderer(size: symbol.size, format: format).image { _ in symbol.draw(at: .zero) }
            guard let png = drawn.pngData() else { continue }
            out[key] = ["data": "data:image/png;base64," + png.base64EncodedString(), "w": symbol.size.width, "h": symbol.size.height]
        }
        return out
    }

    private static func image(fromDataURL url: String) -> UIImage? {
        guard let comma = url.firstIndex(of: ","), url.hasPrefix("data:image/") else { return nil }
        guard let data = Data(base64Encoded: String(url[url.index(after: comma)...])) else { return nil }
        return UIImage(data: data)
    }

    /// pixel art stays crisp: nearest neighbour, then the 30pt circle the pill shows
    private static func pixelScaled(_ image: UIImage, to size: CGSize) -> UIImage {
        let format = UIGraphicsImageRendererFormat.preferred()
        let rendered = UIGraphicsImageRenderer(size: size, format: format).image { context in
            context.cgContext.interpolationQuality = .none
            UIBezierPath(roundedRect: CGRect(origin: .zero, size: size), cornerRadius: size.width / 2).addClip()
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        return rendered.withRenderingMode(.alwaysOriginal)
    }
}

/// The desktop composer's swaps (src/styles/composer.css) in UIKit: the same curves and durations, so a turn starting
/// and ending moves the same on both. Reduce Motion keeps the fades and drops the travel.
@available(iOS 26.0, *)
private enum ComposerMotion {
    static let glyphEase = UICubicTimingParameters(controlPoint1: CGPoint(x: 0.22, y: 1), controlPoint2: CGPoint(x: 0.36, y: 1))
    static let leaveEase = UICubicTimingParameters(controlPoint1: CGPoint(x: 0.4, y: 0), controlPoint2: CGPoint(x: 1, y: 1))
    static var reduced: Bool { UIAccessibility.isReduceMotionEnabled }

    private static func run(_ duration: TimeInterval, _ timing: UITimingCurveProvider, delay: TimeInterval = 0, _ change: @escaping () -> Void, done: (() -> Void)? = nil) {
        let animator = UIViewPropertyAnimator(duration: duration, timingParameters: timing)
        animator.addAnimations(change)
        if let done { animator.addCompletion { _ in done() } }
        animator.startAnimation(afterDelay: delay)
    }

    /// composer-mic-in: the mic springs out of the round button (Send, or Stop) from 10pt toward it and .6 of its size
    /// (420ms on --composer-bounce, a few percent of give, 40ms late)
    static func micIn(_ button: UIButton) {
        button.alpha = 0
        if reduced { run(0.2, glyphEase) { button.alpha = 1 }; return }
        button.transform = CGAffineTransform(translationX: 10, y: 0).scaledBy(x: 0.6, y: 0.6)
        UIView.animate(springDuration: 0.42, bounce: 0.2, initialSpringVelocity: 0, delay: 0.04, options: [.allowUserInteraction]) {
            button.alpha = 1
            button.transform = .identity
        }
    }

    /// send arriving with the first character: m-pop, from .9 on the release spring
    static func popIn(_ button: UIButton) {
        button.alpha = 0
        if reduced { run(0.2, glyphEase) { button.alpha = 1 }; return }
        button.transform = CGAffineTransform(scaleX: 0.9, y: 0.9)
        UIView.animate(springDuration: 0.34, bounce: 0.2) { button.alpha = 1; button.transform = .identity }
    }

    /// composer-mic-out: the mic beside the round button slips back into it (150ms) as the field empties or the turn ends
    static func leave(_ button: UIButton, done: @escaping () -> Void) {
        run(0.15, leaveEase, { button.alpha = 0; if !reduced { button.transform = CGAffineTransform(translationX: 10, y: 0).scaledBy(x: 0.6, y: 0.6) } }, done: done)
    }
}

private extension UIColor {
    convenience init?(cssHex value: String) {
        var hex = value.trimmingCharacters(in: .whitespaces)
        guard hex.hasPrefix("#") else { return nil }
        hex.removeFirst()
        if hex.count == 3 { hex = hex.map { "\($0)\($0)" }.joined() }
        if hex.count == 6 { hex += "ff" }
        guard hex.count == 8, let n = UInt32(hex, radix: 16) else { return nil }
        self.init(red: CGFloat((n >> 24) & 0xff) / 255, green: CGFloat((n >> 16) & 0xff) / 255, blue: CGFloat((n >> 8) & 0xff) / 255, alpha: CGFloat(n & 0xff) / 255)
    }
}
