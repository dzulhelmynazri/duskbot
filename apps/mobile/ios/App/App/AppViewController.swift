import Capacitor
import UIKit
import WebKit

/// The screen's root view: the web view fills it and the app's native layers (glass chrome, camera) sit beside it.
/// Inside WKWebView, UIKit and WebKit add views of their own after ours (iOS 26's scroll edge pocket at the top), which
/// can cover a layer and take its touches.
final class WebContainerView: UIView {}

/// The page's web view. The chat's keyboard lifts it whole with a transform, inside the keyboard's own animation, so
/// WebKit never lays the page out again mid-move. While lifted it keeps its resting safe area: UIKit may report the moved
/// frame's insets, and WebKit would lay the page out again for them.
final class PageWebView: WKWebView {
    private var restingSafeArea: UIEdgeInsets?

    override var safeAreaInsets: UIEdgeInsets { restingSafeArea ?? super.safeAreaInsets }

    var keyboardLift: CGFloat = 0 {
        didSet {
            if keyboardLift > 0, restingSafeArea == nil { restingSafeArea = super.safeAreaInsets }
            transform = keyboardLift > 0 ? CGAffineTransform(translationX: 0, y: -keyboardLift) : .identity
        }
    }

    /// Back at rest, once the move down has finished: the safe area follows the screen again.
    func landed() {
        guard keyboardLift <= 0, let resting = restingSafeArea else { return }
        restingSafeArea = nil
        if super.safeAreaInsets != resting { safeAreaInsetsDidChange() }
    }
}

extension CAPBridgeProtocol {
    /// Where the app's native layers go: the container round the web view, or the web view itself before it has one.
    var nativeHost: UIView? {
        guard let web = webView else { return nil }
        return web.superview as? WebContainerView ?? web
    }
}

class AppViewController: CAPBridgeViewController {
    /// Only a remote screen the person is viewing turns sideways; the rest of the app stays portrait.
    var landscapeAllowed = false {
        didSet {
            guard landscapeAllowed != oldValue else { return }
            setNeedsUpdateOfSupportedInterfaceOrientations()
            if !landscapeAllowed { rotate(to: .portrait) }
        }
    }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        landscapeAllowed ? .allButUpsideDown : .portrait
    }

    /// Turns the app even with the system's portrait lock on, as a viewer's rotate button asks.
    func rotate(to mask: UIInterfaceOrientationMask) {
        guard let scene = view.window?.windowScene else { return }
        scene.requestGeometryUpdate(.iOS(interfaceOrientations: mask)) { _ in }
    }

    override open func webView(with frame: CGRect, configuration: WKWebViewConfiguration) -> WKWebView {
        PageWebView(frame: frame, configuration: configuration)
    }

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(QrScannerPlugin())
        bridge?.registerPluginInstance(AppleSignInPlugin())
        bridge?.registerPluginInstance(SpeechRecognizerPlugin())
        bridge?.registerPluginInstance(GlassChromePlugin())
        bridge?.registerPluginInstance(NativeMenuPlugin())
        bridge?.registerPluginInstance(OrientationPlugin())
        bridge?.registerPluginInstance(TurnActivityPlugin())
        bridge?.registerPluginInstance(PhoneNotificationsPlugin())
        bridge?.registerPluginInstance(MadaniHapticsPlugin())
        bridge?.registerPluginInstance(PickerPlugin())
        // iOS 26 gives the web view's scroll view a top edge effect that draws a pale band under the status bar; the
        // page scrolls inside itself, so the effect never tracks its content
        if #available(iOS 26.0, *) {
            webView?.scrollView.topEdgeEffect.isHidden = true
            webView?.scrollView.bottomEdgeEffect.isHidden = true
        }
    }

    /// Capacitor makes the web view the controller's view (its loadView is final). Put it in a container instead, so a
    /// context menu interaction can watch it from outside (one on WKWebView itself fights the page's touch events) and
    /// native layers can stack above it.
    override open func viewDidLoad() {
        super.viewDidLoad()
        guard let web = webView, view === web else { return }
        let root = WebContainerView(frame: web.frame)
        root.backgroundColor = web.backgroundColor
        root.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        web.frame = root.bounds
        web.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        root.addSubview(web)
        view = root
    }
}

@objc(OrientationPlugin)
public class OrientationPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "OrientationPlugin"
    public let jsName = "MadaniOrientation"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "allowLandscape", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "rotate", returnType: CAPPluginReturnPromise),
    ]

    @objc func allowLandscape(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? false
        DispatchQueue.main.async {
            (self.bridge?.viewController as? AppViewController)?.landscapeAllowed = on
            call.resolve()
        }
    }

    @objc func rotate(_ call: CAPPluginCall) {
        let landscape = call.getString("to") == "landscape"
        DispatchQueue.main.async {
            guard let controller = self.bridge?.viewController as? AppViewController else { return call.resolve() }
            if landscape { controller.landscapeAllowed = true }
            controller.rotate(to: landscape ? .landscapeRight : .portrait)
            call.resolve()
        }
    }
}
