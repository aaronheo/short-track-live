import Foundation
import Testing
@testable import ShortTrackLive

/// What a check of the favorites' races posts, schedules and marks done.
struct AlertPlanTests {
    let now = Date(timeIntervalSince1970: 1_793_000_000)
    let added: [Int: Date] = [251: Date(timeIntervalSince1970: 1_792_000_000)]

    func race(_ heat: Int, in minutes: Double, state: String = "start_list", upNext: Bool = false,
              result: String? = nil, skaters: [Int] = [251]) -> FavoriteRace {
        FavoriteRace(heatId: heat, roundId: 1, event: "wt2", startsAt: now.addingTimeInterval(minutes * 60), state: state,
                     upNext: upNext, skaters: skaters, start: .init(title: "Jens Van 't Wout is up next", body: "Men 500 m Heat 4"),
                     result: result.map { .init(title: $0, body: "40.699") })
    }

    func plan(_ races: [FavoriteRace], handled: Set<String> = [], scheduled: [String: Date] = [:],
              starts: Bool = true, results: Bool = true) -> AlertPlan {
        AlertPlan.make(races: races, added: added, handled: handled, scheduled: scheduled, starts: starts, results: results, now: now)
    }

    @Test func schedulesUpNextAheadOfThePlannedStart() {
        let p = plan([race(1, in: 60)])
        #expect(p.schedule.map(\.id) == ["start-1"])
        #expect(p.schedule.first?.at == now.addingTimeInterval(56 * 60))
        #expect(p.post.isEmpty && p.done.isEmpty && p.busy)
    }

    @Test func postsUpNextNowWhenTheServerSaysSo() {
        let p = plan([race(1, in: 10, upNext: true)])
        #expect(p.post.map(\.id) == ["start-1"])
        #expect(p.done == ["start-1"])
        #expect(p.schedule.isEmpty)
    }

    @Test func aScheduledAlertThatWentOffIsDone() {
        let p = plan([race(1, in: 2, upNext: true)], scheduled: ["start-1": now.addingTimeInterval(-120)])
        #expect(p.post.isEmpty)
        #expect(p.done == ["start-1"])
    }

    @Test func postsAnOfficialResultOnce() {
        let official = race(1, in: -10, state: "official", result: "Jens Van 't Wout 1st in Heat 4")
        #expect(plan([official]).post.map(\.title) == ["Jens Van 't Wout 1st in Heat 4"])
        #expect(plan([official], handled: ["result-1"]).post.isEmpty)
        #expect(plan([official], results: false).post.isEmpty) // no spoilers
        #expect(!plan([official]).busy)
    }

    @Test func skipsOldResultsAndRacesBeforeTheFavorite() {
        #expect(plan([race(1, in: -8 * 60, state: "official", result: "old")]).post.isEmpty)
        let before = AlertPlan.make(races: [race(1, in: -10, state: "official", result: "r")],
                                    added: [251: now], handled: [], scheduled: [:], starts: true, results: true, now: now)
        #expect(before.post.isEmpty)
    }

    @Test func startsOffMeansNoUpNext() {
        let p = plan([race(1, in: 60), race(2, in: 5, upNext: true)], starts: false)
        #expect(p.post.isEmpty && p.schedule.isEmpty)
    }

    @Test func ignoresRacesWithNoFavoriteKnown() {
        #expect(plan([race(1, in: 60, skaters: [999])]).schedule.isEmpty)
    }
}

/// A real /favorites/races response: WT1 Vancouver, Van 't Wout, Velzeboer, Sarault and Kim.
struct FavoriteRacesDecodingTests {
    @Test func decodesAndPlansResults() throws {
        let url = try #require(Bundle.main.url(forResource: "favorite-races", withExtension: "json"))
        let response = try JSONDecoder.api.decode(FavoriteRacesResponse.self, from: Data(contentsOf: url))
        #expect(response.races.count == 3)
        let semi = try #require(response.races.first)
        #expect(semi.skaters == [47, 68, 67])
        #expect(semi.result?.title == "Velzeboer 1st, Kim 2nd, Sarault 3rd")

        let now = try Date("2026-10-25T02:00:00Z", strategy: .iso8601)
        let added = Dictionary(uniqueKeysWithValues: [251, 47, 67, 68].map { ($0, now.addingTimeInterval(-86400)) })
        let plan = AlertPlan.make(races: response.races, added: added, handled: [], scheduled: [:], starts: true, results: true, now: now)
        #expect(plan.post.map(\.id) == ["result-2052", "result-2020", "result-2121"])
        #expect(plan.post.first?.body == "Velzeboer and Kim qualified for the final, Sarault for Final B · Women 1000 m Semifinal, Heat 2")
    }
}
