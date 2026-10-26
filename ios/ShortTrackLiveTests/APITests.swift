import Foundation
import Testing
@testable import ShortTrackLive

/// The fixtures are real server responses (WT1 Vancouver mid-event, Worlds 2026).
private func fixture<T: Decodable>(_ name: String, as type: T.Type = T.self) throws -> T {
    let url = try #require(Bundle.main.url(forResource: name, withExtension: "json"))
    return try JSONDecoder.api.decode(T.self, from: Data(contentsOf: url))
}

struct DecodingTests {
    @Test func events() throws {
        let events: EventsResponse = try fixture("events")
        #expect(events.season == "2026/2027")
        let live = try #require(events.live)
        #expect(live.event.shortName == "World Tour #1")
        #expect(live.onTheIce?.heat == "Heat 5 of 7")
        #expect(live.onTheIce?.lap == "Lap 3 of 14")
    }

    @Test func schedule() throws {
        let schedule: ScheduleResponse = try fixture("schedule")
        #expect(schedule.event.timeZone == "America/Los_Angeles")
        #expect(schedule.days.map(\.label) == ["Fri 23", "Sat 24", "Sun 25"])
        let live = try #require(schedule.days[0].items.first { $0.state == .live })
        #expect(live.title == "Men 1500 m")
        #expect(live.liveDetail == "Heat 5 of 7")
        #expect(Fmt.clock(live.startsAt, in: TimeZone(identifier: "America/Los_Angeles")!) == live.venueTime)
    }

    @Test func liveRound() throws {
        let round: RoundResponse = try fixture("round-live")
        let places = try #require(round.places)
        #expect(places.title == "Semifinal places")
        #expect(places.qualified.count == 8 && places.qualified.total == 14)
        #expect(places.time?.rows.last?.kind == .open)
        let running = try #require(round.heats.first { $0.state == .running })
        #expect(running.lap?.current == 3)
        #expect(running.entries.first?.lastLap == "11.210")
        #expect(round.heats.filter { $0.state == .startList }.count == 2)
    }

    @Test func advancedSkaterTakesATimeSpot() throws {
        let round: RoundResponse = try fixture("round-advanced")
        let rows = try #require(round.places?.time?.rows)
        #expect(rows.first?.kind == .advanced)
        #expect(rows.first?.badge == "ADV")
        #expect(rows.filter { $0.kind == .out }.count == 3)
    }

    @Test func heat() throws {
        let heat: HeatResponse = try fixture("heat")
        #expect(heat.results.first?.last == "Nadalini")
        #expect(heat.chart?.winner == "Nadalini")
        #expect(heat.lapTable?.rows.count == 14)
        #expect(heat.results.last?.status == "PEN")
    }

    @Test func finalsAndRelays() throws {
        let finals: RoundResponse = try fixture("round-finals")
        #expect(finals.places == nil)
        #expect(finals.heats.map(\.name) == ["Final B", "Final A"])
        let relay: RoundResponse = try fixture("round-relay")
        #expect(relay.round.isRelay)
    }
}

struct FormattingTests {
    @Test func dateRanges() {
        #expect(Fmt.dateRange("2026-10-23", "2026-10-25") == "Oct 23–25")
        #expect(Fmt.dateRange("2026-10-30", "2026-11-01") == "Oct 30 – Nov 1")
        #expect(Fmt.dateBlock("2026-11-06") == ("NOV", "6"))
    }

    @Test func seasons() {
        #expect(Fmt.season("2026/2027") == "2026/27")
        #expect(Fmt.seasonPath("2025/2026") == "2025-2026")
    }

    @Test func flags() {
        #expect(Flags.emoji("it") == "🇮🇹")
        #expect(Flags.emoji("KR") == "🇰🇷")
    }

    @Test func zoneNames() {
        #expect(Fmt.zoneName(TimeZone(identifier: "America/Los_Angeles")!) == "PT")
    }
}

@MainActor
struct NavigationTests {
    @Test func layoutSwitchKeepsYourPlace() {
        let model = AppModel()
        model.openEvent("wt1")
        model.openRound(35)
        model.openHeat(93)
        #expect(model.path == [.event("wt1"), .round(35), .heat(93)])
        model.setSplit(true)
        #expect(model.sidebarPath == [.event("wt1")])
        #expect(model.detailRound == 35)
        #expect(model.detailPath == [.heat(93)])
        model.setSplit(false)
        #expect(model.path == [.event("wt1"), .round(35), .heat(93)])
    }

    @Test func deepLinks() {
        let model = AppModel()
        model.open(URL(string: "shorttrack://event/isu-short-track-world-tour-1")!)
        model.open(URL(string: "shorttrack://round/35")!)
        model.open(URL(string: "shorttrack://heat/93")!)
        #expect(model.path == [.event("isu-short-track-world-tour-1"), .round(35), .heat(93)])
    }

    @Test func onTheIceOpensTheScheduleUnderneath() {
        let model = AppModel()
        model.openRound(35, event: "wt1")
        #expect(model.path == [.event("wt1"), .round(35)])
    }
}
