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

struct AthleteDecodingTests {
    @Test func search() throws {
        let search: AthleteSearchResponse = try fixture("athlete-search")
        #expect(search.results.first?.name == "Jens Van 't Wout")
        #expect(search.results.first?.races == 115)
    }

    @Test func athlete() throws {
        let athlete: AthleteResponse = try fixture("athlete")
        #expect(athlete.athlete.iso2 == "NL")
        #expect(athlete.stats.gold + athlete.stats.silver + athlete.stats.bronze == 20)
        #expect(athlete.bests.map(\.distance) == ["500 m", "1000 m", "1500 m"])
    }

    @Test func racesPage() throws {
        let page: RacesResponse = try fixture("athlete-races")
        #expect(page.total == 115)
        #expect(page.races.count == 5)
        #expect(page.nextCursor != nil)
        #expect(page.races.first?.medal == 1)
        #expect(page.facets?.distances.map(\.value) == ["500", "1000", "1500", "relay"])
    }
}

struct FormattingTests {
    @Test func dateRanges() {
        #expect(Fmt.dateRange("2026-10-23", "2026-10-25") == "Oct 23–25")
        #expect(Fmt.dateRange("2026-10-30", "2026-11-01") == "Oct 30 – Nov 1")
        #expect(Fmt.dateBlock("2026-11-06") == ("NOV", "6"))
        #expect(Fmt.dateRangeWithYear("2026-10-23", "2026-10-25") == "Oct 23–25, 2026")
        #expect(Fmt.monthYear("2025-10-09") == "Oct 2025")
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
        let rome = TimeZone(identifier: "Europe/Rome")!
        #expect(Fmt.zoneName(rome, at: Date(timeIntervalSince1970: 1_770_000_000)) == "CET") // Feb 2026
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

    @Test func athleteSurvivesLayoutSwitch() {
        let model = AppModel()
        model.openAthlete(251)
        model.searchPath.append(.heat(93))
        #expect(model.tab == .search)
        model.setSplit(true)
        #expect(model.searchAthlete == 251)
        #expect(model.searchDetailPath == [.heat(93)])
        model.setSplit(false)
        #expect(model.searchPath == [.athlete(251), .heat(93)])
    }

    @Test func athleteDeepLinkSwitchesTab() {
        let model = AppModel()
        model.open(URL(string: "shorttrack://athlete/251")!)
        #expect(model.tab == .search)
        #expect(model.searchPath == [.athlete(251)])
        model.open(URL(string: "shorttrack://round/35")!)
        #expect(model.tab == .events)
    }

    @Test func onTheIceOpensTheScheduleUnderneath() {
        let model = AppModel()
        model.openRound(35, event: "wt1")
        #expect(model.path == [.event("wt1"), .round(35)])
    }

    @Test func askLinksOpenOnTopOfTheConversation() {
        let model = AppModel()
        model.openAsk("Who won?")
        #expect(model.tab == .search)
        #expect(model.searchPath == [.ask("Who won?")])
        #expect(model.openFromAsk(URL(string: "shorttrack://athlete/251")!))
        #expect(model.openFromAsk(URL(string: "shorttrack://heat/93")!))
        #expect(!model.openFromAsk(URL(string: "https://www.isu.org")!))
        #expect(!model.openFromAsk(URL(string: "shorttrack://athlete/abc")!))
        #expect(model.searchPath == [.ask("Who won?"), .athlete(251), .heat(93)])
    }

    @Test func conversationSurvivesLayoutSwitch() {
        let model = AppModel()
        model.openAsk("Who won?")
        _ = model.openFromAsk(URL(string: "shorttrack://athlete/251")!)
        model.setSplit(true)
        #expect(model.searchQuestion == "Who won?")
        #expect(model.searchAthlete == nil)
        #expect(model.searchDetailPath == [.athlete(251)])
        model.setSplit(false)
        #expect(model.searchPath == [.ask("Who won?"), .athlete(251)])
    }

    @Test func openingAnAthleteEndsTheConversationPane() {
        let model = AppModel()
        model.setSplit(true)
        model.openAsk("Who won?")
        model.openAthlete(251)
        #expect(model.searchQuestion == nil)
        #expect(model.searchAthlete == 251)
    }
}

struct AskTextTests {
    @Test func namesAreNotQuestions() {
        for name in ["Sarault", "van", "Kim Gil-li", "Steven Dubois", "Jens van 't Wout"] {
            #expect(!AskText.looksLikeQuestion(name), "\(name)")
        }
    }

    @Test func questions() {
        for question in ["Who won the 500?", "dubois?", "how fast is Dubois", "fastest 500 m time ever",
                         "Did Canada win the relay", "compare Dubois and Sarault"] {
            #expect(AskText.looksLikeQuestion(question), "\(question)")
        }
    }

    @Test func answersKeepLinksAndBullets() {
        let text = AskText.attributed("**Gold** for [Sarault](shorttrack://athlete/7)\n- 500 m\n- 1000 m")
        #expect(String(text.characters) == "Gold for Sarault\n•  500 m\n•  1000 m")
        #expect(text.runs.contains { $0.link == URL(string: "shorttrack://athlete/7") })
    }
}
