import BackgroundTasks
import SwiftUI
import UserNotifications

/// What one check of the favorites' races does: alerts to show now, "up
/// next" alerts to schedule for a few minutes before a heat's planned start,
/// and which alerts are done with. Pure, so it can be tested.
///
/// Without push from the server (that needs a paid Apple developer account)
/// the phone does it all: it schedules "up next" ahead from planned times, and
/// posts results whenever it gets to check (open, or a background refresh).
struct AlertPlan: Equatable {
    struct Alert: Equatable {
        let id: String // "start-<heat>", "result-<heat>"
        let title: String
        let body: String
        let heatId: Int
        let event: String
        /// When to show it; nil = now.
        var at: Date?
        /// What a tap opens: shorttrack://<link>/<heatId>.
        var link = "heat"
    }

    var post: [Alert] = []
    var schedule: [Alert] = []
    /// Alerts shown now, or scheduled ones whose time has passed: never again.
    var done: Set<String> = []
    /// A favorite races within a few hours or is waiting on a result: check often.
    var busy = false

    /// "Up next" goes off this long before the planned start.
    static let lead: TimeInterval = 4 * 60
    /// Results older than this aren't worth a notification any more.
    static let resultsFor: TimeInterval = 6 * 3600

    static func make(races: [FavoriteRace], added: [Int: Date], handled: Set<String>, scheduled: [String: Date],
                     starts: Bool, results: Bool, now: Date) -> AlertPlan {
        var plan = AlertPlan()
        for race in races {
            guard let startsAt = race.startsAt, let since = race.skaters.compactMap({ added[$0] }).min() else { continue }
            let fromNow = startsAt.timeIntervalSince(now)
            if race.state != "official", fromNow < 3 * 3600, fromNow > -3 * 3600 { plan.busy = true }
            guard startsAt > since else { continue } // raced before they were a favorite

            let startID = "start-\(race.heatId)"
            if starts, race.state == "scheduled" || race.state == "start_list", !handled.contains(startID) {
                let alert = Alert(id: startID, title: race.start.title, body: race.start.body, heatId: race.heatId, event: race.event)
                let fire = startsAt.addingTimeInterval(-lead)
                if let was = scheduled[startID], was <= now {
                    plan.done.insert(startID) // it went off
                } else if race.upNext {
                    plan.post.append(alert)
                    plan.done.insert(startID)
                } else if fire > now.addingTimeInterval(15) {
                    var later = alert
                    later.at = fire
                    plan.schedule.append(later)
                }
            }

            let resultID = "result-\(race.heatId)"
            if results, let text = race.result, !handled.contains(resultID), fromNow > -resultsFor {
                plan.post.append(Alert(id: resultID, title: text.title, body: text.body, heatId: race.heatId, event: race.event))
                plan.done.insert(resultID)
            }
        }
        return plan
    }
}

/// "Picks are open" alerts: one per round whose races just got start lists
/// (skaters qualify into quarterfinals, semifinals and finals, so a round can
/// only be picked once the one before it is done). Pure, so it can be tested.
struct PicksAlertPlan: Equatable {
    var post: [AlertPlan.Alert] = []
    /// The races those alerts cover, so they don't come again.
    var done: Set<String> = []

    static func make(open: [PickSummary], event: PicksHome.Event?, notified: Set<String>) -> PicksAlertPlan {
        var plan = PicksAlertPlan()
        var rounds: [String: [PickSummary]] = [:], order: [String] = []
        for race in open where !race.picked && !notified.contains(id(race)) {
            let name = [race.title, race.round?.lowercased()].compactMap { $0 }.joined(separator: " ")
            if rounds[name] == nil { order.append(name) }
            rounds[name, default: []].append(race)
        }
        let place = event.map { " · \($0.city ?? $0.name)" } ?? ""
        for name in order {
            let races = rounds[name]!
            let what = races.count == 1 ? races[0].race : "\(races.count) races"
            plan.post.append(AlertPlan.Alert(
                id: id(races[0]), title: "Picks are open: \(name)", body: "\(what)\(place). Lock in your order before the start.",
                heatId: races[0].heatId, event: "picks", link: "pick"))
            plan.done.formUnion(races.map(id))
        }
        return plan
    }

    static func id(_ race: PickSummary) -> String { "picks-\(race.heatId)" }
}

/// Runs the checks: while the app is open (RootView), and in background
/// refreshes, which iOS schedules when it sees fit.
@MainActor
final class RaceAlerts {
    static let shared = RaceAlerts()
    static let refreshTask = "com.aaronheo.shorttracklive.refresh"

    private let center = UNUserNotificationCenter.current()
    private let defaults = UserDefaults.standard
    /// A favorite is racing soon, or an event with picks is on: check often.
    var busy: Bool { racesBusy || picksBusy }
    private var racesBusy = false
    private var picksBusy = false

    func status() async -> UNAuthorizationStatus {
        await center.notificationSettings().authorizationStatus
    }

    /// Shows iOS's prompt the first time; after that, whether they're allowed.
    @discardableResult
    func requestPermission() async -> Bool {
        (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    }

    /// Checks the favorites' races and races open for picks. Returns whether to check again soon.
    @discardableResult
    func check(_ favorites: Favorites = .shared) async -> Bool {
        let allowed = ([.authorized, .provisional, .ephemeral] as Set<UNAuthorizationStatus>).contains(await status())
        racesBusy = await checkRaces(favorites, allowed: allowed)
        picksBusy = await checkPicks(favorites, allowed: allowed)
        return busy
    }

    private func checkRaces(_ favorites: Favorites, allowed: Bool) async -> Bool {
        guard allowed, !favorites.skaters.isEmpty, favorites.notifyStarts || favorites.notifyResults else {
            await removePendingStarts(keeping: [])
            return false
        }
        let ids = favorites.skaters.map { String($0.id) }.joined(separator: ",")
        let response: FavoriteRacesResponse?
        do {
            response = try await APIClient.shared.get("favorites/races", query: [URLQueryItem(name: "skaters", value: ids)],
                                                      cached: false, as: FavoriteRacesResponse.self)
        } catch {
            return racesBusy
        }
        guard let response else { return racesBusy }

        let now = Date.now
        var handled = load(Keys.handled)
        var scheduled = load(Keys.scheduled)
        let plan = AlertPlan.make(
            races: response.races,
            added: Dictionary(favorites.skaters.map { ($0.id, $0.addedAt) }, uniquingKeysWith: min),
            handled: Set(handled.keys), scheduled: scheduled,
            starts: favorites.notifyStarts, results: favorites.notifyResults, now: now)

        // Clear stale "up next" alerts first (a favorite removed, a time
        // changed, alerts off), so the cleanup can't catch the new ones.
        for id in await removePendingStarts(keeping: Set(plan.schedule.map(\.id))) { scheduled[id] = nil }
        for alert in plan.schedule {
            guard let at = alert.at else { continue }
            let trigger = UNTimeIntervalNotificationTrigger(timeInterval: max(1, at.timeIntervalSince(now)), repeats: false)
            try? await center.add(request(alert, trigger: trigger))
            scheduled[alert.id] = at
        }
        for alert in plan.post { try? await center.add(request(alert, trigger: nil)) }
        for id in plan.done { handled[id] = now; scheduled[id] = nil }

        // Forget what can't come back: a heat's alerts are done within days.
        handled = handled.filter { now.timeIntervalSince($0.value) < 7 * 86400 }
        scheduled = scheduled.filter { now.timeIntervalSince($0.value) < 2 * 86400 }
        save(handled, Keys.handled)
        save(scheduled, Keys.scheduled)
        return plan.busy
    }

    /// Signed in with picks alerts on: a notification when a round's races open for picks.
    private func checkPicks(_ favorites: Favorites, allowed: Bool) async -> Bool {
        guard allowed, favorites.notifyPicks, let session = Keychain.session else { return false }
        guard let home = try? await APIClient.shared.send("GET", "/picks", account: session, as: PicksHome.self) else { return picksBusy }
        let now = Date.now
        var notified = load(Keys.picks)
        let plan = PicksAlertPlan.make(open: home.open, event: home.event, notified: Set(notified.keys))
        for alert in plan.post { try? await center.add(request(alert, trigger: nil)) }
        for id in plan.done { notified[id] = now }
        save(notified.filter { now.timeIntervalSince($0.value) < 7 * 86400 }, Keys.picks)
        return home.event?.state == "live"
    }

    /// Asks iOS for a background check: soon while a favorite is racing or picks are coming, else in half an hour.
    func scheduleRefresh() {
        let favorites = Favorites.shared
        guard !favorites.skaters.isEmpty || (favorites.notifyPicks && Keychain.session != nil) else { return }
        let request = BGAppRefreshTaskRequest(identifier: Self.refreshTask)
        request.earliestBeginDate = Date(timeIntervalSinceNow: busy ? 5 * 60 : 30 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    func backgroundRefresh() async {
        scheduleRefresh() // keep the chain going even if this check is cut short
        await check()
        scheduleRefresh()
    }

    /// Removes pending "up next" alerts not in `keeping`; returns their ids.
    @discardableResult
    private func removePendingStarts(keeping: Set<String>) async -> [String] {
        let stale = await center.pendingNotificationRequests().map(\.identifier)
            .filter { $0.hasPrefix("start-") && !keeping.contains($0) }
        if !stale.isEmpty { center.removePendingNotificationRequests(withIdentifiers: stale) }
        return stale
    }

    private func request(_ alert: AlertPlan.Alert, trigger: UNNotificationTrigger?) -> UNNotificationRequest {
        let content = UNMutableNotificationContent()
        content.title = alert.title
        content.body = alert.body
        content.sound = .default
        content.threadIdentifier = alert.event
        content.userInfo = ["url": "shorttrack://\(alert.link)/\(alert.heatId)"]
        return UNNotificationRequest(identifier: alert.id, content: content, trigger: trigger)
    }

    private func load(_ key: String) -> [String: Date] {
        defaults.data(forKey: key).flatMap { try? JSONDecoder().decode([String: Date].self, from: $0) } ?? [:]
    }

    private func save(_ value: [String: Date], _ key: String) {
        defaults.set(try? JSONEncoder().encode(value), forKey: key)
    }

    private enum Keys {
        static let handled = "alertsHandled"
        static let scheduled = "alertsScheduled"
        static let picks = "picksAlerted"
    }
}

/// Shows alerts while the app is open, and opens the race when one is tapped.
final class AlertDelegate: NSObject, UNUserNotificationCenterDelegate, Sendable {
    static let shared = AlertDelegate()

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let text = response.notification.request.content.userInfo["url"] as? String,
              let url = URL(string: text) else { return }
        await MainActor.run { AlertInbox.shared.url = url }
    }
}

/// A tapped alert's link, held until RootView opens it (on a cold launch the
/// tap arrives before the UI exists).
@MainActor @Observable
final class AlertInbox {
    static let shared = AlertInbox()
    var url: URL?
}
