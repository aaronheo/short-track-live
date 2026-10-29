import Foundation
import Testing
@testable import ShortTrackLive

/// The Standings screens' lines and points, from a trimmed
/// copy of the women's standings after World Tour #1.
struct StandingsTests {
    let book: StandingsBook = {
        let json = """
        {"season":"2026/2027","pointsPerPlace":[100,80,70,60,50,44,40,36,32,28],
         "events":[{"code":"CAN1","name":"World Tour #1","city":"Vancouver","slug":"wt1","raced":true},
                   {"code":"CAN2","name":"World Tour #2","city":"Montreal","slug":"wt2","raced":false}],
         "lists":[
          {"id":1,"kind":"overall","gender":"Women","distance":null,"title":"Crystal Globe","entries":[
            {"rank":1,"points":224,"skaterId":67,"name":"Courtney Sarault","last":"Sarault","nat":"CAN","iso2":"CA","perEvent":[224,null]},
            {"rank":2,"points":188,"skaterId":12,"name":"Minjeong Choi","last":"Choi","nat":"KOR","iso2":"KR","perEvent":[188,null]},
            {"rank":3,"points":180,"skaterId":5,"name":"Xandra Velzeboer","last":"Velzeboer","nat":"NED","iso2":"NL","perEvent":[180,null]},
            {"rank":7,"points":90,"skaterId":40,"name":"Gilli Kim","last":"Kim","nat":"KOR","iso2":"KR","perEvent":[90,null]}]},
          {"id":2,"kind":"distance","gender":"Women","distance":"500","title":"500 m","entries":[
            {"rank":1,"points":100,"skaterId":5,"name":"Xandra Velzeboer","last":"Velzeboer","nat":"NED","iso2":"NL","perEvent":[100,null]},
            {"rank":2,"points":80,"skaterId":67,"name":"Courtney Sarault","last":"Sarault","nat":"CAN","iso2":"CA","perEvent":[80,null]}]},
          {"id":3,"kind":"distance","gender":"Women","distance":"1000","title":"1000 m","entries":[
            {"rank":5,"points":50,"skaterId":40,"name":"Gilli Kim","last":"Kim","nat":"KOR","iso2":"KR","perEvent":[50,null]},
            {"rank":6,"points":44,"skaterId":67,"name":"Courtney Sarault","last":"Sarault","nat":"CAN","iso2":"CA","perEvent":[44,null]}]},
          {"id":4,"kind":"distance","gender":"Women","distance":"1500","title":"1500 m","entries":[
            {"rank":1,"points":100,"skaterId":67,"name":"Courtney Sarault","last":"Sarault","nat":"CAN","iso2":"CA","perEvent":[100,null]},
            {"rank":7,"points":40,"skaterId":40,"name":"Gilli Kim","last":"Kim","nat":"KOR","iso2":"KR","perEvent":[40,null]}]},
          {"id":5,"kind":"distance","gender":"Mixed","distance":"mixed","title":"Mixed relay","entries":[
            {"rank":1,"points":100,"skaterId":null,"name":"Netherlands","last":"Netherlands","nat":"NED","iso2":"NL","perEvent":[100,null]}]}]}
        """
        return StandingsBook(response: try! JSONDecoder.api.decode(StandingsResponse.self, from: Data(json.utf8)))
    }()

    var overall: StandingList { book.response.lists[0] }
    var kim: StandingEntry { overall.entries[3] }

    @Test func chipsAreTheCategorysListsThenTheMixedOnes() {
        #expect(book.lists(for: "Women").map(\.title) == ["Crystal Globe", "500 m", "1000 m", "1500 m", "Mixed relay"])
        #expect(book.lists(for: "Men").map(\.title) == ["Mixed relay"])
        #expect(book.racedCount == 1)
    }

    @Test func linesUnderNames() {
        #expect(book.meta(for: overall.entries[0], in: overall) == "500 2nd · 1000 6th · 1500 1st")
        let w500 = book.response.lists[1]
        #expect(book.meta(for: w500.entries[0], in: w500) == "Vancouver 1st")
    }

    @Test func pointsSoFarByDistance() {
        let rows = book.pointsSoFar(for: kim, gender: "Women")
        #expect(rows.map { "\($0.distance) \($0.place ?? "-") \($0.points)" } == ["1000 m 5th 50", "1500 m 7th 40"])
        #expect(rows.first?.event == "World Tour #1, Vancouver")
    }

    @Test func ordinals() {
        #expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(Fmt.ordinal) == ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st"])
    }
}
