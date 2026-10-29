import Foundation
import Testing
@testable import ShortTrackLive

/// The Standings screens' lists and points, from a trimmed
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
        #expect(book.progress == "After 1 of 2 events")
    }

    @Test func pointsSoFarByDistance() {
        let rows = book.pointsSoFar(for: kim, gender: "Women")
        #expect(rows.map { "\($0.distance) \($0.place ?? "-") \($0.points)" } == ["1000 m 5th 50", "1500 m 7th 40"])
        #expect(rows.first?.event == "World Tour #1, Vancouver")
    }

    @Test func ordinals() {
        #expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(Fmt.ordinal) == ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st"])
    }

    /// A World Cup season: no points table, and a stop that raced the 500 m twice.
    @Test func pastSeasonWithADistanceRacedTwice() throws {
        let json = """
        {"season":"2023/2024","seasons":["2026/2027","2023/2024"],"series":"World Cup","pointsPerPlace":null,
         "events":[{"code":"CAN","name":"World Cup #1","city":"Montréal","slug":"wc1","raced":true},
                   {"code":"CHN","name":"World Cup #3","city":"Beijing","slug":"wc3","raced":true}],
         "lists":[{"id":354,"kind":"distance","gender":"Women","distance":"500","title":"500 m","eventIndex":[0,1,1],"entries":[
            {"rank":1,"points":350,"skaterId":5,"name":"Xandra Velzeboer","last":"Velzeboer","nat":"NED","iso2":"NL","perEvent":[100,null,150]}]}]}
        """
        let past = StandingsBook(response: try JSONDecoder.api.decode(StandingsResponse.self, from: Data(json.utf8)))
        let list = past.response.lists[0]
        let rows = past.pointsSoFar(for: list.entries[0], gender: "Women")
        #expect(rows.map { "\($0.event) \($0.place ?? "-") \($0.points)" } == ["World Cup #1, Montréal - 100", "World Cup #3, Beijing - 150"])
        #expect(past.progress == "Final · 2 events")
        #expect(past.series == "World Cup")
        #expect(list.key == "500")
        #expect(overall.key == "overall")
    }
}
