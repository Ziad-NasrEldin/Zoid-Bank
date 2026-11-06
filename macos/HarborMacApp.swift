import SwiftUI
import WebKit
import AppKit

private let dashboardURL = URL(string: "harbor://app/index.html?variant=overview")!
private let mainWindowFrameDefaultsKey = "ZoidBank.MainWindowFrame"
private let localStorageDefaultsKey = "ZoidBank.LocalStorage"
private let legacyLedgerStorageKey = "harbor.test-ledger.v1"
private let mirroredStorageKeys: Set<String> = [
    "harbor.manual-recurring.v1",
    "harbor.dismissed-recurring.v1",
    "harbor.sidebar-collapsed.v1",
    "harbor.display-currency.v1",
    "harbor.fx-rates.v1"
]

private func isMirroredStorageKey(_ key: String) -> Bool {
    mirroredStorageKeys.contains(key)
}

@main
struct HarborMacApp: App {
    @NSApplicationDelegateAdaptor(HarborAppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup("Zoid Bank") {
            HarborWindow()
                .frame(minWidth: 1100, minHeight: 720)
        }
        .defaultSize(width: 1100, height: 720)
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(replacing: .appInfo) {
                Button("About Zoid Bank") { NSApplication.shared.orderFrontStandardAboutPanel(nil) }
            }
        }
        Settings {
            SettingsView()
        }
    }
}

struct HarborWindow: View {
    var body: some View {
        HarborWebView(url: dashboardURL)
            .ignoresSafeArea(.container, edges: .top)
            .background(Color(nsColor: .windowBackgroundColor))
    }
}

final class HarborAppDelegate: NSObject, NSApplicationDelegate {
    private var windowObserver: NSObjectProtocol?

    func applicationDidFinishLaunching(_ notification: Notification) {
        ensureBridgeRunning()

        windowObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didBecomeKeyNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let window = notification.object as? NSWindow,
                  window.title == "Zoid Bank" else { return }
            self?.configureMainWindow(window)
        }

        DispatchQueue.main.async { [weak self] in
            NSApplication.shared.windows
                .filter { $0.title == "Zoid Bank" }
                .forEach { self?.configureMainWindow($0) }
        }
    }

    private func ensureBridgeRunning() {
        let healthURL = URL(string: "http://127.0.0.1:4317/health")!
        var request = URLRequest(url: healthURL)
        request.timeoutInterval = 0.8
        URLSession.shared.dataTask(with: request) { _, response, error in
            if error != nil || (response as? HTTPURLResponse)?.statusCode != 200 {
                let uid = getuid()
                let process = Process()
                process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
                process.arguments = ["kickstart", "-k", "gui/\(uid)/com.harbor.local-bridge"]
                try? process.run()
            }
        }.resume()
    }

    func applicationWillTerminate(_ notification: Notification) {
        WindowFramePersistence.saveAll()
    }

    deinit {
        if let windowObserver {
            NotificationCenter.default.removeObserver(windowObserver)
        }
    }

    private func configureMainWindow(_ window: NSWindow) {
        window.styleMask.insert(.fullSizeContentView)
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        WindowFramePersistence.configure(window)
    }
}

private enum WindowFramePersistence {
    private static var configuredWindows = Set<ObjectIdentifier>()
    private static var observers = [ObjectIdentifier: [NSObjectProtocol]]()

    static func configure(_ window: NSWindow) {
        let windowID = ObjectIdentifier(window)
        guard configuredWindows.insert(windowID).inserted else { return }

        if let savedFrame = savedFrame(), isUsable(savedFrame) {
            window.setFrame(savedFrame, display: true)
        }

        let center = NotificationCenter.default
        observers[windowID] = [
            center.addObserver(forName: NSWindow.didMoveNotification, object: window, queue: .main) { _ in
                save(window)
            },
            center.addObserver(forName: NSWindow.didResizeNotification, object: window, queue: .main) { _ in
                save(window)
            },
        ]
        save(window)
    }

    static func saveAll() {
        NSApplication.shared.windows
            .filter { $0.title == "Zoid Bank" }
            .forEach { save($0) }
    }

    private static func save(_ window: NSWindow) {
        UserDefaults.standard.set(NSStringFromRect(window.frame), forKey: mainWindowFrameDefaultsKey)
    }

    private static func savedFrame() -> NSRect? {
        guard let value = UserDefaults.standard.string(forKey: mainWindowFrameDefaultsKey) else { return nil }
        return NSRectFromString(value)
    }

    private static func isUsable(_ frame: NSRect) -> Bool {
        guard frame.width >= 1100, frame.height >= 720 else { return false }
        return NSScreen.screens.contains { $0.visibleFrame.intersects(frame) }
    }
}

struct HarborWebView: NSViewRepresentable {
    let url: URL

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        context.coordinator.storageBridge.install(on: configuration.userContentController)
        configuration.setURLSchemeHandler(HarborSchemeHandler(), forURLScheme: "harbor")
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.allowsBackForwardNavigationGestures = true
        view.setValue(false, forKey: "drawsBackground")
        view.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        if context.coordinator.currentURL != url {
            context.coordinator.currentURL = url
            view.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(url: url) }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var currentURL: URL
        let storageBridge = HarborStorageBridge()

        init(url: URL) {
            self.currentURL = url
        }

        func webView(
            _ webView: WKWebView,
            runJavaScriptConfirmPanelWithMessage message: String,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping (Bool) -> Void
        ) {
            guard let window = webView.window else {
                completionHandler(false)
                return
            }

            let alert = NSAlert()
            alert.messageText = "Confirm action"
            alert.informativeText = message
            alert.alertStyle = .warning
            alert.addButton(withTitle: "Confirm")
            alert.addButton(withTitle: "Cancel")
            alert.beginSheetModal(for: window) { response in
                completionHandler(response == .alertFirstButtonReturn)
            }
        }
    }
}

final class HarborStorageBridge: NSObject, WKScriptMessageHandler {
    private let messageHandlerName = "harborStorage"

    func install(on controller: WKUserContentController) {
        controller.add(self, name: messageHandlerName)
        controller.addUserScript(WKUserScript(
            source: restorationScript(),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == messageHandlerName,
              message.frameInfo.request.url?.scheme == "harbor",
              let payload = message.body as? [String: Any],
              let operation = payload["operation"] as? String else { return }

        var savedValues = (UserDefaults.standard.dictionary(forKey: localStorageDefaultsKey) as? [String: String] ?? [:])
            .filter { isMirroredStorageKey($0.key) }

        switch operation {
        case "set":
            guard let key = payload["key"] as? String,
                  isMirroredStorageKey(key),
                  let value = payload["value"] as? String else { return }
            savedValues[key] = value
        case "remove":
            guard let key = payload["key"] as? String,
                  isMirroredStorageKey(key) else { return }
            savedValues.removeValue(forKey: key)
        case "clear":
            savedValues.removeAll()
        default:
            return
        }

        UserDefaults.standard.set(savedValues, forKey: localStorageDefaultsKey)
    }

    private func restorationScript() -> String {
        let allSavedValues = (UserDefaults.standard.dictionary(forKey: localStorageDefaultsKey) as? [String: String] ?? [:])
        let savedValues = allSavedValues.filter { isMirroredStorageKey($0.key) }
        let legacyLedgerValue: Any = allSavedValues[legacyLedgerStorageKey] ?? NSNull()

        let ledgerFileURL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Zoid Bank/ledger.json")
        var seedLedgerString: String = "null"
        if let fileData = try? Data(contentsOf: ledgerFileURL),
           let fileString = String(data: fileData, encoding: .utf8),
           !fileString.isEmpty {
            seedLedgerString = fileString
        } else if let legacyData = try? JSONSerialization.data(withJSONObject: legacyLedgerValue, options: .fragmentsAllowed),
                  let str = String(data: legacyData, encoding: .utf8) {
            seedLedgerString = str
        }
        let encodedLegacyLedger = seedLedgerString

        guard let data = try? JSONSerialization.data(withJSONObject: savedValues),
              let encodedValues = String(data: data, encoding: .utf8) else { return "" }

        return """
        (() => {
          const savedValues = \(encodedValues);
          const legacyLedger = \(encodedLegacyLedger);
          if (legacyLedger && legacyLedger !== 'null' && !window.localStorage.getItem('\(legacyLedgerStorageKey)')) {
            const rawSeed = typeof legacyLedger === 'string' ? legacyLedger : JSON.stringify(legacyLedger);
            // Migrate the pre-file ledger into the web cache once so the dashboard can reconcile it into the authoritative file.
            window.localStorage.setItem('\(legacyLedgerStorageKey)', rawSeed);
          }
          for (const [key, value] of Object.entries(savedValues)) {
            window.localStorage.setItem(key, value);
          }

          const nativeHandler = window.webkit?.messageHandlers?.harborStorage;
          if (!nativeHandler) return;
          const mirroredKeys = new Set([
            'harbor.manual-recurring.v1',
            'harbor.dismissed-recurring.v1',
            'harbor.sidebar-collapsed.v1',
            'harbor.display-currency.v1',
            'harbor.fx-rates.v1'
          ]);

          const originalSetItem = Storage.prototype.setItem;
          const originalRemoveItem = Storage.prototype.removeItem;
          const originalClear = Storage.prototype.clear;

          Storage.prototype.setItem = function(key, value) {
            originalSetItem.call(this, key, value);
            if (this === window.localStorage && mirroredKeys.has(String(key))) {
              nativeHandler.postMessage({ operation: 'set', key: String(key), value: String(value) });
            }
          };

          Storage.prototype.removeItem = function(key) {
            originalRemoveItem.call(this, key);
            if (this === window.localStorage && mirroredKeys.has(String(key))) {
              nativeHandler.postMessage({ operation: 'remove', key: String(key) });
            }
          };

          Storage.prototype.clear = function() {
            originalClear.call(this);
            if (this === window.localStorage) {
              nativeHandler.postMessage({ operation: 'clear' });
            }
          };
        })();
        """
    }
}

final class HarborSchemeHandler: NSObject, WKURLSchemeHandler {
    private let root = Bundle.main.resourceURL?.appendingPathComponent("dist")

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let requestURL = urlSchemeTask.request.url,
              let root,
              !requestURL.pathComponents.contains("..") else {
            urlSchemeTask.didFailWithError(NSError(domain: "Harbor", code: 1))
            return
        }
        let relativePath = requestURL.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let requestedFile = relativePath.isEmpty ? "index.html" : relativePath
        let fileURL = root.appendingPathComponent(requestedFile)
        do {
            let data = try Data(contentsOf: fileURL)
            let response = URLResponse(url: requestURL, mimeType: mimeType(for: fileURL), expectedContentLength: data.count, textEncodingName: "utf-8")
            urlSchemeTask.didReceive(response)
            urlSchemeTask.didReceive(data)
            urlSchemeTask.didFinish()
        } catch {
            urlSchemeTask.didFailWithError(error)
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

    private func mimeType(for url: URL) -> String {
        switch url.pathExtension.lowercased() {
        case "css": return "text/css"
        case "js": return "text/javascript"
        case "svg": return "image/svg+xml"
        case "json": return "application/json"
        default: return "text/html"
        }
    }
}

struct SettingsView: View {
    var body: some View {
        Form {
            Section("Local source") {
                Label("Apple Messages database", systemImage: "message.fill")
                Text("Zoid Bank reads approved Bank Al Ahly and Banque Misr alerts locally. It does not send, edit, mark read, delete, or upload messages.")
                    .foregroundStyle(.secondary)
            }
            Section("Dashboard") {
                Text("The native shell opens the compiled local Zoid Bank dashboard on port 4180.")
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .frame(width: 420, height: 240)
        .padding()
    }
}
