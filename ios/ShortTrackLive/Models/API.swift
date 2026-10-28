import Foundation

// Mirrors the server's API contract (server/src/api/views.ts). The server does
// the shaping, so these are plain decodable values.

enum EventState: String, Decodable, Sendable {
    case upcoming, live, finished
}

enum HeatState: String, Decodable, Sendable {
    case scheduled
    case startList = "start_list"
    case running, unofficial, official

    var isFinished: Bool { self == .unofficial || self == .official }
}

// MARK: - Events

struct EventSummary: Decodable, Hashable, Sendable, Identifiable {
    let slug: String
    let name: String
    let shortName: String
    let series: String?
    let city: String?
    let countryName: String?
    let iso2: String?
    let startsOn: String // yyyy-MM-dd, venue dates
    let endsOn: String
    let state: EventState

    var id: String { slug }
}

struct OnTheIce: Decodable, Hashable, Sendable {
    let roundId: Int
    let competition: String
    let round: String
    let heat: String?
    let lap: String?
}

/// The live event: an `EventSummary` plus where the event is at.
struct LiveEvent: Decodable, Hashable, Sendable {
    let event: EventSummary
    let day: Int
    let days: Int
    let onTheIce: OnTheIce?

    private enum CodingKeys: String, CodingKey { case day, days, onTheIce }

    init(from decoder: any Decoder) throws {
        event = try EventSummary(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        day = try c.decode(Int.self, forKey: .day)
        days = try c.decode(Int.self, forKey: .days)
        onTheIce = try c.decodeIfPresent(OnTheIce.self, forKey: .onTheIce)
    }
}

struct EventsResponse: Decodable, Sendable {
    let season: String
    let seasons: [String]
    let live: LiveEvent?
    let events: [EventSummary]
}

// MARK: - Schedule

struct ScheduleItem: Decodable, Hashable, Sendable, Identifiable {
    let id: Int
    let roundId: Int?
    let startsAt: Date
    let venueTime: String
    let title: String
    let round: String
    let state: EventState
    let isFinal: Bool
    let liveDetail: String?
}

struct ScheduleResponse: Decodable, Sendable {
    struct Event: Decodable, Sendable {
        let summary: EventSummary
        let timeZone: String

        private enum CodingKeys: String, CodingKey { case timeZone }

        init(from decoder: any Decoder) throws {
            summary = try EventSummary(from: decoder)
            timeZone = try decoder.container(keyedBy: CodingKeys.self).decode(String.self, forKey: .timeZone)
        }
    }

    struct Day: Decodable, Sendable, Identifiable, Hashable {
        let key: String
        let label: String
        let live: Bool
        let items: [ScheduleItem]

        var id: String { key }
    }

    let event: Event
    let days: [Day]
}

// MARK: - Round

struct Entry: Decodable, Hashable, Sendable, Identifiable {
    let id: Int
    let rank: Int?
    let name: String
    let last: String
    let nat: String?
    let iso2: String?
    let startPosition: Int?
    let time: String?
    let gap: String?
    let status: String?
    let badge: String?
    let lastLap: String?
    let laps: Int
    /// Relays, on the heat screen: who skated for the team (ISU names them once it's raced).
    var members: [RelayMember]? = nil
}

struct RelayMember: Decodable, Hashable, Sendable, Identifiable {
    let id: Int
    let name: String
    /// Surname, or "J. Van 't Wout" when two in the team share one.
    let short: String
}

struct HeatBlock: Decodable, Hashable, Sendable, Identifiable {
    struct Lap: Decodable, Hashable, Sendable {
        let current: Int
        let total: Int?
    }

    struct Qualifier: Decodable, Hashable, Sendable {
        let last: String
        let iso2: String?
        let badge: String
    }

    let id: Int
    let name: String
    let state: HeatState
    let runOrder: Int?
    let startsAt: Date?
    let lap: Lap?
    let qualified: [Qualifier]
    let sanctions: String?
    let entries: [Entry]
}

struct PlacesCard: Decodable, Hashable, Sendable {
    struct Skater: Decodable, Hashable, Sendable {
        let last: String
        let nat: String?
        let iso2: String?
    }

    struct Qualified: Decodable, Hashable, Sendable {
        let count: Int
        let total: Int?
        let skaters: [Skater]
    }

    struct TimeRow: Decodable, Hashable, Sendable {
        enum Kind: String, Decodable, Sendable { case advanced, `in`, out, open }

        let kind: Kind
        let pos: String
        let last: String?
        let nat: String?
        let iso2: String?
        let heat: String?
        let time: String?
        let badge: String?
    }

    struct TimeSpots: Decodable, Hashable, Sendable {
        let label: String
        let filled: Int
        let total: Int
        let note: String
        let rows: [TimeRow]
    }

    let title: String
    let rule: String?
    let qualified: Qualified
    let time: TimeSpots?
}

struct RoundResponse: Decodable, Sendable {
    struct Round: Decodable, Sendable {
        let id: Int
        let name: String
        let competition: String
        let state: EventState
        let startsAt: Date?
        let venueTime: String?
        let isRelay: Bool
    }

    struct Event: Decodable, Sendable {
        let slug: String
        let name: String
        let timeZone: String
    }

    struct Sibling: Decodable, Hashable, Sendable, Identifiable {
        let id: Int
        let name: String
        let current: Bool
    }

    struct Progress: Decodable, Hashable, Sendable {
        let finished: Int
        let total: Int
        let running: Int?
    }

    let round: Round
    let event: Event
    let siblings: [Sibling]
    let progress: Progress
    let places: PlacesCard?
    let heats: [HeatBlock]
}

// MARK: - Heat

struct HeatResponse: Decodable, Sendable {
    struct Heat: Decodable, Sendable {
        let id: Int
        let name: String
        let state: HeatState
        let roundId: Int
        let round: String
        let competition: String
        let event: String
        let isRelay: Bool
    }

    struct Chart: Decodable, Sendable {
        struct Series: Decodable, Hashable, Sendable {
            let last: String
            /// Three letters, as on TV ("NAD"); unique within the race.
            let code: String?
            let iso2: String?
            let positions: [Int?]

            /// What winner and climber name: the code, or the surname from an older server.
            var key: String { code ?? last }
        }

        let laps: Int
        let series: [Series]
        let winner: String?
        let climber: String?
    }

    struct LapTable: Decodable, Sendable {
        struct Column: Decodable, Hashable, Sendable {
            let last: String
            let iso2: String?
        }

        struct Cell: Decodable, Hashable, Sendable {
            let time: String?
            let best: Bool
            let fastest: Bool
        }

        struct Row: Decodable, Hashable, Sendable, Identifiable {
            let lap: Int
            let cells: [Cell]

            var id: Int { lap }
        }

        let columns: [Column]
        let rows: [Row]
    }

    let heat: Heat
    let results: [Entry]
    let summary: [String]
    let chart: Chart?
    let lapTable: LapTable?
    let notes: [String]
}

// MARK: - Decoding

extension JSONDecoder {
    /// The server sends ISO 8601 with milliseconds ("2026-10-23T16:12:00.000Z").
    static let api: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            if let date = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(text) { return date }
            if let date = try? Date.ISO8601FormatStyle().parse(text) { return date }
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Bad date \(text)"))
        }
        return decoder
    }()
}

// MARK: - Athletes

struct AthleteHit: Decodable, Hashable, Sendable, Identifiable {
    let id: Int
    let name: String
    let last: String
    let nat: String?
    let iso2: String?
    let gender: String?
    let races: Int
}

struct AthleteSearchResponse: Decodable, Sendable {
    let query: String
    let results: [AthleteHit]
}

struct AthleteResponse: Decodable, Sendable {
    struct Athlete: Decodable, Sendable {
        let id: Int
        let name: String
        let first: String?
        let last: String
        let nat: String?
        let iso2: String?
        let gender: String?
    }

    struct Stats: Decodable, Sendable {
        let races: Int
        let events: Int
        let gold: Int
        let silver: Int
        let bronze: Int
        let since: String? // yyyy-MM-dd, the first event we have for them
    }

    struct Best: Decodable, Hashable, Sendable, Identifiable {
        let distance: String
        let time: String
        let event: String
        let round: String
        let heatId: Int

        var id: String { distance }
    }

    let athlete: Athlete
    let stats: Stats
    let bests: [Best]
}

struct AthleteRace: Decodable, Hashable, Sendable, Identifiable {
    struct Event: Decodable, Hashable, Sendable {
        let slug: String
        let name: String
        let city: String?
        let startsOn: String
        let endsOn: String
    }

    let entryId: Int
    let heatId: Int
    let roundId: Int
    let season: String
    let event: Event
    let distance: String
    let round: String
    let day: String
    let startsAt: Date
    let rank: Int?
    let time: String?
    let badge: String?
    let status: String?
    let medal: Int?
    let team: String?

    var id: Int { entryId }
}

struct RaceFacet: Decodable, Hashable, Sendable, Identifiable {
    let value: String
    let label: String
    let count: Int
    let season: String? // events only

    var id: String { value }
}

struct RaceFacets: Decodable, Sendable {
    let seasons: [RaceFacet]
    let events: [RaceFacet]
    let distances: [RaceFacet]
}

struct RacesResponse: Decodable, Sendable {
    let total: Int?
    let races: [AthleteRace]
    let nextCursor: String?
    let facets: RaceFacets?
}

// MARK: - Favorites

/// GET /favorites/races?skaters=…: the favorites' races around now, with the
/// notification text for each.
struct FavoriteRacesResponse: Decodable, Sendable {
    let races: [FavoriteRace]
}

struct FavoriteRace: Decodable, Sendable, Equatable {
    struct Text: Decodable, Sendable, Equatable {
        let title: String
        let body: String
    }

    let heatId: Int
    let roundId: Int
    let event: String
    /// Planned start until the heat is raced, then the actual start.
    let startsAt: Date?
    let state: String
    /// The next heat on the ice at a live event, due within a few minutes.
    let upNext: Bool
    /// The favorites in it.
    let skaters: [Int]
    let start: Text
    /// Once the heat is official.
    let result: Text?
}

/// GET /favorites/suggested: the latest event's medalists.
struct SuggestedSkatersResponse: Decodable, Sendable {
    struct Skater: Decodable, Sendable, Identifiable {
        let id: Int
        let name: String
        let last: String
        let nat: String?
        let iso2: String?
        let gender: String?
        let note: String // "Gold 500, 1000 and 1500 m"
    }

    let event: String?
    let skaters: [Skater]
}
