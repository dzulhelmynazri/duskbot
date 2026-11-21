import UIKit

/// The composer's live waveform while dictation listens, as the page's VoiceWaveform draws it: 2pt bars 2pt apart that
/// scroll in from the right at the voice's loudness, quick to rise and slower to fall. Without a level yet a low steady
/// pulse says it is listening; with Reduce Motion the bars stand still and only their strength follows the voice.
final class GlassVoiceWave: UIView {
    static let width: CGFloat = 48
    private static let bar: CGFloat = 2
    private static let step: CGFloat = 4
    private static let sampleEvery: CFTimeInterval = 0.06

    private let shape = CAShapeLayer()
    private var link: CADisplayLink?
    private var bars: [CGFloat] = []
    private var target: CGFloat = 0
    private var level: CGFloat = 0
    private var heard = false
    private var started: CFTimeInterval = 0
    private var lastSample: CFTimeInterval = 0

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        layer.addSublayer(shape)
        NotificationCenter.default.addObserver(self, selector: #selector(levelArrived(_:)), name: .madaniSpeechLevel, object: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    deinit { link?.invalidate() }

    override func layoutSubviews() {
        super.layoutSubviews()
        shape.frame = bounds
        let count = Int(ceil(bounds.width / Self.step)) + 2
        if bars.count < count { bars = Array(repeating: 0, count: count - bars.count) + bars }
        else if bars.count > count { bars = Array(bars.suffix(count)) }
    }

    override func tintColorDidChange() {
        super.tintColorDidChange()
        shape.fillColor = tintColor.cgColor
    }

    var running: Bool { link != nil }

    func start() {
        guard link == nil else { return }
        heard = false
        target = 0
        level = 0
        bars = bars.map { _ in 0 }
        started = CACurrentMediaTime()
        lastSample = started
        shape.fillColor = tintColor.cgColor
        let link = CADisplayLink(target: self, selector: #selector(frame(_:)))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 60, preferred: 60)
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    func stop() {
        link?.invalidate()
        link = nil
    }

    @objc private func levelArrived(_ note: Notification) {
        guard let value = (note.userInfo?["level"] as? NSNumber)?.doubleValue else { return }
        heard = true
        target = max(target, CGFloat(value))
    }

    @objc private func frame(_ link: CADisplayLink) {
        let now = link.targetTimestamp
        if !heard { target = 0.12 + 0.06 * CGFloat(sin((now - started) / 0.26)) }
        level += (target - level) * (target > level ? 0.55 : 0.18)
        target *= 0.82
        if now - lastSample >= Self.sampleEvery, !bars.isEmpty {
            lastSample = now
            bars.removeFirst()
            bars.append(level)
        }
        draw(now: now)
    }

    private func draw(now: CFTimeInterval) {
        let reduced = UIAccessibility.isReduceMotionEnabled
        let width = bounds.width, height = bounds.height
        guard width > 0, height > 0 else { return }
        let glide = reduced ? 0 : CGFloat(min(1, (now - lastSample) / Self.sampleEvery)) * Self.step
        let path = UIBezierPath()
        for (index, raw) in bars.enumerated() {
            let value = reduced ? 0.3 + 0.12 * CGFloat(sin(Double(index) * 1.7)) : raw
            let barHeight = max(Self.bar, min(height, value * height * 1.25))
            let x = width - CGFloat(bars.count - index) * Self.step + Self.step - glide
            if x < -Self.bar || x > width { continue }
            path.append(UIBezierPath(roundedRect: CGRect(x: x, y: (height - barHeight) / 2, width: Self.bar, height: barHeight), cornerRadius: Self.bar / 2))
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        shape.opacity = reduced ? Float(0.35 + 0.65 * min(1, level * 1.4)) : 1
        shape.path = path.cgPath
        CATransaction.commit()
    }
}
