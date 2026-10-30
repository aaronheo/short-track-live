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
    /// This season's helmet number, as of the last account sync or when starred.
    var helmet: Int? = nil
}

/// Favorite skaters and which notifications to get about them.
@MainActor @Observable
final class Favorites {
    static let shared = Favorites()

    private(set) var skaters: [FavoriteSkater]
    var notifyStarts: Bool { didSet { defaults.set(notifyStarts, forKey: Keys.starts); onChange?() } }
    var notifyResults: Bool { didSet { defaults.set(notifyResults, forKey: Keys.results); onChange?() } }
    /// When races open for picks (signed in only).
    var notifyPicks: Bool { didSet { defaults.set(notifyPicks, forKey: Keys.picks); onChange?() } }
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
        notifyPicks = defaults.object(forKey: Keys.picks) as? Bool ?? true
        askedAboutNotifications = defaults.bool(forKey: Keys.asked)
    }

    func contains(_ id: Int) -> Bool { skaters.contains { $0.id == id } }

    func add(id: Int, name: String, last: String, nat: String?, iso2: String?, gender: String?, helmet: Int?) {
        guard !contains(id) else { return }
        skaters.append(FavoriteSkater(id: id, name: name, last: last, nat: nat, iso2: iso2, gender: gender, addedAt: .now, helmet: helmet))
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

    /// The account's helmet numbers for these skaters (they change each season).
    /// Not a change to send back, so no onChange.
    func updateHelmets(from list: [FavoriteSkater]) {
        let helmets = Dictionary(list.map { ($0.id, $0.helmet) }, uniquingKeysWith: { a, _ in a })
        let updated = skaters.map { skater in
            var skater = skater
            if let helmet = helmets[skater.id] { skater.helmet = helmet }
            return skater
        }
        guard updated != skaters else { return }
        skaters = updated
        defaults.set(try? JSONEncoder().encode(skaters), forKey: Keys.skaters)
    }

    private func save() {
        defaults.set(try? JSONEncoder().encode(skaters), forKey: Keys.skaters)
        onChange?()
    }

    private enum Keys {
        static let skaters = "favoriteSkaters"
        static let starts = "notifyRaceStarts"
        static let results = "notifyRaceResults"
        static let picks = "notifyPicksOpen"
        static let asked = "askedAboutNotifications"
    }
}
