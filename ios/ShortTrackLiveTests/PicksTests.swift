import Foundation
import Testing
@testable import ShortTrackLive

/// Reading a pick from the server and how the crowd's picks read.
struct PicksTests {
    @Test func decodesAPickWithTheCrowd() throws {
        let json = """
        {"heatId":7,"event":"World Tour #1, Vancouver","title":"Women 1000 m","race":"Semifinal · Heat 2",
         "startsAt":"2026-10-25T20:10:00.000Z","state":"start_list","locked":false,"cut":{"after":2,"label":"To the final"},
         "entries":[{"entryId":1,"name":"Courtney Sarault","last":"Sarault","nat":"CAN","iso2":"CA","start":1},
                    {"entryId":2,"name":"Xandra Velzeboer","last":"Velzeboer","nat":"NED","iso2":"NL","start":2},
                    {"entryId":3,"name":"Gabriela Topolska","last":"Topolska","nat":"POL","iso2":"PL","start":3}],
         "myPick":{"finish":[2,1],"penalized":[3]},
         "crowd":{"picks":4,"entries":[{"entryId":1,"places":[25,50,25],"penalized":0},
                                      {"entryId":2,"places":[75,25,0],"penalized":0},
                                      {"entryId":3,"places":[0,25,25],"penalized":50}],
                  "mostPicked":{"finish":[2,1,3],"penalized":[],"share":50}},
         "result":null}
        """
        let heat = try JSONDecoder.api.decode(PickHeat.self, from: Data(json.utf8))
        #expect(heat.startingChoice == PickChoice(finish: [2, 1], penalized: [3]))
        #expect(heat.cut?.after == 2)
        let lines = heat.crowd!.entries.map(CrowdLine.init)
        #expect(lines.map(\.top) == [2, 1, nil]) // Topolska: a penalty is the most picked
        #expect(lines.map(\.topShare) == [50, 75, 50])
        #expect(lines[2].shares == [0, 25, 25, 50])
    }

    @Test func startsFromTheStartOrder() throws {
        let json = """
        {"heatId":7,"event":"","title":"Men 500 m","race":"Final A","startsAt":null,"state":"start_list","locked":false,"cut":null,
         "entries":[{"entryId":9,"name":"A","last":"A","nat":null,"iso2":null,"start":1},{"entryId":4,"name":"B","last":"B","nat":null,"iso2":null,"start":2}],
         "myPick":null,"crowd":null,"result":null}
        """
        let heat = try JSONDecoder.api.decode(PickHeat.self, from: Data(json.utf8))
        #expect(heat.startingChoice == PickChoice(finish: [9, 4], penalized: []))
        #expect(Fmt.pickPlace(nil) == "Penalty")
        #expect(Fmt.pickPlace(2) == "2nd")
    }

    @Test func picksOpenAlertsComeOncePerRound() {
        func race(_ id: Int, _ title: String, _ race: String, _ round: String, picked: Bool = false) -> PickSummary {
            PickSummary(heatId: id, title: title, race: race, round: round, startsAt: nil, state: "start_list", picked: picked, points: nil, max: nil)
        }
        let open = [race(1, "Women 1000 m", "Semifinal · Heat 1", "Semifinals"),
                    race(2, "Women 1000 m", "Semifinal · Heat 2", "Semifinals"),
                    race(3, "Men 500 m", "Final A", "Finals"),
                    race(4, "Men 500 m", "Final B", "Finals", picked: true)]
        let event = PicksHome.Event(slug: "wt2", name: "World Tour #2", city: "Montréal", state: "live")
        let plan = PicksAlertPlan.make(open: open, event: event, notified: [])
        #expect(plan.post.map(\.title) == ["Picks are open: Women 1000 m semifinals", "Picks are open: Men 500 m finals"])
        #expect(plan.post.map(\.body) == ["2 races · Montréal. Lock in your order before the start.",
                                         "Final A · Montréal. Lock in your order before the start."])
        #expect(plan.post.allSatisfy { $0.link == "pick" })
        #expect(plan.done == ["picks-1", "picks-2", "picks-3"])
        // Already told: nothing new.
        #expect(PicksAlertPlan.make(open: open, event: event, notified: plan.done).post.isEmpty)
    }
}
