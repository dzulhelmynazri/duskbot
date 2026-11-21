import Capacitor
import PhotosUI
import UIKit
import UniformTypeIdentifiers

/// Files the app hands the page: each written to its own folder in tmp and described by its file URL, name and type,
/// which the page reads back through the web view's file scheme.
enum PickedFiles {
    private static func folder() -> URL? {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("madani-picks", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        do { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) } catch { return nil }
        return dir
    }

    static func describe(_ url: URL, type: String? = nil) -> [String: Any] {
        let mime = type ?? UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        return ["path": url.absoluteString, "name": url.lastPathComponent, "type": mime]
    }

    static func write(_ data: Data, name: String, type: String) -> [String: Any]? {
        guard let dir = folder() else { return nil }
        let url = dir.appendingPathComponent(name)
        do { try data.write(to: url) } catch { return nil }
        return describe(url, type: type)
    }

    static func copy(_ source: URL) -> [String: Any]? {
        guard let dir = folder() else { return nil }
        let url = dir.appendingPathComponent(source.lastPathComponent)
        do { try FileManager.default.copyItem(at: source, to: url) } catch { return nil }
        return describe(url)
    }

    /// A picture as the page can show it anywhere: PNG, GIF and JPEG stay as they are; HEIC and the rest become JPEG,
    /// as Safari's own file input does.
    static func image(_ image: UIImage, index: Int) -> [String: Any]? {
        guard let data = image.jpegData(compressionQuality: 0.9) else { return nil }
        return write(data, name: "image-\(index + 1).jpg", type: "image/jpeg")
    }

    /// The images on the pasteboard, PNG kept as PNG.
    static func pasteboardImages(_ board: UIPasteboard = .general) -> [[String: Any]] {
        var out: [[String: Any]] = []
        for (index, item) in board.items.enumerated() {
            if let png = item[UTType.png.identifier] as? Data, let file = write(png, name: "pasted-\(index + 1).png", type: "image/png") { out.append(file); continue }
            if let gif = item[UTType.gif.identifier] as? Data, let file = write(gif, name: "pasted-\(index + 1).gif", type: "image/gif") { out.append(file); continue }
            if let jpeg = item[UTType.jpeg.identifier] as? Data, let file = write(jpeg, name: "pasted-\(index + 1).jpg", type: "image/jpeg") { out.append(file); continue }
            let picture = item.values.lazy.compactMap { value -> UIImage? in
                if let image = value as? UIImage { return image }
                if let data = value as? Data { return UIImage(data: data) }
                return nil
            }.first
            if let picture, let data = picture.jpegData(compressionQuality: 0.9), let file = write(data, name: "pasted-\(index + 1).jpg", type: "image/jpeg") { out.append(file) }
        }
        return out
    }
}

/// A plain text field that also takes a pasted picture: UIKit offers Paste in a plain UITextView only for text, so a
/// copied photo could never reach the chat. The pictures go to `onPasteImages`; text pastes as before.
final class PastingTextView: UITextView {
    var onPasteImages: (([[String: Any]]) -> Void)?

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)), onPasteImages != nil, UIPasteboard.general.hasImages { return true }
        return super.canPerformAction(action, withSender: sender)
    }

    override func paste(_ sender: Any?) {
        let board = UIPasteboard.general
        if let onPasteImages, board.hasImages, !board.hasStrings {
            let files = PickedFiles.pasteboardImages(board)
            if !files.isEmpty { onPasteImages(files); return }
        }
        super.paste(sender)
    }
}

/// The composer's + choices opened straight on their own system picker: the photo library on PHPicker, Files on the
/// document picker. A web file input on iOS always asks first (take a photo, the library or Files), even with `accept`.
@objc(PickerPlugin)
public class PickerPlugin: CAPPlugin, CAPBridgedPlugin, PHPickerViewControllerDelegate, UIDocumentPickerDelegate {
    public let identifier = "PickerPlugin"
    public let jsName = "MadaniPicker"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "photos", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "files", returnType: CAPPluginReturnPromise),
    ]

    private var pending: CAPPluginCall?

    private func begin(_ call: CAPPluginCall) {
        pending?.resolve(["files": []])
        pending = call
    }

    private func finish(_ files: [[String: Any]]) {
        pending?.resolve(["files": files])
        pending = nil
    }

    @objc func photos(_ call: CAPPluginCall) {
        begin(call)
        let multiple = call.getBool("multiple") ?? true
        DispatchQueue.main.async { [weak self] in
            guard let self, let presenter = self.bridge?.viewController else { self?.finish([]); return }
            var config = PHPickerConfiguration()
            config.selectionLimit = multiple ? 10 : 1
            config.filter = .any(of: [.images, .videos])
            config.preferredAssetRepresentationMode = .compatible
            let picker = PHPickerViewController(configuration: config)
            picker.delegate = self
            presenter.present(picker, animated: true)
        }
    }

    @objc func files(_ call: CAPPluginCall) {
        begin(call)
        let multiple = call.getBool("multiple") ?? true
        DispatchQueue.main.async { [weak self] in
            guard let self, let presenter = self.bridge?.viewController else { self?.finish([]); return }
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
            picker.allowsMultipleSelection = multiple
            picker.delegate = self
            presenter.present(picker, animated: true)
        }
    }

    public func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard !results.isEmpty else { finish([]); return }
        var files = [[String: Any]?](repeating: nil, count: results.count)
        let lock = NSLock()
        let put = { (index: Int, file: [String: Any]?) in lock.lock(); files[index] = file; lock.unlock() }
        let group = DispatchGroup()
        for (index, result) in results.enumerated() {
            let provider = result.itemProvider
            group.enter()
            let kept = [UTType.png, UTType.gif, UTType.jpeg, UTType.movie, UTType.mpeg4Movie, UTType.quickTimeMovie]
                .first { type in provider.registeredTypeIdentifiers.contains(type.identifier) }
            if let kept {
                provider.loadFileRepresentation(forTypeIdentifier: kept.identifier) { url, _ in
                    if let url { put(index, PickedFiles.copy(url)) }
                    group.leave()
                }
            } else if provider.canLoadObject(ofClass: UIImage.self) {
                provider.loadObject(ofClass: UIImage.self) { object, _ in
                    if let image = object as? UIImage { put(index, PickedFiles.image(image, index: index)) }
                    group.leave()
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) {
                provider.loadFileRepresentation(forTypeIdentifier: UTType.movie.identifier) { url, _ in
                    if let url { put(index, PickedFiles.copy(url)) }
                    group.leave()
                }
            } else {
                group.leave()
            }
        }
        group.notify(queue: .main) { [weak self] in self?.finish(files.compactMap { $0 }) }
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        finish(urls.compactMap { PickedFiles.copy($0) })
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        finish([])
    }
}
