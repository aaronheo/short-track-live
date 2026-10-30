import Foundation

/// GET /picks: the Picks tab for the live (or next) event.
struct PicksHome: Decodable, Sendable {
    struct Event: Decodable, Sendable { let slug: String; let name: String; let city: String?; let state: String }
    struct Me: Decodable, Sendable { let points: Int; let picked: Int; let rank: Int? }
    struct Leader: Decodable, Sendable, Hashable { let rank: Int; let nickname: String; let points: Int; let me: Bool }

    let signedIn: Bool
    let nickname: String?
    let event: Event?
    /// Races still open to pick, soonest first.
    let open: [PickSummary]
    /// Your picks at this event, latest first.
    let mine: [PickSummary]
    let me: Me?
    let players: Int
    let leaderboard: [Leader]
}

struct PickSummary: Decodable, Sendable, Hashable, Identifiable {
    let heatId: Int
    let title: String // "Women 1000 m"
    let race: String // "Semifinal · Heat 2", "Final A"
    let round: String? // "Semifinals"
    let startsAt: Date?
    let state: String // scheduled | start_list | running | unofficial | official
    let picked: Bool
    let points: Int?
    let max: Int?

    var id: Int { heatId }
}

/// The finishing order and penalties someone picked (entry ids).
struct PickChoice: Codable, Sendable, Hashable {
    var finish: [Int]
    var penalized: [Int]
}

/// GET /picks/heats/:id
struct PickHeat: Decodable, Sendable {
    struct Entry: Decodable, Sendable, Hashable, Identifiable {
        let entryId: Int
        let name: String
        let last: String
        let nat: String?
        let iso2: String?
        let start: Int?
        var helmet: Int? = nil
        var id: Int { entryId }
    }

    struct Cut: Decodable, Sendable, Hashable { let after: Int; let label: String }

    struct Crowd: Decodable, Sendable {
        struct EntryShare: Decodable, Sendable, Hashable {
            let entryId: Int
            /// % who put them 1st, 2nd, …
            let places: [Int]
            /// % who picked a penalty.
            let penalized: Int
        }
        struct Most: Decodable, Sendable { let finish: [Int]; let penalized: [Int]; let share: Int }
        let picks: Int
        let entries: [EntryShare]
        let mostPicked: Most?
    }

    struct Result: Decodable, Sendable {
        struct Entry: Decodable, Sendable, Hashable { let entryId: Int; let rank: Int?; let status: String?; let time: String? }
        struct Score: Decodable, Sendable {
            struct Line: Decodable, Sendable, Hashable { let entryId: Int; let picked: Int?; let points: Int }
            let points: Int
            let max: Int
            let entries: [Line]
        }
        let entries: [Entry]
        let score: Score?
    }

    let heatId: Int
    let event: String
    let title: String
    let race: String
    let startsAt: Date?
    let state: String
    /// Picks close when the race starts.
    let locked: Bool
    let cut: Cut?
    /// Start order.
    let entries: [Entry]
    let myPick: PickChoice?
    let crowd: Crowd?
    let result: Result?

    func entry(_ id: Int) -> Entry? { entries.first { $0.entryId == id } }

    /// Your pick, or the start order to begin from.
    var startingChoice: PickChoice {
        myPick ?? PickChoice(finish: entries.map(\.entryId), penalized: [])
    }
}

/// How the crowd's picks read for one skater: the most picked outcome.
struct CrowdLine: Hashable, Sendable {
    let entryId: Int
    /// 1-based place, or nil for a penalty.
    let top: Int?
    let topShare: Int
    /// % per place, then the penalty share last.
    let shares: [Int]

    init(_ share: PickHeat.Crowd.EntryShare) {
        entryId = share.entryId
        shares = share.places + [share.penalized]
        let best = shares.enumerated().max { $0.element < $1.element || ($0.element == $1.element && $0.offset > $1.offset) }!
        top = best.offset == share.places.count ? nil : best.offset + 1
        topShare = best.element
    }
}

extension Fmt {
    /// "1st", or "Penalty".
    static func pickPlace(_ place: Int?) -> String { place.map(ordinal) ?? "Penalty" }
}
