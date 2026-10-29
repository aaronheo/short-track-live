import Foundation

/// GET /standings: ISU's World Tour standings for a season.
struct StandingsResponse: Decodable, Sendable {
    let season: String?
    /// The season's World Tour stops in order; every `perEvent` follows it.
    let events: [StandingEvent]
    /// Points for 1st, 2nd, … in one distance at one stop.
    let pointsPerPlace: [Int]
    let lists: [StandingList]
}

struct StandingEvent: Decodable, Sendable, Hashable {
    let code: String // "CAN1"
    let name: String // "World Tour #1"
    let city: String?
    let slug: String?
    let raced: Bool
}

struct StandingList: Decodable, Sendable, Identifiable, Hashable {
    let id: Int
    let kind: String // overall | distance | nations
    let gender: String // Men | Women | Mixed
    let distance: String? // 500 | 1000 | 1500 | relay | mixed
    let title: String // "Crystal Globe", "500 m", "Relay", "Mixed relay", "Nations"
    let entries: [StandingEntry]

    var isTeams: Bool { kind == "nations" || distance == "relay" || distance == "mixed" }
}

struct StandingEntry: Decodable, Sendable, Hashable, Identifiable {
    let rank: Int
    let points: Int
    /// Our skater; nil for teams.
    let skaterId: Int?
    let name: String
    let last: String
    let nat: String?
    let iso2: String?
    let perEvent: [Int?]

    var id: String { skaterId.map(String.init) ?? "\(nat ?? "")-\(name)" }
}

/// What the Standings screens show, worked out from one response.
struct StandingsBook: Sendable {
    let response: StandingsResponse

    /// The chips for one category: its own lists, then the mixed relay and nations.
    func lists(for gender: String) -> [StandingList] {
        response.lists.filter { $0.gender == gender } + response.lists.filter { $0.gender == "Mixed" }
    }

    var racedCount: Int { response.events.filter(\.raced).count }

    /// Points so far, one row per distance and stop.
    func pointsSoFar(for entry: StandingEntry, gender: String) -> [Earned] {
        distanceLists(gender: gender).flatMap { list -> [Earned] in
            guard let mine = list.entries.first(where: { $0.matches(entry) }) else { return [] }
            return zip(response.events, mine.perEvent).compactMap { event, points -> Earned? in
                guard let points else { return nil }
                let place = response.pointsPerPlace.firstIndex(of: points).map { Fmt.ordinal($0 + 1) }
                return Earned(distance: list.title, place: place, event: [event.name, event.city].compactMap { $0 }.joined(separator: ", "),
                              points: points)
            }
        }
    }

    private func distanceLists(gender: String) -> [StandingList] {
        response.lists.filter { $0.gender == gender && $0.kind == "distance" && ["500", "1000", "1500"].contains($0.distance ?? "") }
    }

    struct Earned: Hashable, Sendable {
        let distance: String // "1000 m"
        let place: String? // "5th"
        let event: String // "World Tour #1, Vancouver"
        let points: Int
    }
}

extension StandingEntry {
    func matches(_ other: StandingEntry) -> Bool {
        if let skaterId, let otherId = other.skaterId { return skaterId == otherId }
        return name == other.name && nat == other.nat
    }
}
