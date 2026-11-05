import ActivityKit
import Foundation

/// A favorite's race as a Live Activity. The server starts it with a push when
/// the race is up next, updates it lap by lap and ends it after the result
/// (server/src/domain/activity.ts writes the same keys). Shared by the app and
/// the widget extension.
struct RaceActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        struct Row: Codable, Hashable {
            let pos: Int
            let name: String
            let iso2: String?
            let gap: String?
            let mine: Bool
        }

        /// upNext | racing | unofficial | official
        let phase: String
        let lap: Int?
        /// "13½"
        let laps: String
        let progress: Double
        /// "Velzeboer is up next", "Velzeboer 2nd", "Xandra Velzeboer won the 1500 m Final A"
        let headline: String
        /// "start 3 of 8", or the result line
        let detail: String
        let rows: [Row]
    }

    let heatId: Int
    /// "World Tour #2"
    let event: String
    /// "Women 1500 m · Final A"
    let race: String
    /// The favorite's last name.
    let favorite: String
    let iso2: String?
}
