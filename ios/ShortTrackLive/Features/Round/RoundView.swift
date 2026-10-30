import SwiftUI

/// One round of a competition: the qualification card, finished heats
/// (collapsed), the heat on the ice, and start lists for the rest.
struct RoundView: View {
    @Environment(AppModel.self) private var model
    @State private var current: Int
    @State private var live: Live<RoundResponse>
    /// Heats the user opened or closed; nil keeps the default.
    @State private var expanded: Set<Int>?

    init(id: Int) {
        _current = State(initialValue: id)
        _live = State(initialValue: RoundView.load(id))
    }

    private static func load(_ id: Int) -> Live<RoundResponse> {
        Live("rounds/\(id)") { round in
            if round.round.state == .live || round.heats.contains(where: { $0.state == .running || $0.state == .unofficial }) {
                return .seconds(10)
            }
            if round.round.state == .upcoming || round.heats.contains(where: { !$0.state.isFinished }) { return .seconds(30) }
            return nil // finished and official: it won't change again
        }
    }

    var body: some View {
        LiveContent(live: live) { data in
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    RoundHeader(data: data, pick: switchRound)
                    RoundBody(data: data, updatedAt: live.updatedAt, expanded: expandedBinding(data))
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
            .scrollIndicators(.hidden)
            .tabBarHidesOnScroll()
            .refreshable { await live.refresh() }
        }
        .screen(title: live.value?.round.name ?? "Round")
        .task(id: current) { await live.run() }
        .onChange(of: current, initial: true) { _, id in model.visibleRound = id }
        .sensoryFeedback(.success, trigger: officialCount) { old, new in
            if let old, let new { new > old } else { false }
        }
    }

    private var officialCount: Int? {
        live.value?.heats.filter { $0.state == .official }.count
    }

    private func switchRound(_ id: Int) {
        guard id != current else { return }
        current = id
        expanded = nil
        live = Self.load(id)
    }

    /// Finals open by default; heats that feed a places card start closed.
    private func expandedBinding(_ data: RoundResponse) -> Binding<Set<Int>> {
        Binding(
            get: { expanded ?? (data.places == nil ? Set(data.heats.filter { $0.state.isFinished }.map(\.id)) : []) },
            set: { expanded = $0 }
        )
    }
}

// MARK: - Header

private struct RoundHeader: View {
    let data: RoundResponse
    let pick: (Int) -> Void
    @AppStorage(RaceTimes.key) private var venueTime = true

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text(data.round.competition)
                    .font(.title.weight(.bold))
                    .foregroundStyle(Theme.ink)
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(Theme.muted)
            }
            if data.siblings.count > 1 {
                RoundChips(siblings: data.siblings, current: data.round.id, pick: pick)
            }
            if data.progress.total > 0 {
                ProgressStrip(heats: data.heats, progress: data.progress)
            }
        }
    }

    /// "Quarterfinals · Fri 23 · 16:41 PT", in the times chosen in Profile.
    private var subtitle: String {
        let zone = RaceTimes.zone(venue: data.event.timeZone, venueTime: venueTime)
        var parts = [data.round.name]
        if let start = data.round.startsAt {
            parts.append(Fmt.dayLabel(start, in: zone))
            parts.append("\(Fmt.clock(start, in: zone)) \(Fmt.zoneName(zone, at: start))")
        }
        return parts.joined(separator: " · ")
    }
}

private struct RoundChips: View {
    let siblings: [RoundResponse.Sibling]
    let current: Int
    let pick: (Int) -> Void

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal) {
                HStack(spacing: 8) {
                    ForEach(siblings) { sibling in
                        let selected = sibling.id == current
                        Button { pick(sibling.id) } label: {
                            Text(sibling.name)
                                .font(.subheadline.weight(selected ? .semibold : .medium))
                                .foregroundStyle(selected ? Theme.onInkFill : Theme.text2)
                                .padding(.horizontal, 14)
                                .frame(minHeight: 36)
                                .background {
                                    Capsule().fill(selected ? Theme.inkFill : Theme.surface)
                                        .strokeBorder(selected ? .clear : Theme.border, lineWidth: 1)
                                }
                        }
                        .buttonStyle(.plain)
                        .id(sibling.id)
                        .accessibilityAddTraits(selected ? .isSelected : [])
                    }
                }
                .padding(.horizontal, 16)
            }
            .scrollIndicators(.hidden)
            .padding(.horizontal, -16)
            .onAppear { proxy.scrollTo(current, anchor: .center) }
            .onChange(of: current) { _, id in withAnimation(.snappy) { proxy.scrollTo(id, anchor: .center) } }
            .sensoryFeedback(.selection, trigger: current)
        }
    }
}

/// "4 of 7 heats finished" over one segment per heat (ink done, red racing).
private struct ProgressStrip: View {
    let heats: [HeatBlock]
    let progress: RoundResponse.Progress

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("\(progress.finished) of \(progress.total) heats finished")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Theme.text2)
                .contentTransition(.numericText(value: Double(progress.finished)))
            HStack(spacing: 4) {
                ForEach(heats) { heat in
                    Capsule()
                        .fill(heat.state.isFinished ? Theme.inkFill : heat.state == .running ? Theme.live : Theme.border)
                        .frame(height: 6)
                }
            }
            .accessibilityHidden(true)
        }
    }
}

// MARK: - Body

/// One column on phones; on wide screens, results on the left and what's
/// racing next on the right.
private struct RoundBody: View {
    let data: RoundResponse
    let updatedAt: Date?
    @Binding var expanded: Set<Int>
    @State private var width: CGFloat = 0

    var body: some View {
        Group {
            if width >= 570 {
                HStack(alignment: .top, spacing: 12) {
                    VStack(spacing: 12) { results }.frame(maxWidth: .infinity)
                    VStack(spacing: 12) { racing }.frame(maxWidth: .infinity)
                }
            } else {
                VStack(spacing: 12) {
                    results
                    racing
                }
            }
        }
        .frame(maxWidth: .infinity)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    }

    private var finished: [HeatBlock] {
        let done = data.heats.filter { $0.state.isFinished }
        // Final B races first, but Final A is what people come for.
        if data.places == nil, done.allSatisfy({ $0.name.hasPrefix("Final") }) {
            return done.sorted { $0.name < $1.name }
        }
        return done
    }

    private var running: HeatBlock? { data.heats.first { $0.state == .running } }
    private var waiting: [HeatBlock] { data.heats.filter { $0.state == .scheduled || $0.state == .startList } }

    @ViewBuilder private var results: some View {
        if let places = data.places, !(places.qualified.skaters.isEmpty && places.time == nil && finished.isEmpty) {
            PlacesCardView(card: places)
        }
        if !finished.isEmpty {
            FinishedHeats(heats: finished, isRelay: data.round.isRelay, expanded: $expanded)
        }
    }

    @ViewBuilder private var racing: some View {
        if let running {
            LiveHeatCard(heat: running, updatedAt: updatedAt)
        }
        ForEach(Array(waiting.enumerated()), id: \.element.id) { index, heat in
            StartListCard(heat: heat, upNext: index == 0, venue: data.event.timeZone)
        }
    }
}
