import SwiftUI

enum Route: Hashable {
    case event(String) // schedule
    case round(Int)
    case heat(Int)
}

/// Navigation state for both layouts. On a phone everything is one stack
/// (Events → Schedule → Round → Heat). On wide screens (iPad, Duo unfolded)
/// the sidebar holds Events → Schedule and the detail holds Round → Heat.
/// Switching layouts (rotating, resizing) carries the position across.
@MainActor @Observable
final class AppModel {
    // Phone
    var path: [Route] = []
    // Wide
    var sidebarPath: [Route] = []
    var detailRound: Int?
    var detailPath: [Route] = []

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
        } else {
            path = sidebarPath + (detailRound.map { [Route.round($0)] } ?? []) + detailPath
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

    /// shorttrack://event/<slug>, shorttrack://round/<id>, shorttrack://heat/<id>
    func open(_ url: URL) {
        guard url.scheme == "shorttrack", let kind = url.host(), let value = url.pathComponents.dropFirst().first else { return }
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
