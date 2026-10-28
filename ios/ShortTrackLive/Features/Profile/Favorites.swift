import SwiftUI

/// A skater you follow. Kept on the phone, and in the account when signed in
/// (AccountStore); race checks send only the ids.
struct FavoriteSkater: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    let name: String
    let last: String
    let nat: String?
    let iso2: String?
    let gender: String?
    /// Notifications only cover races after this.
    let addedAt: Date
}

/// Favorite skaters and which notifications to get about them.
@MainActor @Observable
final class Favorites {
    static let shared = Favorites()

    private(set) var skaters: [FavoriteSkater]
    var notifyStarts: Bool { didSet { defaults.set(notifyStarts, forKey: Keys.starts); onChange?() } }
    var notifyResults: Bool { didSet { defaults.set(notifyResults, forKey: Keys.results); onChange?() } }
    /// The first star asks about notifications, once.
    var askedAboutNotifications: Bool { didSet { defaults.set(askedAboutNotifications, forKey: Keys.asked) } }

    @ObservationIgnored private let defaults: UserDefaults
    /// Called after favorites or the notification switches change (AccountStore saves them).
    @ObservationIgnored var onChange: (() -> Void)?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        skaters = defaults.data(forKey: Keys.skaters).flatMap { try? JSONDecoder().decode([FavoriteSkater].self, from: $0) } ?? []
        notifyStarts = defaults.object(forKey: Keys.starts) as? Bool ?? true
        notifyResults = defaults.object(forKey: Keys.results) as? Bool ?? true
        askedAboutNotifications = defaults.bool(forKey: Keys.asked)
    }

    func contains(_ id: Int) -> Bool { skaters.contains { $0.id == id } }

    func add(id: Int, name: String, last: String, nat: String?, iso2: String?, gender: String?) {
        guard !contains(id) else { return }
        skaters.append(FavoriteSkater(id: id, name: name, last: last, nat: nat, iso2: iso2, gender: gender, addedAt: .now))
        save()
    }

    func remove(_ id: Int) {
        skaters.removeAll { $0.id == id }
        save()
    }

    /// The account's list, after signing in or when it changed on another device.
    func replace(with list: [FavoriteSkater]) {
        skaters = list
        save()
    }

    private func save() {
        defaults.set(try? JSONEncoder().encode(skaters), forKey: Keys.skaters)
        onChange?()
    }

    private enum Keys {
        static let skaters = "favoriteSkaters"
        static let starts = "notifyRaceStarts"
        static let results = "notifyRaceResults"
        static let asked = "askedAboutNotifications"
    }
}
