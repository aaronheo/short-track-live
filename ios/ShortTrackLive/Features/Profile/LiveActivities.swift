import ActivityKit
import Foundation

/// The phone's side of Live Activities: the server starts them (with the
/// push-to-start token PushRegistration sends it), updates and ends them. Here
/// we only hand the server each token as iOS issues it. iOS wakes the app in
/// the background for these, so watching starts at launch (AppDelegate).
@MainActor
final class LiveActivities {
    static let shared = LiveActivities()

    private let defaults = UserDefaults.standard
    private var watching = false
    private var watched: Set<String> = []

    /// Hex push-to-start token, once iOS has given one.
    var startToken: String? { defaults.string(forKey: Keys.startToken) }

    /// Whether the person allows Live Activities for the app (Settings › Short Track).
    var allowed: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }

    func watch() {
        guard !watching else { return }
        watching = true
        Task {
            for await data in Activity<RaceActivityAttributes>.pushToStartTokenUpdates {
                let hex = data.hex
                guard hex != startToken else { continue }
                defaults.set(hex, forKey: Keys.startToken)
                await RaceAlerts.shared.check()
            }
        }
        Task {
            for await activity in Activity<RaceActivityAttributes>.activityUpdates { follow(activity) }
        }
        for activity in Activity<RaceActivityAttributes>.activities { follow(activity) }
        #if DEBUG
        // `xcrun simctl launch <device> com.aaronheo.shorttracklive -sampleActivity` shows one without the server.
        // An app can only start one in the foreground, so after the window is up.
        if ProcessInfo.processInfo.arguments.contains("-sampleActivity") {
            Task {
                try? await Task.sleep(for: .seconds(2))
                startSample()
            }
        }
        #endif
    }

    #if DEBUG
    private func startSample() {
        typealias Row = RaceActivityAttributes.ContentState.Row
        let state = RaceActivityAttributes.ContentState(
            phase: "racing", lap: 9, laps: "13½", progress: 9 / 14, headline: "Velzeboer 2nd", detail: "Women 1500 m",
            rows: [Row(pos: 1, name: "Kim", iso2: "kr", gap: "Leader", mine: false),
                   Row(pos: 2, name: "Velzeboer", iso2: "nl", gap: "+0.14", mine: true),
                   Row(pos: 3, name: "Sarault", iso2: "ca", gap: "+0.41", mine: false)])
        let attributes = RaceActivityAttributes(heatId: 1, event: "World Tour #2", race: "Women 1500 m · Final A", favorite: "Velzeboer", iso2: "nl")
        do {
            _ = try Activity.request(attributes: attributes, content: .init(state: state, staleDate: nil))
        } catch {
            print("Sample Live Activity failed: \(error)")
        }
    }
    #endif

    /// Sends this activity's update token to the server, now and whenever it changes.
    private func follow(_ activity: Activity<RaceActivityAttributes>) {
        guard watched.insert(activity.id).inserted else { return }
        let heatId = activity.attributes.heatId
        Task {
            for await data in activity.pushTokenUpdates {
                guard let device = PushRegistration.shared.token else { continue }
                struct Body: Encodable, Sendable { let device: String; let heatId: Int }
                struct Reply: Decodable, Sendable { let push: Bool }
                _ = try? await APIClient.shared.send("PUT", "/activities/\(data.hex)", body: Body(device: device, heatId: heatId), as: Reply.self)
            }
        }
    }

    /// The switch in Profile was turned off: end what's showing.
    func endAll() async {
        for activity in Activity<RaceActivityAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }

    private enum Keys {
        static let startToken = "activityStartToken"
    }
}

extension Data {
    var hex: String { map { String(format: "%02x", $0) }.joined() }
}
