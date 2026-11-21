import AVFoundation
import Capacitor
import UIKit
import VisionKit

/// The pairing scanner. Given the page's words for its overlay, it shows VisionKit's DataScannerViewController full
/// screen (Apple's own highlight, guidance and pinch zoom) under a native viewfinder; otherwise, or where VisionKit
/// cannot scan, the camera draws behind the web view, which the page makes see-through while it scans. Each QR code
/// read is handed to the page.
@objc(QrScannerPlugin)
public class QrScannerPlugin: CAPPlugin, CAPBridgedPlugin, AVCaptureMetadataOutputObjectsDelegate {
    public let identifier = "QrScannerPlugin"
    public let jsName = "QrScanner"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startScan", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopScan", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isTorchAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setTorch", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setBusy", returnType: CAPPluginReturnNone)
    ]

    private struct WebViewLook {
        let isOpaque: Bool
        let backgroundColor: UIColor?
        let scrollBackgroundColor: UIColor?
    }

    private let sessionQueue = DispatchQueue(label: "bot.madani.mobile.qr-scanner")
    private var session: AVCaptureSession?
    private var device: AVCaptureDevice?
    private var previewView: UIView?
    private var webViewLook: WebViewLook?
    private weak var fullScreen: UIViewController?

    private func cameraState() -> String {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return "granted"
        case .denied, .restricted: return "denied"
        default: return "prompt"
        }
    }

    @objc override public func checkPermissions(_ call: CAPPluginCall) {
        call.resolve(["camera": cameraState()])
    }

    @objc override public func requestPermissions(_ call: CAPPluginCall) {
        AVCaptureDevice.requestAccess(for: .video) { [weak self] _ in
            call.resolve(["camera": self?.cameraState() ?? "denied"])
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

    @objc func startScan(_ call: CAPPluginCall) {
        guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
            call.reject("camera permission was not granted")
            return
        }
        if #available(iOS 16.0, *), let overlay = ScanOverlay(call.getObject("overlay")) {
            sessionQueue.async { [weak self] in
                self?.stopSession()
                DispatchQueue.main.async {
                    guard let self else { return }
                    guard DataScannerViewController.isSupported, DataScannerViewController.isAvailable else {
                        self.startCameraSession(call)
                        return
                    }
                    self.presentFullScreen(overlay, call: call)
                }
            }
            return
        }
        startCameraSession(call)
    }

    @available(iOS 16.0, *)
    private func presentFullScreen(_ overlay: ScanOverlay, call: CAPPluginCall) {
        guard var top = bridge?.viewController else { call.reject("no screen to scan on"); return }
        while let next = top.presentedViewController { top = next }
        let scanner = PairScannerViewController(overlay: overlay)
        scanner.onCode = { [weak self] text in self?.notifyListeners("codeScanned", data: ["text": text]) }
        scanner.onAction = { [weak self] key in self?.notifyListeners("scannerAction", data: ["key": key]) }
        scanner.modalPresentationStyle = .fullScreen
        scanner.modalTransitionStyle = .crossDissolve
        fullScreen = scanner
        top.present(scanner, animated: true) { call.resolve(["fullScreen": true]) }
    }

    @objc func setBusy(_ call: CAPPluginCall) {
        let busy = call.getBool("busy") ?? false
        let label = call.getString("label")
        DispatchQueue.main.async { [weak self] in
            guard #available(iOS 16.0, *), let scanner = self?.fullScreen as? PairScannerViewController else { return }
            scanner.setBusy(busy, label: label)
        }
    }

    private func startCameraSession(_ call: CAPPluginCall) {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            self.stopSession()
            guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) ?? AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: camera) else {
                call.reject("this device has no camera to scan with")
                return
            }
            let session = AVCaptureSession()
            let output = AVCaptureMetadataOutput()
            guard session.canAddInput(input), session.canAddOutput(output) else {
                call.reject("the camera could not be set up")
                return
            }
            session.beginConfiguration()
            session.addInput(input)
            session.addOutput(output)
            guard output.availableMetadataObjectTypes.contains(.qr) else {
                session.commitConfiguration()
                call.reject("this camera cannot read QR codes")
                return
            }
            output.metadataObjectTypes = [.qr]
            output.setMetadataObjectsDelegate(self, queue: DispatchQueue.main)
            session.commitConfiguration()
            self.session = session
            self.device = camera
            DispatchQueue.main.sync { self.showPreview(for: session) }
            session.startRunning()
            call.resolve()
        }
    }

    @objc func stopScan(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let scanner = self?.fullScreen else { return }
            self?.fullScreen = nil
            scanner.dismiss(animated: true)
        }
        sessionQueue.async { [weak self] in
            self?.stopSession()
            call.resolve()
        }
    }

    @objc func isTorchAvailable(_ call: CAPPluginCall) {
        sessionQueue.async { [weak self] in
            // the full screen scanner has its own torch button
            call.resolve(["available": self?.fullScreen == nil && (self?.device?.hasTorch ?? false)])
        }
    }

    @objc func setTorch(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? false
        sessionQueue.async { [weak self] in
            guard let camera = self?.device, camera.hasTorch else {
                call.reject("no torch")
                return
            }
            do {
                try camera.lockForConfiguration()
                camera.torchMode = on ? .on : .off
                camera.unlockForConfiguration()
                call.resolve()
            } catch {
                call.reject("the torch could not be changed")
            }
        }
    }

    public func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        for object in metadataObjects {
            guard let code = object as? AVMetadataMachineReadableCodeObject, code.type == .qr, let text = code.stringValue else { continue }
            notifyListeners("codeScanned", data: ["text": text])
        }
    }

    /// Runs on the session queue.
    private func stopSession() {
        if let camera = device, camera.hasTorch, camera.torchMode != .off, (try? camera.lockForConfiguration()) != nil {
            camera.torchMode = .off
            camera.unlockForConfiguration()
        }
        session?.stopRunning()
        session = nil
        device = nil
        DispatchQueue.main.sync { self.hidePreview() }
    }

    private func showPreview(for session: AVCaptureSession) {
        guard let webView = bridge?.webView, let host = webView.superview else { return }
        let view = UIView(frame: host.bounds)
        view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.backgroundColor = .black
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.addSublayer(layer)
        host.insertSubview(view, belowSubview: webView)
        previewView = view
        webViewLook = WebViewLook(isOpaque: webView.isOpaque, backgroundColor: webView.backgroundColor, scrollBackgroundColor: webView.scrollView.backgroundColor)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
    }

    private func hidePreview() {
        previewView?.removeFromSuperview()
        previewView = nil
        guard let webView = bridge?.webView, let look = webViewLook else { return }
        webView.isOpaque = look.isOpaque
        webView.backgroundColor = look.backgroundColor
        webView.scrollView.backgroundColor = look.scrollBackgroundColor
        webViewLook = nil
    }
}

/// The page's words for the full screen scanner.
struct ScanOverlay {
    struct Action { let key: String; let title: String; let icon: String? }
    let title: String
    let hint: String
    let close: String
    let torch: String
    let actions: [Action]

    init?(_ value: JSObject?) {
        guard let value, let title = value["title"] as? String else { return nil }
        self.title = title
        hint = value["hint"] as? String ?? ""
        close = value["close"] as? String ?? "Close"
        torch = value["torch"] as? String ?? "Torch"
        actions = (value["actions"] as? [JSObject] ?? []).compactMap { d in
            guard let key = d["key"] as? String, let title = d["title"] as? String else { return nil }
            return Action(key: key, title: title, icon: d["icon"] as? String)
        }
    }
}

/// VisionKit's scanner under a large rounded viewfinder that recognition is limited to, with glass buttons.
@available(iOS 16.0, *)
final class PairScannerViewController: UIViewController, DataScannerViewControllerDelegate {
    var onCode: ((String) -> Void)?
    var onAction: ((String) -> Void)?

    private let overlay: ScanOverlay
    private let scanner = DataScannerViewController(
        recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced, recognizesMultipleItems: false,
        isHighFrameRateTrackingEnabled: false, isPinchToZoomEnabled: true, isGuidanceEnabled: true, isHighlightingEnabled: true)
    private let dim = CAShapeLayer()
    private let corners = CAShapeLayer()
    private let busyView = UIView()
    private let busyLabel = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let torchButton = PairScannerViewController.glassButton()
    private var box = CGRect.zero
    private var seen = Set<String>()
    private var busy = false
    private var torchOn = false
    private static let radius: CGFloat = 44

    init(overlay: ScanOverlay) {
        self.overlay = overlay
        super.init(nibName: nil, bundle: nil)
        overrideUserInterfaceStyle = .dark
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        addChild(scanner)
        scanner.view.frame = view.bounds
        scanner.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(scanner.view)
        scanner.didMove(toParent: self)
        scanner.delegate = self

        let host = scanner.overlayContainerView
        dim.fillRule = .evenOdd
        dim.fillColor = UIColor(red: 6 / 255, green: 8 / 255, blue: 14 / 255, alpha: 0.64).cgColor
        host.layer.addSublayer(dim)
        corners.fillColor = UIColor.clear.cgColor
        corners.strokeColor = UIColor.white.cgColor
        corners.lineWidth = 3.5
        corners.lineCap = .round
        host.layer.addSublayer(corners)

        busyView.backgroundColor = UIColor(red: 10 / 255, green: 12 / 255, blue: 20 / 255, alpha: 0.55)
        busyView.layer.cornerRadius = Self.radius
        busyView.layer.cornerCurve = .continuous
        busyView.alpha = 0
        busyLabel.font = .systemFont(ofSize: 15, weight: .medium)
        busyLabel.textColor = .white
        spinner.color = .white
        let busyStack = UIStackView(arrangedSubviews: [spinner, busyLabel])
        busyStack.axis = .vertical
        busyStack.alignment = .center
        busyStack.spacing = 12
        busyStack.translatesAutoresizingMaskIntoConstraints = false
        busyView.addSubview(busyStack)
        NSLayoutConstraint.activate([busyStack.centerXAnchor.constraint(equalTo: busyView.centerXAnchor), busyStack.centerYAnchor.constraint(equalTo: busyView.centerYAnchor)])
        host.addSubview(busyView)

        let close = Self.glassButton()
        close.configuration?.image = UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .semibold))
        close.accessibilityLabel = overlay.close
        close.addAction(UIAction { [weak self] _ in self?.onAction?("close") }, for: .touchUpInside)
        torchButton.accessibilityLabel = overlay.torch
        torchButton.isHidden = !(AVCaptureDevice.default(for: .video)?.hasTorch ?? false)
        torchButton.addAction(UIAction { [weak self] _ in self?.toggleTorch() }, for: .touchUpInside)
        refreshTorch()
        let top = UIStackView(arrangedSubviews: [close, UIView(), torchButton])
        top.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(top)

        let title = UILabel()
        title.text = overlay.title
        title.font = .systemFont(ofSize: 19, weight: .semibold)
        title.textColor = .white
        title.textAlignment = .center
        title.numberOfLines = 0
        let hint = UILabel()
        hint.text = overlay.hint
        hint.font = .systemFont(ofSize: 15)
        hint.textColor = UIColor.white.withAlphaComponent(0.65)
        hint.textAlignment = .center
        hint.numberOfLines = 0
        let words = UIStackView(arrangedSubviews: [title, hint])
        words.axis = .vertical
        words.spacing = 6
        let buttons = UIStackView(arrangedSubviews: overlay.actions.map { action in
            let button = Self.glassButton()
            button.configuration?.title = action.title
            button.configuration?.image = action.icon.flatMap { UIImage(systemName: $0, withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .medium)) }
            button.configuration?.imagePadding = 8
            button.configuration?.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16)
            button.addAction(UIAction { [weak self] _ in self?.onAction?(action.key) }, for: .touchUpInside)
            button.heightAnchor.constraint(equalToConstant: 44).isActive = true
            return button
        })
        buttons.spacing = 10
        let bottom = UIStackView(arrangedSubviews: [words, buttons])
        bottom.axis = .vertical
        bottom.alignment = .center
        bottom.spacing = 20
        bottom.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(bottom)

        let guide = host.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            close.widthAnchor.constraint(equalToConstant: 44), close.heightAnchor.constraint(equalToConstant: 44),
            torchButton.widthAnchor.constraint(equalToConstant: 44), torchButton.heightAnchor.constraint(equalToConstant: 44),
            top.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 16),
            top.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -16),
            top.topAnchor.constraint(equalTo: guide.topAnchor, constant: 8),
            bottom.leadingAnchor.constraint(greaterThanOrEqualTo: guide.leadingAnchor, constant: 24),
            bottom.trailingAnchor.constraint(lessThanOrEqualTo: guide.trailingAnchor, constant: -24),
            bottom.centerXAnchor.constraint(equalTo: guide.centerXAnchor),
            bottom.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -24),
        ])
    }

    private static func glassButton() -> UIButton {
        var config: UIButton.Configuration
        if #available(iOS 26.0, *) { config = .glass() } else { config = .gray() }
        config.cornerStyle = .capsule
        config.baseForegroundColor = .white
        return UIButton(configuration: config)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let bounds = scanner.overlayContainerView.bounds
        let side = max(240, min(bounds.width - 56, 360)).rounded()
        box = CGRect(x: (bounds.width - side) / 2, y: bounds.height * 0.44 - side / 2, width: side, height: side)
        let path = UIBezierPath(rect: bounds)
        path.append(UIBezierPath(roundedRect: box, cornerRadius: Self.radius))
        dim.path = path.cgPath
        dim.frame = bounds
        corners.path = Self.cornerPath(box, radius: Self.radius, length: 20).cgPath
        corners.frame = bounds
        busyView.frame = box
        scanner.regionOfInterest = box
    }

    /// the viewfinder's four rounded corners, each running a little past its curve
    private static func cornerPath(_ r: CGRect, radius: CGFloat, length: CGFloat) -> UIBezierPath {
        let path = UIBezierPath()
        let reach = radius + length
        path.move(to: CGPoint(x: r.minX, y: r.minY + reach))
        path.addArc(withCenter: CGPoint(x: r.minX + radius, y: r.minY + radius), radius: radius, startAngle: .pi, endAngle: .pi * 1.5, clockwise: true)
        path.addLine(to: CGPoint(x: r.minX + reach, y: r.minY))
        path.move(to: CGPoint(x: r.maxX - reach, y: r.minY))
        path.addArc(withCenter: CGPoint(x: r.maxX - radius, y: r.minY + radius), radius: radius, startAngle: .pi * 1.5, endAngle: 0, clockwise: true)
        path.addLine(to: CGPoint(x: r.maxX, y: r.minY + reach))
        path.move(to: CGPoint(x: r.maxX, y: r.maxY - reach))
        path.addArc(withCenter: CGPoint(x: r.maxX - radius, y: r.maxY - radius), radius: radius, startAngle: 0, endAngle: .pi / 2, clockwise: true)
        path.addLine(to: CGPoint(x: r.maxX - reach, y: r.maxY))
        path.move(to: CGPoint(x: r.minX + reach, y: r.maxY))
        path.addArc(withCenter: CGPoint(x: r.minX + radius, y: r.maxY - radius), radius: radius, startAngle: .pi / 2, endAngle: .pi, clockwise: true)
        path.addLine(to: CGPoint(x: r.minX, y: r.maxY - reach))
        return path
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if !busy { try? scanner.startScanning() }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        scanner.stopScanning()
        if torchOn { setTorch(false) }
    }

    func setBusy(_ on: Bool, label: String?) {
        guard on != busy else { return }
        busy = on
        busyLabel.text = label
        if on { spinner.startAnimating(); scanner.stopScanning() } else { spinner.stopAnimating(); try? scanner.startScanning() }
        UIView.animate(withDuration: 0.16) { self.busyView.alpha = on ? 1 : 0 }
    }

    private func toggleTorch() {
        UISelectionFeedbackGenerator().selectionChanged()
        setTorch(!torchOn)
    }

    /// DataScannerViewController has no torch of its own; the camera device takes the change while it runs
    private func setTorch(_ on: Bool) {
        guard let camera = AVCaptureDevice.default(for: .video), camera.hasTorch, (try? camera.lockForConfiguration()) != nil else { return }
        camera.torchMode = on ? .on : .off
        camera.unlockForConfiguration()
        torchOn = on
        refreshTorch()
    }

    private func refreshTorch() {
        torchButton.configuration?.image = UIImage(systemName: torchOn ? "flashlight.on.fill" : "flashlight.off.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .semibold))
        torchButton.accessibilityTraits = torchOn ? [.button, .selected] : .button
    }

    func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
        guard !busy else { return }
        for case .barcode(let code) in addedItems {
            guard let text = code.payloadStringValue, !seen.contains(text) else { continue }
            seen.insert(text)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            onCode?(text)
            return
        }
    }
}
