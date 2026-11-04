import UIKit

/// Server push: the phone gives the server its APNs token with its favorites
/// and notification switches, and the server sends "up next", results and
/// "Picks are open" the moment they happen. While the server says it's
/// pushing, RaceAlerts leaves those alerts to it; otherwise (no APNs key on
/// the server, or no token yet) the phone keeps doing them itself.
@MainActor
final class PushRegistration {
    static let shared = PushRegistration()

    private let defaults = UserDefaults.standard
    /// The APNs token, hex.
    private(set) var token: String? {
        get { defaults.string(forKey: Keys.token) }
        set { defaults.set(newValue, forKey: Keys.token) }
    }
    /// The server has this phone's current state and sends its alerts.
    var active: Bool { defaults.bool(forKey: Keys.active) }

    /// Asks iOS for a token; it arrives in the app delegate.
    func register() {
        UIApplication.shared.registerForRemoteNotifications()
    }

    /// True when it's a new token (first launch, or after a restore).
    func received(_ deviceToken: Data) -> Bool {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        guard hex != token else { return false }
        token = hex
        return true
    }

    /// Sends the phone's state when it changed, or once a day. Returns whether the server pushes.
    @discardableResult
    func update(_ favorites: Favorites, allowed: Bool) async -> Bool {
        guard allowed else { return false }
        guard let token else {
            register()
            return false
        }
        let body = Body(
            environment: Self.environment,
            favorites: favorites.skaters.map { .init(id: $0.id, addedAt: $0.addedAt) },
            notifyStarts: favorites.notifyStarts, notifyResults: favorites.notifyResults, notifyPicks: favorites.notifyPicks,
            signedIn: Keychain.session != nil)
        let fingerprint = (try? JSONEncoder.api.encode(body)).map { "\(token):\($0.base64EncodedString())" }
        if fingerprint == defaults.string(forKey: Keys.sent),
           let at = defaults.object(forKey: Keys.sentAt) as? Date, Date.now.timeIntervalSince(at) < 86400 {
            return active
        }
        do {
            let reply = try await APIClient.shared.send("PUT", "/devices/\(token)", body: body, account: Keychain.session, as: Reply.self)
            defaults.set(reply?.push ?? false, forKey: Keys.active)
            defaults.set(fingerprint, forKey: Keys.sent)
            defaults.set(Date.now, forKey: Keys.sentAt)
        } catch {
            // Server unreachable: keep what we had. A stale state is only a day old at most.
        }
        return active
    }

    /// Builds Xcode installs (Debug or Release) carry a development profile and
    /// get the sandbox's tokens; TestFlight builds have no embedded profile and
    /// get production's.
    static let environment: String = {
        #if targetEnvironment(simulator)
        return "sandbox"
        #endif
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url) else { return "production" }
        let text = String(decoding: data, as: UTF8.self).replacingOccurrences(of: "\\s", with: "", options: .regularExpression)
        return text.contains("<key>aps-environment</key><string>development</string>") ? "sandbox" : "production"
    }()

    private struct Body: Encodable, Sendable {
        struct Favorite: Encodable, Sendable { let id: Int; let addedAt: Date }
        let environment: String
        let favorites: [Favorite]
        let notifyStarts: Bool
        let notifyResults: Bool
        let notifyPicks: Bool
        /// Not read by the server; signing in or out changes the fingerprint so the account link is re-sent.
        let signedIn: Bool
    }

    private struct Reply: Decodable, Sendable { let push: Bool }

    private enum Keys {
        static let token = "pushToken"
        static let active = "pushActive"
        static let sent = "pushSent"
        static let sentAt = "pushSentAt"
    }
}

/// Hands the APNs token to PushRegistration.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // No prompt: the token comes regardless, and alerts show only once notifications are allowed.
        application.registerForRemoteNotifications()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        if PushRegistration.shared.received(deviceToken) { Task { await RaceAlerts.shared.check() } }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {}
}
