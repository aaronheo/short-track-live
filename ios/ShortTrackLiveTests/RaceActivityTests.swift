import Foundation
import Testing
@testable import ShortTrackLive

/// The server writes these (server/src/domain/activity.ts); a key mismatch would
/// leave the Live Activity blank, so decode exactly what it sends.
struct RaceActivityTests {
    @Test func decodesTheServersPayload() throws {
        let attributes = """
        {"heatId":812,"event":"World Tour #2","race":"Women 1500 m · Final A","favorite":"Velzeboer","iso2":"nl"}
        """
        let state = """
        {"phase":"racing","laps":"13½","lap":9,"progress":0.64,"headline":"Velzeboer 2nd","detail":"Women 1500 m",
         "rows":[{"pos":1,"name":"Kim","iso2":"kr","mine":false,"gap":"Leader"},{"pos":2,"name":"Velzeboer","iso2":"nl","mine":true,"gap":"+0.14"}]}
        """
        let a = try JSONDecoder().decode(RaceActivityAttributes.self, from: Data(attributes.utf8))
        let s = try JSONDecoder().decode(RaceActivityAttributes.ContentState.self, from: Data(state.utf8))
        #expect(a.heatId == 812 && a.favorite == "Velzeboer")
        #expect(s.lap == 9 && s.rows.last?.mine == true && s.rows.first?.gap == "Leader")

        let upNext = """
        {"phase":"upNext","laps":"13½","lap":null,"progress":0,"headline":"Velzeboer is up next","detail":"start 3 of 8","rows":[]}
        """
        #expect(try JSONDecoder().decode(RaceActivityAttributes.ContentState.self, from: Data(upNext.utf8)).lap == nil)
    }
}
