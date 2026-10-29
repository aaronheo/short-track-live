import SwiftUI

/// The Standings tab: ISU's standings, this season's or a past one's. On a
/// phone a skater opens in a sheet; on wide screens (Duo unfolded, iPad) the
/// list sits beside them.
struct StandingsTab: View {
    let split: Bool
    /// nil = the latest season.
    @State private var season: String?
    @State private var live = StandingsTab.load(season: nil)
    @State private var selection: StandingSelection?

    private static func load(season: String?) -> Live<StandingsResponse> {
        Live(season.map { "standings/\(Fmt.seasonPath($0))" } ?? "standings") { _ in .seconds(300) }
    }

    private func pick(_ picked: String) {
        season = picked == live.value?.seasons?.first ? nil : picked
        live = Self.load(season: season)
        selection = nil
    }

    var body: some View {
        if split {
            NavigationSplitView(columnVisibility: .constant(.all)) {
                StandingsList(live: live, selection: $selection, split: true, pick: pick)
                    .toolbar(removing: .sidebarToggle) // the sidebar stays open
                    .navigationSplitViewColumnWidth(min: 320, ideal: 360, max: 420)
            } detail: {
                NavigationStack {
                    Group {
                        if let selection, let data = live.value {
                            StandingDetail(selection: selection, book: StandingsBook(response: data), inSheet: false).id(selection)
                        } else {
                            ContentUnavailableView("Pick a skater", systemImage: "trophy",
                                                   description: Text("See their place, points and where they came from."))
                        }
                    }
                    .navigationDestination(for: Route.self) { route in StandingsDestination(route: route) }
                }
            }
            .navigationSplitViewStyle(.balanced)
        } else {
            NavigationStack {
                StandingsList(live: live, selection: $selection, split: false, pick: pick)
                    .navigationDestination(for: Route.self) { route in StandingsDestination(route: route) }
            }
            .sheet(item: $selection) { selection in
                NavigationStack {
                    if let data = live.value {
                        StandingDetail(selection: selection, book: StandingsBook(response: data), inSheet: true)
                            .navigationDestination(for: Route.self) { route in StandingsDestination(route: route) }
                    }
                }
            }
        }
    }
}

/// A skater in one of the lists.
struct StandingSelection: Hashable, Identifiable {
    let entry: StandingEntry
    let list: StandingList
    var id: String { "\(list.id)-\(entry.id)" }
}

private struct StandingsDestination: View {
    let route: Route

    var body: some View {
        switch route {
        case .athlete(let id): AthleteView(id: id).id(id)
        case .heat(let id): HeatView(id: id).id(id)
        case .round(let id): RoundView(id: id).id(id)
        case .event(let slug): ScheduleView(slug: slug).id(slug)
        case .ask(let question): AskView(question: question).id(question)
        }
    }
}

private struct StandingsList: View {
    let live: Live<StandingsResponse>
    @Binding var selection: StandingSelection?
    let split: Bool
    /// Switches season.
    let pick: (String) -> Void
    @Environment(Favorites.self) private var favorites
    @AppStorage("standingsGender") private var gender = "Women"
    /// The list picked per category, by key ("overall", "500"), so it stays picked in another season.
    @State private var chosen: [String: String] = [:]

    var body: some View {
        LiveContent(live: live) { data in
            let book = StandingsBook(response: data)
            let lists = book.lists(for: gender)
            if lists.isEmpty {
                ContentUnavailableView("No standings yet", systemImage: "trophy",
                                       description: Text("ISU publishes the standings after the first event of the season."))
            } else {
                let list = lists.first { $0.key == chosen[gender] } ?? lists[0]
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        Picker("Category", selection: $gender.animation(.snappy)) {
                            Text("Women").tag("Women")
                            Text("Men").tag("Men")
                        }
                        .pickerStyle(.segmented)
                        .padding(.horizontal, 16)
                        chips(lists, current: list)
                        section(list, book: book)
                    }
                    .padding(.bottom, 24)
                }
                .scrollIndicators(.hidden)
                .tabBarHidesOnScroll()
                .refreshable { await live.refresh() }
            }
        }
        .background(Theme.ground)
        .navigationTitle("Standings")
        .navigationBarTitleDisplayMode(split ? .inline : .large)
        .toolbar {
            if let data = live.value, let season = data.season {
                ToolbarItem(placement: .topBarTrailing) {
                    if let seasons = data.seasons, seasons.count > 1 {
                        seasonMenu(season, seasons: seasons)
                    } else {
                        Text(Fmt.season(season)).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.muted)
                    }
                }
            }
        }
        .task(id: ObjectIdentifier(live)) { await live.run() }
    }

    /// The same season menu as Events.
    private func seasonMenu(_ season: String, seasons: [String]) -> some View {
        Menu {
            Picker("Season", selection: Binding(get: { season }, set: pick)) {
                ForEach(seasons, id: \.self) { Text(Fmt.season($0)).tag($0) }
            }
        } label: {
            HStack(spacing: 4) {
                Text(Fmt.season(season)).font(.subheadline.weight(.semibold))
                Image(systemName: "chevron.down").font(.caption.weight(.bold))
            }
            .foregroundStyle(Theme.ink)
        }
        .accessibilityLabel("Season \(Fmt.season(season)). Change season")
    }

    private func chips(_ lists: [StandingList], current: StandingList) -> some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(lists) { list in
                    let on = list.id == current.id
                    Button {
                        withAnimation(.snappy) { chosen[gender] = list.key }
                    } label: {
                        Text(list.title)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(on ? Theme.onInkFill : Theme.ink)
                            .padding(.horizontal, 14)
                            .frame(height: 36)
                            .background(on ? Theme.inkFill : Theme.surface, in: .capsule)
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(on ? .isSelected : [])
                }
            }
            .padding(.horizontal, 16)
        }
        .scrollIndicators(.hidden)
        .sensoryFeedback(.selection, trigger: current.id)
    }

    private func section(_ list: StandingList, book: StandingsBook) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline) {
                    Text(heading(list)).sectionLabel()
                    Spacer()
                    Text(progress(book)).font(.footnote).foregroundStyle(Theme.muted)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(heading(list)).sectionLabel()
                    Text(progress(book)).font(.footnote).foregroundStyle(Theme.muted)
                }
            }
            .padding(.horizontal, 16)
            VStack(spacing: 0) {
                let leader = list.entries.first?.points ?? 0
                ForEach(Array(list.entries.enumerated()), id: \.element.id) { index, entry in
                    if index > 0 { RowDivider(leading: 58) }
                    let selected = split && selection?.entry == entry && selection?.list == list
                    let row = StandingRow(entry: entry, compact: split,
                                          favorite: entry.skaterId.map(favorites.contains) ?? false,
                                          gap: index == 0 ? (list.kind == "overall" ? "Leader" : nil) : "−\((leader - entry.points).formatted())")
                    // A plain rectangle behind the row (not a modifier on the button, which
                    // iOS clips to rounded corners), so the highlight runs edge to edge.
                    ZStack {
                        Rectangle().fill(selected ? Theme.link.opacity(0.12) : entry.rank == 1 ? Theme.link.opacity(0.04) : .clear)
                        if entry.skaterId != nil {
                            Button { selection = StandingSelection(entry: entry, list: list) } label: { row }
                                .buttonStyle(RowButtonStyle())
                                .focusEffectDisabled()
                                .hoverEffectDisabled()
                                .accessibilityAddTraits(selected ? .isSelected : [])
                        } else {
                            row
                        }
                    }
                }
            }
            .card()
            .clipShape(.rect(cornerRadius: 16))
            .padding(.horizontal, 16)
            Text(rule(list, book: book))
                .font(.footnote)
                .foregroundStyle(Theme.muted)
                .padding(.horizontal, 32)
        }
    }

    private func progress(_ book: StandingsBook) -> String { book.progress }

    private func heading(_ list: StandingList) -> String {
        switch list.kind {
        case "overall": "Crystal Globe · \(gender)"
        case "nations": "Nations"
        default: list.gender == "Mixed" ? "Mixed team relay" : "\(gender) \(list.title.lowercased())"
        }
    }

    private func rule(_ list: StandingList, book: StandingsBook) -> String {
        let series = book.series
        switch list.kind {
        case "overall": return "Points from the 500, 1000 and 1500 m at every \(series) event. Tap a skater to see where their points came from."
        case "nations": return "Every skater’s and relay team’s points for their country."
        default:
            guard let points = book.response.pointsPerPlace, points.count >= 3 else { return "Points from every \(series) event." }
            return "Points at each \(series) event: \(points[0]) for 1st, \(points[1]) for 2nd, \(points[2]) for 3rd."
        }
    }
}

private struct StandingRow: View {
    let entry: StandingEntry
    /// Sidebar rows (wide layouts) are a step smaller, per the wide layout kit.
    var compact = false
    let favorite: Bool
    let gap: String?

    var body: some View {
        HStack(spacing: 10) {
            Text("\(entry.rank)")
                .font(.condensed(compact ? .headline : .title3))
                .foregroundStyle(entry.rank == 1 ? Theme.link : Theme.ink)
                .frame(width: compact ? 24 : 30)
            FlagView(iso2: entry.iso2, nat: entry.nat, size: compact ? 15 : 18)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    Text(entry.name).font((compact ? Font.subheadline : .callout).weight(.semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                    if favorite {
                        Image(systemName: "star.fill").font(.caption2).foregroundStyle(Theme.star).accessibilityLabel("Favorite")
                    }
                }
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 2) {
                Text(entry.points.formatted()).font(.condensed(compact ? .headline : .title3)).monospacedDigit().foregroundStyle(Theme.ink)
                if let gap, !compact { Text(gap).font(.caption).monospacedDigit().foregroundStyle(Theme.muted) }
            }
        }
        .padding(.leading, compact ? 8 : 12)
        .padding(.trailing, compact ? 12 : 16)
        .padding(.vertical, compact ? 4 : 8)
        .frame(minHeight: compact ? 48 : 60)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }
}

/// One skater's standing: where they are and where their points came from.
struct StandingDetail: View {
    let selection: StandingSelection
    let book: StandingsBook
    /// On a phone it's a sheet with a Done button; wide, it's the detail pane.
    let inSheet: Bool
    @Environment(\.dismiss) private var dismiss

    private var entry: StandingEntry { selection.entry }
    private var list: StandingList { selection.list }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                header
                stats
                earned
                if let id = entry.skaterId {
                    NavigationLink(value: Route.athlete(id)) {
                        Label("All of \(entry.last)’s races", systemImage: "list.bullet")
                            .font(.callout.weight(.semibold))
                            .frame(maxWidth: .infinity, minHeight: 50)
                            .card()
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Theme.link)
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 32)
        }
        .scrollIndicators(.hidden)
        .background(Theme.ground)
        .navigationTitle(entry.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(removing: .title) // the header shows the name; the title is for the back button
        .toolbar {
            if inSheet {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
    }

    private var header: some View {
        HStack(spacing: 14) {
            FlagView(iso2: entry.iso2, nat: entry.nat, size: 30)
            Text(entry.name).font(.title2.weight(.bold)).foregroundStyle(Theme.ink)
        }
        .padding(.top, 8)
    }

    private var stats: some View {
        let leader = list.entries.first?.points ?? entry.points
        return HStack(spacing: 0) {
            stat(Fmt.ordinal(entry.rank), list.kind == "overall" ? "Overall" : list.title)
            Divider().frame(height: 40)
            stat(entry.points.formatted(), "Points")
            Divider().frame(height: 40)
            stat(entry.points == leader ? "Leader" : "−\((leader - entry.points).formatted())", entry.points == leader ? "" : "To 1st")
        }
        .padding(.vertical, 14)
        .card()
    }

    private func stat(_ value: String, _ label: String) -> some View {
        VStack(spacing: 2) {
            Text(value).font(.condensed(.title)).monospacedDigit().foregroundStyle(Theme.ink)
            if !label.isEmpty { Text(label).font(.footnote).foregroundStyle(Theme.muted) }
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var earned: some View {
        let rows = book.pointsSoFar(for: entry, gender: list.gender)
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text(book.racedCount == book.response.events.count ? "Points by event" : "Points so far").sectionLabel().padding(.leading, 16)
                VStack(spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                        if index > 0 { RowDivider(leading: 16) }
                        HStack(spacing: 12) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text([row.distance, row.place].compactMap { $0 }.joined(separator: " · "))
                                    .font(.callout.weight(.medium))
                                    .foregroundStyle(Theme.ink)
                                Text(row.event).font(.footnote).foregroundStyle(Theme.muted)
                            }
                            Spacer()
                            Text("\(row.points)").font(.condensed(.title3)).monospacedDigit().foregroundStyle(Theme.ink)
                        }
                        .padding(.horizontal, 16)
                        .frame(minHeight: 56)
                    }
                }
                .card()
            }
        }
    }
}
