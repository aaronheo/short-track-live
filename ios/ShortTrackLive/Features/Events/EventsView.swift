import SwiftUI

struct EventsView: View {
    @Environment(AppModel.self) private var model
    /// nil = the latest season.
    @State private var season: String?
    @State private var live = EventsView.load(season: nil)
    @State private var showAll = false

    private static func load(season: String?) -> Live<EventsResponse> {
        Live("seasons/\(season.map(Fmt.seasonPath) ?? "current")/events") { _ in .seconds(60) }
    }

    var body: some View {
        LiveContent(live: live) { data in
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if let current = data.live {
                        LiveEventCard(live: current)
                    }
                    lists(data)
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
            .scrollIndicators(.hidden)
            .refreshable { await live.refresh() }
        }
        .background(Theme.ground)
        .navigationTitle("Events")
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            if let data = live.value, data.seasons.count > 1 {
                ToolbarItem(placement: .topBarTrailing) { seasonMenu(data) }
            }
        }
        .task(id: season) { await live.run() }
    }

    private func seasonMenu(_ data: EventsResponse) -> some View {
        Menu {
            Picker("Season", selection: Binding(
                get: { data.season },
                set: { picked in
                    season = picked == data.seasons.first ? nil : picked
                    live = Self.load(season: season)
                    showAll = false
                }
            )) {
                ForEach(data.seasons, id: \.self) { Text(Fmt.season($0)).tag($0) }
            }
        } label: {
            HStack(spacing: 4) {
                Text(Fmt.season(data.season)).font(.subheadline.weight(.semibold))
                Image(systemName: "chevron.down").font(.caption.weight(.bold))
            }
            .foregroundStyle(Theme.ink)
        }
        .accessibilityLabel("Season \(Fmt.season(data.season)). Change season")
    }

    @ViewBuilder
    private func lists(_ data: EventsResponse) -> some View {
        let upcoming = data.events.filter { $0.state == .upcoming }
        let finished = data.events.filter { $0.state == .finished }.reversed()
        if !upcoming.isEmpty {
            EventSection(title: "Coming up", events: Array(upcoming)) {
                if !finished.isEmpty {
                    RowDivider()
                    Button {
                        withAnimation(.snappy) { showAll.toggle() }
                    } label: {
                        Text(showAll ? "Hide earlier events" : "All \(data.events.count) events this season")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Theme.link)
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                }
            }
        }
        if upcoming.isEmpty || showAll, !finished.isEmpty {
            EventSection(title: upcoming.isEmpty && data.live == nil ? "Events" : "Earlier this season", events: Array(finished)) {}
                .transition(.opacity.combined(with: .move(edge: .top)))
        }
        if data.events.isEmpty {
            ContentUnavailableView("No events yet", systemImage: "calendar",
                                   description: Text("ISU hasn't published events for this season."))
        }
    }
}

/// The dark card for the event that's on now.
private struct LiveEventCard: View {
    @Environment(AppModel.self) private var model
    let live: LiveEvent

    private var title: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(live.event.shortName)
                .font(.condensed(.largeTitle))
                .textCase(.uppercase)
                .foregroundStyle(.white)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text("\(Fmt.place(live.event)) · \(Fmt.dateRange(live.event.startsOn, live.event.endsOn))")
                .font(.subheadline)
                .foregroundStyle(Theme.heroMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            Button { model.openEvent(live.event.slug) } label: {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 10) {
                        LiveBadge()
                        Text("Day \(live.day) of \(live.days)")
                            .font(.footnote)
                            .foregroundStyle(Theme.heroMuted)
                    }
                    // Side by side on a phone; the sidebar is too narrow for the link.
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .lastTextBaseline) {
                            title
                            Spacer(minLength: 12)
                            HStack(spacing: 2) {
                                Text("Schedule")
                                Chevron(color: Theme.heroMuted)
                            }
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(Theme.heroMuted)
                            .fixedSize()
                        }
                        title
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 20)
                .padding(.bottom, 16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)

            if let ice = live.onTheIce {
                Rectangle().fill(Theme.heroDivider).frame(height: 1).padding(.horizontal, 20)
                Button { model.openRound(ice.roundId, event: live.event.slug) } label: {
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("On the ice")
                                .font(.caption.weight(.semibold))
                                .tracking(0.7)
                                .textCase(.uppercase)
                                .foregroundStyle(Theme.heroMuted)
                            Text("\(ice.competition) · \(ice.round)")
                                .font(.headline)
                                .foregroundStyle(.white)
                            if let detail = [ice.heat, ice.lap].compactMap({ $0 }).joined(separator: " · ").nonEmpty {
                                Text(detail)
                                    .font(.subheadline)
                                    .monospacedDigit()
                                    .foregroundStyle(Theme.heroMuted)
                                    .contentTransition(.numericText())
                            }
                        }
                        Spacer()
                        Chevron(color: Theme.heroMuted)
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 16)
                    .padding(.bottom, 20)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
            }
        }
        .background(Theme.hero, in: .rect(cornerRadius: 20))
    }
}

private struct EventSection<Footer: View>: View {
    @Environment(AppModel.self) private var model
    let title: String
    let events: [EventSummary]
    @ViewBuilder let footer: () -> Footer

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).sectionLabel().padding(.leading, 16)
            VStack(spacing: 0) {
                ForEach(Array(events.enumerated()), id: \.element.id) { index, event in
                    if index > 0 { RowDivider(leading: 72) }
                    Button { model.openEvent(event.slug) } label: { EventRow(event: event) }
                        .buttonStyle(RowButtonStyle())
                }
                footer()
            }
            .card()
            .clipShape(.rect(cornerRadius: 16))
        }
    }
}

private struct EventRow: View {
    let event: EventSummary

    var body: some View {
        let block = Fmt.dateBlock(event.startsOn)
        HStack(spacing: 12) {
            VStack(spacing: 0) {
                Text(block.month)
                    .font(.caption2.weight(.semibold))
                    .tracking(0.6)
                    .foregroundStyle(Theme.muted)
                Text(block.day)
                    .font(.condensed(.title2))
                    .foregroundStyle(Theme.ink)
            }
            .frame(width: 44)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(event.shortName)
                        .font(.callout.weight(.semibold))
                        .foregroundStyle(Theme.ink)
                    if event.state == .live { LiveDot() }
                }
                Text("\(Fmt.place(event)) · \(Fmt.dateRange(event.startsOn, event.endsOn))")
                    .font(.footnote)
                    .foregroundStyle(Theme.muted)
            }
            Spacer(minLength: 8)
            Chevron()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
        .frame(minHeight: 56)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }
}

/// Highlight on press for rows inside cards.
struct RowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Theme.divider : .clear)
    }
}

extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
