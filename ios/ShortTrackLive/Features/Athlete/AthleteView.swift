import SwiftUI

/// One athlete: headline numbers, best times, and every race they skated
/// (relays included), grouped under each event, filtered and sorted, loaded
/// a page at a time as you scroll.
struct AthleteView: View {
    @State private var live: Live<AthleteResponse>
    @State private var races: RaceList
    @State private var width: CGFloat = 0

    init(id: Int) {
        _live = State(initialValue: Live("athletes/\(id)") { _ in nil })
        _races = State(initialValue: RaceList(athleteID: id))
    }

    var body: some View {
        LiveContent(live: live) { data in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    AthleteHeader(athlete: data.athlete)
                    if width >= 570 {
                        HStack(alignment: .top, spacing: 14) {
                            VStack(spacing: 12) { summary(data) }.frame(width: 250)
                            VStack(alignment: .leading, spacing: 12) { RaceListView(races: races) }
                        }
                    } else {
                        summary(data)
                        RaceListView(races: races)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
            }
            .scrollIndicators(.hidden)
            .tabBarHidesOnScroll()
            .refreshable {
                await live.refresh()
                await races.refresh()
            }
        }
        .screen(title: live.value?.athlete.last ?? "Athlete")
        .toolbar {
            if let athlete = live.value?.athlete {
                ToolbarItem(placement: .topBarTrailing) { FavoriteButton(athlete: athlete) }
            }
        }
        .task { await live.run() }
        .task(id: races.generation) { await races.loadFirstPage() }
    }

    @ViewBuilder
    private func summary(_ data: AthleteResponse) -> some View {
        StatTiles(stats: data.stats)
        if !data.bests.isEmpty {
            BestTimes(bests: data.bests, since: data.stats.since)
        }
    }
}

private struct AthleteHeader: View {
    let athlete: AthleteResponse.Athlete

    var body: some View {
        HStack(spacing: 14) {
            FlagView(iso2: athlete.iso2, nat: athlete.nat, size: 30)
            VStack(alignment: .leading, spacing: 2) {
                Text(athlete.name)
                    .font(.title.weight(.bold))
                    .foregroundStyle(Theme.ink)
                Text([Fmt.country(iso2: athlete.iso2, fallback: athlete.nat), athlete.gender].compactMap { $0 }.joined(separator: " · "))
                    .font(.subheadline)
                    .foregroundStyle(Theme.muted)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// Races, events, medals. The medal tile is wider: it carries the breakdown.
private struct StatTiles: View {
    let stats: AthleteResponse.Stats
    @State private var width: CGFloat = 0

    var body: some View {
        let unit = max(0, width - 16) / 3.6
        HStack(spacing: 8) {
            tile(value: stats.races, label: "Races").frame(width: unit)
            tile(value: stats.events, label: "Events").frame(width: unit)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text("\(stats.gold + stats.silver + stats.bronze)")
                        .font(.condensed(.title))
                        .foregroundStyle(Theme.ink)
                    HStack(spacing: 6) {
                        medalCount(stats.gold, Theme.gold)
                        medalCount(stats.silver, Theme.silver)
                        medalCount(stats.bronze, Theme.bronze)
                    }
                    .font(.caption.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(Theme.text2)
                }
                .lineLimit(1)
                Text("Medals").sectionLabel()
            }
            .padding(12)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .card(radius: 14)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(stats.gold) gold, \(stats.silver) silver, \(stats.bronze) bronze medals")
        }
        .fixedSize(horizontal: false, vertical: true)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    }

    private func tile(value: Int, label: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("\(value)")
                .font(.condensed(.title))
                .foregroundStyle(Theme.ink)
                .contentTransition(.numericText(value: Double(value)))
            Text(label).sectionLabel()
        }
        .padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .card(radius: 14)
        .accessibilityElement(children: .combine)
    }

    private func medalCount(_ count: Int, _ color: Color) -> some View {
        HStack(spacing: 3) {
            Circle().fill(color).frame(width: 8, height: 8)
            Text("\(count)")
        }
    }
}

private struct BestTimes: View {
    let bests: [AthleteResponse.Best]
    let since: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                Text("Best times").font(.headline).foregroundStyle(Theme.ink)
                Spacer()
                if let since = since.flatMap(Fmt.monthYear) {
                    Text("Since \(since)").font(.caption).foregroundStyle(Theme.muted)
                }
            }
            .padding(.bottom, 8)
            ForEach(bests) { best in
                RowDivider()
                NavigationLink(value: Route.heat(best.heatId)) {
                    HStack(spacing: 12) {
                        Text(best.distance)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Theme.ink)
                            .frame(minWidth: 58, alignment: .leading)
                        Text(best.time)
                            .font(.headline)
                            .monospacedDigit()
                            .foregroundStyle(Theme.ink)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(best.event)
                            Text(best.round).foregroundStyle(Theme.faint)
                        }
                        .font(.caption)
                        .foregroundStyle(Theme.muted)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(minHeight: 48)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .combine)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 6)
        .card()
    }
}

// MARK: - Races

private struct RaceListView: View {
    @Bindable var races: RaceList
    @State private var footerVisible = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                FilterBar(races: races)
                HStack {
                    Text(races.total.map { $0 == 1 ? "1 race" : "\($0) races" } ?? " ")
                        .sectionLabel()
                        .contentTransition(.numericText(value: Double(races.total ?? 0)))
                    Spacer()
                    Button {
                        races.oldestFirst.toggle()
                    } label: {
                        Label(races.oldestFirst ? "Oldest first" : "Newest first", systemImage: "arrow.up.arrow.down")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Theme.link)
                            .frame(minHeight: 44)
                    }
                    .sensoryFeedback(.selection, trigger: races.oldestFirst)
                }
                .padding(.leading, 16)
            }

            if races.loadedFirstPage && races.races.isEmpty {
                ContentUnavailableView {
                    Label("No races", systemImage: "line.3.horizontal.decrease.circle")
                } description: {
                    Text("Nothing matches these filters.")
                } actions: {
                    Button("Clear filters") { races.filters = .init() }
                }
            }

            ForEach(races.groups, id: \.races.first!.id) { group in
                EventGroup(event: group.event, races: group.races)
            }

            footer
        }
    }

    @ViewBuilder private var footer: some View {
        if let error = races.error {
            VStack(spacing: 8) {
                Text(error.localizedDescription).font(.footnote).foregroundStyle(Theme.muted)
                Button("Try again") { Task { await races.retry() } }
                    .font(.subheadline.weight(.semibold))
            }
            .frame(maxWidth: .infinity)
        } else if races.hasMore || !races.loadedFirstPage {
            // Infinite scroll: reaching this row loads the next page.
            HStack(spacing: 10) {
                ProgressView()
                Text(races.loadedFirstPage ? "Loading more races…" : "Loading races…")
            }
            .font(.subheadline)
            .foregroundStyle(Theme.muted)
            .frame(maxWidth: .infinity, minHeight: 56)
            // Load the next page when this row scrolls into view, and again
            // after each page while it's still in view (short pages).
            .onScrollVisibilityChange(threshold: 0.01) { footerVisible = $0 }
            .task(id: "\(races.generation)-\(races.races.count)-\(footerVisible)") {
                if footerVisible && races.loadedFirstPage { await races.loadMore() }
            }
        } else if let total = races.total, total > 0 || !races.races.isEmpty {
            Text(races.races.count == 1 ? "That's the only race" : "That's all \(races.races.count) races")
                .font(.footnote)
                .foregroundStyle(Theme.faint)
                .frame(maxWidth: .infinity, minHeight: 44)
        }
    }
}

private struct FilterBar: View {
    @Bindable var races: RaceList

    var body: some View {
        let facets = races.facets
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                chip(title: races.filters.season.map(shortSeason) ?? "All seasons", active: races.filters.season != nil) {
                    option("All seasons", count: nil, selected: races.filters.season == nil) { races.filters.season = nil }
                    ForEach(facets?.seasons ?? []) { facet in
                        option(facet.label, count: facet.count, selected: races.filters.season == facet.value) {
                            races.filters.season = facet.value
                        }
                    }
                }
                chip(title: eventTitle(facets), active: races.filters.event != nil) {
                    option("All events", count: nil, selected: races.filters.event == nil) { races.filters.event = nil }
                    ForEach(seasonsOfEvents(facets), id: \.self) { season in
                        Section(shortSeason(season)) {
                            ForEach((facets?.events ?? []).filter { $0.season == season }) { facet in
                                option(facet.label, count: facet.count, selected: races.filters.event == facet.value) {
                                    races.filters.event = facet.value
                                }
                            }
                        }
                    }
                }
                chip(title: distanceTitle(facets), active: races.filters.distance != nil) {
                    option("All distances", count: nil, selected: races.filters.distance == nil) { races.filters.distance = nil }
                    ForEach(facets?.distances ?? []) { facet in
                        option(facet.label, count: facet.count, selected: races.filters.distance == facet.value) {
                            races.filters.distance = facet.value
                        }
                    }
                }
                if !races.filters.isEmpty {
                    Button("Clear") { races.filters = .init() }
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.link)
                        .frame(minHeight: 44)
                }
            }
        }
        .scrollIndicators(.hidden)
        .sensoryFeedback(.selection, trigger: races.filters)
    }

    private func chip<Items: View>(title: String, active: Bool, @ViewBuilder items: () -> Items) -> some View {
        Menu {
            items()
        } label: {
            HStack(spacing: 4) {
                Text(title).lineLimit(1)
                Image(systemName: "chevron.down").font(.caption2.weight(.bold))
            }
            .font(.footnote.weight(active ? .semibold : .medium))
            .foregroundStyle(active ? Theme.onInkFill : Theme.text2)
            .padding(.horizontal, 12)
            .frame(minHeight: 36)
            .background {
                Capsule().fill(active ? Theme.inkFill : Theme.surface)
                    .strokeBorder(active ? .clear : Theme.border, lineWidth: 1)
            }
        }
        .menuOrder(.fixed)
    }

    private func option(_ title: String, count: Int?, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            if selected { Label(title, systemImage: "checkmark") } else { Text(title) }
            if let count { Text(count == 1 ? "1 race" : "\(count) races") }
        }
    }

    private func shortSeason(_ title: String) -> String { Fmt.season(title) }

    private func eventTitle(_ facets: RaceFacets?) -> String {
        guard let slug = races.filters.event else { return "All events" }
        let label = facets?.events.first { $0.value == slug }?.label ?? "Event"
        return label.components(separatedBy: " · ").first ?? label
    }

    private func distanceTitle(_ facets: RaceFacets?) -> String {
        guard let value = races.filters.distance else { return "All distances" }
        return facets?.distances.first { $0.value == value }?.label ?? (value == "relay" ? "Relays" : "\(value) m")
    }

    private func seasonsOfEvents(_ facets: RaceFacets?) -> [String] {
        var seen: [String] = []
        for event in facets?.events ?? [] where !seen.contains(event.season ?? "") {
            seen.append(event.season ?? "")
        }
        return seen
    }
}

private struct EventGroup: View {
    let event: AthleteRace.Event
    let races: [AthleteRace]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                Text(event.name).font(.callout.weight(.bold)).foregroundStyle(Theme.ink)
                Text([event.city, Fmt.dateRangeWithYear(event.startsOn, event.endsOn)].compactMap { $0 }.joined(separator: " · "))
                    .font(.footnote)
                    .foregroundStyle(Theme.muted)
            }
            .padding(.leading, 16)
            VStack(spacing: 0) {
                ForEach(Array(races.enumerated()), id: \.element.id) { index, race in
                    if index > 0 { RowDivider(leading: 54) }
                    NavigationLink(value: Route.heat(race.heatId)) { RaceRow(race: race) }
                        .buttonStyle(RowButtonStyle())
                }
            }
            .card()
            .clipShape(.rect(cornerRadius: 16))
        }
    }
}

private struct RaceRow: View {
    let race: AthleteRace

    var body: some View {
        HStack(spacing: 10) {
            Group {
                if let medal = race.medal, let rank = race.rank {
                    Text("\(rank)")
                        .font(.condensed(.subheadline))
                        .foregroundStyle(.white)
                        .frame(width: 24, height: 24)
                        .background([Theme.gold, Theme.silver, Theme.bronze][medal - 1], in: .circle)
                } else {
                    Text(race.rank.map(String.init) ?? "–")
                        .font(.condensed(.title3))
                        .foregroundStyle(race.rank == nil ? Theme.muted : Theme.ink)
                }
            }
            .frame(width: 28, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                Text(race.distance)
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(Theme.ink)
                Text(race.round)
                    .font(.footnote)
                    .foregroundStyle(Theme.muted)
            }
            .lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)
            VStack(alignment: .trailing, spacing: 2) {
                Text(race.time ?? race.status ?? "–")
                    .font(.subheadline.weight(.medium))
                    .monospacedDigit()
                    .foregroundStyle(race.rank == nil || race.time == nil ? Theme.muted : Theme.ink)
                Text(race.day)
                    .font(.caption)
                    .foregroundStyle(Theme.muted)
            }
            .fixedSize()
            BadgeSlot(code: race.badge, width: 30)
            Chevron()
        }
        .padding(.leading, 16)
        .padding(.trailing, 12)
        .padding(.vertical, 6)
        .frame(minHeight: 56)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }
}
