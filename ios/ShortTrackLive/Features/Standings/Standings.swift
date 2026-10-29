import Foundation

/// GET /standings: ISU's standings for a season (World Tour, or World Cup before 2024/25).
struct StandingsResponse: Decodable, Sendable {
    let season: String?
    /// Every season with standings, newest first.
    let seasons: [String]?
    let series: String? // "World Tour" | "World Cup"
    /// The season's stops in order; each list's `eventIndex` points here. Empty
    /// for seasons where ISU doesn't break the points down.
    let events: [StandingEvent]
    /// Points for 1st, 2nd, … in one distance at one stop; nil for World Cup seasons.
    let pointsPerPlace: [Int]?
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
    /// For each `perEvent` column, its stop in `events` (a World Cup stop sometimes raced a distance twice).
    let eventIndex: [Int]?
    let entries: [StandingEntry]

    /// Which list this is, the same in every season: "overall", "500", "nations".
    var key: String { distance ?? kind }

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

    var series: String { response.series ?? "World Tour" }

    /// "After 2 of 7 events", or "Final standings" once they're all raced.
    var progress: String {
        let count = response.events.count
        if count == 0 || racedCount == count { return count == 0 ? "Final standings" : "Final · \(count) events" }
        return "After \(racedCount) of \(count) events"
    }

    /// Points so far, one row per distance and stop.
    func pointsSoFar(for entry: StandingEntry, gender: String) -> [Earned] {
        distanceLists(gender: gender).flatMap { list -> [Earned] in
            guard let mine = list.entries.first(where: { $0.matches(entry) }) else { return [] }
            let stops = list.eventIndex ?? Array(mine.perEvent.indices)
            return zip(stops, mine.perEvent).compactMap { stop, points -> Earned? in
                guard let points, response.events.indices.contains(stop) else { return nil }
                let event = response.events[stop]
                let place = response.pointsPerPlace?.firstIndex(of: points).map { Fmt.ordinal($0 + 1) }
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
