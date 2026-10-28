import Foundation
import Testing
@testable import ShortTrackLive

/// Comparing the phone's favorites with the account's, and the sign-in reply.
struct AccountTests {
    func skater(_ id: Int, added: Date) -> FavoriteSkater {
        FavoriteSkater(id: id, name: "Skater \(id)", last: "\(id)", nat: "NED", iso2: "NL", gender: "Women", addedAt: added)
    }

    @Test func datesKeepTheirMillisecondsThroughTheServer() throws {
        let local = Date(timeIntervalSince1970: 1_792_500_000.123_456)
        #expect(SavedState.millis(local) == "2026-10-20T12:40:00.123Z")
        // What the server sends back parses to the same text again.
        let back = try Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(SavedState.millis(local))
        #expect(SavedState.millis(back) == SavedState.millis(local))
        #expect(SavedState.millis(Date(timeIntervalSince1970: 1_792_500_000.9996)) == "2026-10-20T12:40:01.000Z")
    }

    @Test func orderDoesNotMatter() {
        let a = skater(1, added: .init(timeIntervalSince1970: 100)), b = skater(2, added: .init(timeIntervalSince1970: 200))
        let settings = AccountSettings(notifyStarts: true, notifyResults: false, appearance: "system")
        #expect(SavedState(skaters: [a, b], settings: settings) == SavedState(skaters: [b, a], settings: settings))
        #expect(SavedState(skaters: [a], settings: settings) != SavedState(skaters: [a, b], settings: settings))
    }

    @Test func signingInAddsOnlyTheAccountsOtherFavorites() {
        let here = [skater(1, added: .init(timeIntervalSince1970: 100)), skater(2, added: .init(timeIntervalSince1970: 200))]
        let saved = [skater(2, added: .init(timeIntervalSince1970: 50)), skater(3, added: .init(timeIntervalSince1970: 60))]
        #expect(AccountStore.combine(local: here, account: saved).map(\.id) == [3])
        #expect(AccountStore.combine(local: here, account: []).isEmpty)
    }

    @Test func decodesTheSignInReply() throws {
        let json = """
        {"session":"abc","account":{"name":"Aaron Heo","email":"a@example.com","provider":"google"},
         "favorites":[{"id":12,"name":"Xandra Velzeboer","last":"Velzeboer","nat":"NED","iso2":"NL","gender":"Women","addedAt":"2026-10-20T10:00:00.000Z"}],
         "settings":{"notifyStarts":false,"appearance":"dark"},"updatedAt":"2026-10-28T10:00:00.000Z"}
        """
        let state = try JSONDecoder.api.decode(AccountState.self, from: Data(json.utf8))
        #expect(state.session == "abc")
        #expect(state.account.name == "Aaron Heo")
        #expect(state.favorites.first?.last == "Velzeboer")
        #expect(state.settings == AccountSettings(notifyStarts: false, notifyResults: nil, appearance: "dark"))
        // PUT /me's body: ids with dates, and the settings.
        let body = try JSONSerialization.jsonObject(with: JSONEncoder.api.encode(SavedState(skaters: state.favorites, settings: state.settings))) as? [String: Any]
        #expect((body?["favorites"] as? [[String: Any]])?.first?["addedAt"] as? String == "2026-10-20T10:00:00.000Z")
    }
}
