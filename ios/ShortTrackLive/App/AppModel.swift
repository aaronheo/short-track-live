import SwiftUI

enum Route: Hashable {
    case event(String) // schedule
    case round(Int)
    case heat(Int)
    case athlete(Int)
    case ask(String) // the first question of a conversation
}

enum AppTab: Hashable {
    case events, standings, picks, profile, search
}

/// Navigation state for both layouts. On a phone everything is one stack
/// (Events → Schedule → Round → Heat). On wide screens (iPad, Duo unfolded)
/// the sidebar holds Events → Schedule and the detail holds Round → Heat.
/// Switching layouts (rotating, resizing) carries the position across.
@MainActor @Observable
final class AppModel {
    var tab: AppTab = .events
    /// A race to open in the Picks tab (from a "picks are open" alert).
    var pickHeat: Int?

    // Events tab. Phone:
    var path: [Route] = []
    // Wide:
    var sidebarPath: [Route] = []
    var detailRound: Int?
    var detailPath: [Route] = []

    // Search tab. Phone: one stack (athlete → heat). Wide: results in the
    // sidebar, the athlete in the detail.
    var searchPath: [Route] = []
    var searchAthlete: Int?
    var searchQuestion: String?
    var searchDetailPath: [Route] = []

    private(set) var isSplit = false
    /// The round on screen, after any switch with the round chips; the
    /// schedule highlights it in the sidebar.
    var visibleRound: Int?
    /// Set when the round was opened from a schedule row, so it zooms out of that row.
    var zoomSource: Int?

    func setSplit(_ split: Bool) {
        guard split != isSplit else { return }
        isSplit = split
        if split {
            sidebarPath = path.filter { if case .event = $0 { true } else { false } }
            detailRound = path.lazy.compactMap { if case .round(let id) = $0 { id } else { nil } }.last
            detailPath = path.filter { if case .heat = $0 { true } else { false } }
            if detailRound == nil { detailPath = [] }
            // The search detail pane starts with the first athlete or conversation.
            searchAthlete = nil
            searchQuestion = nil
            searchDetailPath = []
            if let first = searchPath.first {
                switch first {
                case .athlete(let id): searchAthlete = id
                case .ask(let question): searchQuestion = question
                default: break
                }
                searchDetailPath = Array(searchPath.dropFirst())
            }
        } else {
            path = sidebarPath + (detailRound.map { [Route.round($0)] } ?? []) + detailPath
            let root: [Route] = searchQuestion.map { [.ask($0)] } ?? searchAthlete.map { [.athlete($0)] } ?? []
            searchPath = root + searchDetailPath
        }
    }

    /// From the search field: start a conversation with this question.
    func openAsk(_ question: String) {
        tab = .search
        if isSplit {
            searchQuestion = question
            searchAthlete = nil
            searchDetailPath = []
        } else {
            searchPath = [.ask(question)]
        }
    }

    /// A link in an answer: athletes and races open on top of the conversation.
    func openFromAsk(_ url: URL) -> Bool {
        guard url.scheme == "shorttrack", let kind = url.host(), let value = url.pathComponents.dropFirst().first,
              let id = Int(value) else { return false }
        let route: Route
        switch kind {
        case "athlete": route = .athlete(id)
        case "heat": route = .heat(id)
        case "round": route = .round(id)
        default: return false
        }
        if isSplit { searchDetailPath.append(route) } else { searchPath.append(route) }
        return true
    }

    /// From search results (or a recent athlete).
    func openAthlete(_ id: Int) {
        tab = .search
        if isSplit {
            searchAthlete = id
            searchQuestion = nil
            searchDetailPath = []
        } else {
            searchPath = [.athlete(id)]
        }
    }

    func openEvent(_ slug: String) {
        if isSplit {
            sidebarPath = [.event(slug)]
            detailRound = nil
            detailPath = []
        } else {
            path = [.event(slug)]
        }
    }

    /// From a schedule row, or from "On the ice" on the events screen (which
    /// also opens that event's schedule underneath).
    func openRound(_ id: Int, event slug: String? = nil, zoom: Bool = false) {
        zoomSource = zoom ? id : nil
        if isSplit {
            if let slug, sidebarPath != [.event(slug)] { sidebarPath = [.event(slug)] }
            detailRound = id
            detailPath = []
        } else {
            var base = path.filter { if case .event = $0 { true } else { false } }
            if let slug { base = [.event(slug)] }
            path = base + [.round(id)]
        }
    }

    func openHeat(_ id: Int) {
        if isSplit { detailPath.append(.heat(id)) } else { path.append(.heat(id)) }
    }

    /// shorttrack://event/<slug>, shorttrack://round/<id>, shorttrack://heat/<id>, shorttrack://athlete/<id>, shorttrack://pick/<heat id>
    func open(_ url: URL) {
        guard url.scheme == "shorttrack", let kind = url.host(), let value = url.pathComponents.dropFirst().first else { return }
        if kind == "athlete" {
            if let id = Int(value) { openAthlete(id) }
            return
        }
        if kind == "pick" {
            if let id = Int(value) { tab = .picks; pickHeat = id }
            return
        }
        tab = .events
        switch kind {
        case "event": openEvent(value)
        case "round": if let id = Int(value) { openRound(id) }
        case "heat":
            guard let id = Int(value) else { return }
            if isSplit { detailPath = [.heat(id)] } else { path = path.filter { if case .heat = $0 { false } else { true } } + [.heat(id)] }
        default: break
        }
    }
}
