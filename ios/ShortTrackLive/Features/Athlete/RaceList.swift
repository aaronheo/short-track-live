import SwiftUI

/// An athlete's races, a page at a time (infinite scroll), for the current
/// filters and sort. Changing either starts over from the first page.
@MainActor @Observable
final class RaceList {
    struct Filters: Equatable {
        var season: String? // "2025/2026"
        var event: String? // slug
        var distance: String? // "500", "1000", "1500", "relay"

        var isEmpty: Bool { season == nil && event == nil && distance == nil }
    }

    let athleteID: Int
    var filters = Filters() { didSet { if filters != oldValue { restart() } } }
    var oldestFirst = false { didSet { if oldestFirst != oldValue { restart() } } }

    private(set) var races: [AthleteRace] = []
    private(set) var total: Int?
    /// Menu options with counts; kept while a new first page loads so menus don't flicker.
    private(set) var facets: RaceFacets?
    private(set) var nextCursor: String?
    private(set) var loading = false
    private(set) var error: (any Error)?
    private(set) var loadedFirstPage = false
    /// Bumped when filters or sort change; the screen reloads on it
    /// (`.task(id: generation)`), and pages from an older one are dropped.
    private(set) var generation = 0

    @ObservationIgnored private let client: APIClient

    init(athleteID: Int, client: APIClient = .shared) {
        self.athleteID = athleteID
        self.client = client
    }

    var hasMore: Bool { nextCursor != nil }

    /// Races grouped under each event, in list order.
    var groups: [(event: AthleteRace.Event, races: [AthleteRace])] {
        var result: [(event: AthleteRace.Event, races: [AthleteRace])] = []
        for race in races {
            if let last = result.last, last.event.slug == race.event.slug {
                result[result.count - 1].races.append(race)
            } else {
                result.append((race.event, [race]))
            }
        }
        return result
    }

    func loadFirstPage() async {
        guard !loadedFirstPage, !loading else { return }
        await load(cursor: nil, generation: generation)
    }

    func retry() async {
        if loadedFirstPage { await loadMore() } else { await loadFirstPage() }
    }

    func loadMore() async {
        guard let cursor = nextCursor, !loading else { return }
        await load(cursor: cursor, generation: generation)
    }

    func refresh() async {
        restart()
        await loadFirstPage()
    }

    private func restart() {
        generation += 1
        races = []
        total = nil
        nextCursor = nil
        loadedFirstPage = false
        loading = false
        error = nil
    }

    private func load(cursor: String?, generation: Int) async {
        guard generation == self.generation else { return }
        if cursor == nil && loadedFirstPage { return }
        loading = true
        var query = [URLQueryItem(name: "sort", value: oldestFirst ? "asc" : "desc"), URLQueryItem(name: "limit", value: "30")]
        if let season = filters.season { query.append(URLQueryItem(name: "season", value: season)) }
        if let event = filters.event { query.append(URLQueryItem(name: "event", value: event)) }
        if let distance = filters.distance { query.append(URLQueryItem(name: "distance", value: distance)) }
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        do {
            let page = try await client.get("athletes/\(athleteID)/races", query: query, cached: false, as: RacesResponse.self)
            // A newer filter or sort started meanwhile: this page is for the old one.
            guard generation == self.generation, let page else { return }
            withAnimation(.snappy) {
                if cursor == nil {
                    races = page.races
                    total = page.total
                    if let facets = page.facets { self.facets = facets }
                    loadedFirstPage = true
                } else {
                    races += page.races
                }
                nextCursor = page.nextCursor
            }
            error = nil
        } catch is CancellationError {
        } catch let err as URLError where err.code == .cancelled {
        } catch {
            if generation == self.generation { self.error = error }
        }
        if generation == self.generation { loading = false }
    }
}
