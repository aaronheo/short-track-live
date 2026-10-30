import Foundation
import Security

/// Who's signed in, as the server reports it.
struct AccountInfo: Codable, Equatable, Sendable {
    let name: String?
    let email: String?
    let provider: String
    /// The name on leaderboards (and in chat).
    var nickname: String?
}

struct AccountSettings: Codable, Equatable, Sendable {
    var notifyStarts: Bool?
    var notifyResults: Bool?
    var notifyPicks: Bool?
    var appearance: String?
}

/// What's saved in an account: GET /me, PUT /me, and the sign-in reply (with `session`).
struct AccountState: Decodable, Sendable {
    var session: String?
    let account: AccountInfo
    let favorites: [FavoriteSkater]
    let settings: AccountSettings
}

/// The part of the phone's state an account keeps, as PUT /me takes it.
/// Equal states mean nothing needs sending.
struct SavedState: Codable, Equatable, Sendable {
    struct Favorite: Codable, Equatable, Sendable {
        let id: Int
        let addedAt: String
    }

    var favorites: [Favorite]
    var settings: AccountSettings

    init(skaters: [FavoriteSkater], settings: AccountSettings) {
        favorites = skaters.map { Favorite(id: $0.id, addedAt: Self.millis($0.addedAt)) }.sorted { $0.id < $1.id }
        self.settings = settings
    }

    /// "2026-10-20T10:00:00.123Z", rounded to the millisecond the way the
    /// server keeps it, so a date that went there and back compares equal.
    static func millis(_ date: Date) -> String {
        let ms = Int64((date.timeIntervalSince1970 * 1000).rounded())
        let base = Date(timeIntervalSince1970: TimeInterval(ms / 1000)).formatted(.iso8601).dropLast() // drop the "Z"
        return "\(base).\(String(format: "%03lld", ms % 1000))Z"
    }
}

/// Signing in with Google and keeping favorites and settings in the account.
/// Signed out, everything stays on the phone as before. Signed in, the phone
/// sends its whole state after each change and loads the account's when the
/// app opens; the last change wins.
@MainActor @Observable
final class AccountStore {
    static let shared = AccountStore()

    private(set) var account: AccountInfo? { didSet { store(account, Keys.account) } }
    private(set) var signingIn = false
    /// When this iPhone last matched the account.
    private(set) var syncedAt: Date?
    /// Shown once after signing in.
    var notice: String?
    var error: String?

    var signedIn: Bool { account != nil }

    @ObservationIgnored private let favorites: Favorites
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let api: APIClient
    /// The state last saved in the account; nil when signed out.
    @ObservationIgnored private var synced: SavedState? { didSet { store(synced, Keys.synced) } }
    @ObservationIgnored private var pending: Task<Void, Never>?

    init(favorites: Favorites = .shared, defaults: UserDefaults = .standard, api: APIClient = .shared) {
        self.favorites = favorites
        self.defaults = defaults
        self.api = api
        account = defaults.data(forKey: Keys.account).flatMap { try? JSONDecoder().decode(AccountInfo.self, from: $0) }
        synced = defaults.data(forKey: Keys.synced).flatMap { try? JSONDecoder().decode(SavedState.self, from: $0) }
        favorites.onChange = { [weak self] in self?.localChanged() }
    }

    // MARK: Signing in and out

    func signInWithGoogle() async {
        signingIn = true
        defer { signingIn = false }
        do {
            let idToken = try await GoogleSignIn().idToken()
            guard let reply = try await api.send("POST", "/auth/google", body: ["idToken": idToken], as: AccountState.self),
                  let session = reply.session else { throw APIError.status(0) }
            Keychain.session = session
            // Everything on this iPhone stays; the account's other favorites
            // join it. This iPhone's settings win.
            let added = Self.combine(local: favorites.skaters, account: reply.favorites)
            favorites.replace(with: favorites.skaters + added)
            synced = SavedState(skaters: reply.favorites, settings: reply.settings)
            account = reply.account
            notice = "Signed in. Favorites and settings are synced."
            await push()
        } catch is CancellationError {
        } catch {
            self.error = error.localizedDescription
        }
    }

    func signOut() async {
        if let session = Keychain.session {
            _ = try? await api.send("POST", "/auth/signout", account: session, as: Empty.self)
        }
        forget()
    }

    /// The session token for signed-in requests (Picks).
    var session: String? { account == nil ? nil : Keychain.session }

    /// Sets the leaderboard name. Throws APIError.refused with the server's reason (taken, not allowed).
    func setNickname(_ name: String) async throws {
        guard let session = Keychain.session else { throw APIError.signedOut }
        struct Reply: Decodable { let nickname: String }
        if let reply = try await api.send("PUT", "/me/nickname", body: ["nickname": name], account: session, as: Reply.self) {
            account?.nickname = reply.nickname
        }
    }

    /// Deletes the account and what's saved in it; this iPhone keeps its copy.
    func deleteAccount() async throws {
        guard let session = Keychain.session else { return forget() }
        do {
            _ = try await api.send("DELETE", "/me", account: session, as: Empty.self)
        } catch APIError.signedOut {}
        forget()
    }

    private func forget() {
        pending?.cancel()
        Keychain.session = nil
        synced = nil
        account = nil
        syncedAt = nil
    }

    // MARK: Syncing

    /// When the app opens: send this iPhone's changes, or load the account's.
    func sync() async {
        guard let session = Keychain.session, account != nil else { return }
        if current != synced { return await push() }
        do {
            if let state = try await api.send("GET", "/me", account: session, as: AccountState.self) { apply(state) }
        } catch APIError.signedOut {
            forget()
        } catch {
            // Offline: try again next time.
        }
    }

    /// A favorite or setting changed on this iPhone.
    func localChanged() {
        guard account != nil, current != synced else { return }
        pending?.cancel()
        pending = Task {
            try? await Task.sleep(for: .seconds(1.5))
            guard !Task.isCancelled else { return }
            await push()
        }
    }

    private func push() async {
        guard let session = Keychain.session, current != synced else { return }
        do {
            if let state = try await api.send("PUT", "/me", body: current, account: session, as: AccountState.self) { apply(state) }
        } catch APIError.signedOut {
            forget()
        } catch {
            // Stays unsent (current != synced) until the next change or opening.
        }
    }

    /// Makes this iPhone match the account.
    private func apply(_ state: AccountState) {
        let saved = SavedState(skaters: state.favorites, settings: state.settings)
        synced = saved
        account = state.account
        syncedAt = .now
        favorites.updateHelmets(from: state.favorites)
        guard current != saved else { return }
        favorites.replace(with: state.favorites)
        if let on = state.settings.notifyStarts { favorites.notifyStarts = on }
        if let on = state.settings.notifyResults { favorites.notifyResults = on }
        if let on = state.settings.notifyPicks { favorites.notifyPicks = on }
        if let mode = state.settings.appearance { defaults.set(mode, forKey: "appearance") }
    }

    /// This iPhone's favorites and settings.
    private var current: SavedState {
        SavedState(skaters: favorites.skaters, settings: AccountSettings(
            notifyStarts: favorites.notifyStarts, notifyResults: favorites.notifyResults, notifyPicks: favorites.notifyPicks,
            appearance: defaults.string(forKey: "appearance") ?? "system"))
    }

    /// The account's favorites that aren't on this iPhone yet.
    nonisolated static func combine(local: [FavoriteSkater], account: [FavoriteSkater]) -> [FavoriteSkater] {
        let here = Set(local.map(\.id))
        return account.filter { !here.contains($0.id) }
    }

    private func store<T: Encodable>(_ value: T?, _ key: String) {
        if let value { defaults.set(try? JSONEncoder().encode(value), forKey: key) } else { defaults.removeObject(forKey: key) }
    }

    private struct Empty: Decodable {}

    private enum Keys {
        static let account = "account"
        static let synced = "accountSynced"
    }
}

/// The account's session token, in the Keychain rather than UserDefaults.
enum Keychain {
    private static var query: [String: Any] { [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "com.aaronheo.shorttracklive.account",
        kSecAttrAccount as String: "session",
    ] }

    static var session: String? {
        get {
            var item: AnyObject?
            var search = query
            search[kSecReturnData as String] = true
            search[kSecMatchLimit as String] = kSecMatchLimitOne
            guard SecItemCopyMatching(search as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
            return String(data: data, encoding: .utf8)
        }
        set {
            SecItemDelete(query as CFDictionary)
            guard let newValue else { return }
            var add = query
            add[kSecValueData as String] = Data(newValue.utf8)
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            SecItemAdd(add as CFDictionary, nil)
        }
    }
}
