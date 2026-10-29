import SwiftUI

/// The Picks tab: guess the order (and penalties) of quarterfinals, semifinals
/// and finals. Phone: the list, then a pick pushed on top. Wide: side by side.
struct PicksTab: View {
    let split: Bool
    @State private var selected: Int?
    @State private var path: [Int] = []

    var body: some View {
        if split {
            NavigationSplitView(columnVisibility: .constant(.all)) {
                PicksHomeView(split: true, selected: $selected) { selected = $0 }
                    .toolbar(removing: .sidebarToggle)
                    .navigationSplitViewColumnWidth(min: 300, ideal: 340, max: 400)
            } detail: {
                NavigationStack {
                    if let selected {
                        PickView(heatId: selected).id(selected)
                    } else {
                        ContentUnavailableView("Pick a race", systemImage: "checklist",
                                               description: Text("Guess the order and who gets penalized, then see how everyone picked."))
                    }
                }
            }
            .navigationSplitViewStyle(.balanced)
        } else {
            NavigationStack(path: $path) {
                PicksHomeView(split: false, selected: .constant(nil)) { path = [$0] }
                    .navigationDestination(for: Int.self) { PickView(heatId: $0).id($0) }
            }
        }
    }
}

// MARK: - Home

private struct PicksHomeView: View {
    let split: Bool
    @Binding var selected: Int?
    let open: (Int) -> Void
    @Environment(AccountStore.self) private var account
    @Environment(\.scenePhase) private var phase
    @State private var home: PicksHome?
    @State private var failed = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                if let home {
                    content(home)
                } else if failed {
                    ContentUnavailableView("Can't load picks", systemImage: "wifi.exclamationmark",
                                           description: Text("Check your connection and try again."))
                } else {
                    ProgressView().frame(maxWidth: .infinity, minHeight: 200)
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 24)
        }
        .scrollIndicators(.hidden)
        .tabBarHidesOnScroll()
        .background(Theme.ground)
        .navigationTitle("Picks")
        .navigationBarTitleDisplayMode(split ? .inline : .large)
        .refreshable { await load() }
        // Reload on signing in or out, and every 30 s while on screen.
        .task(id: "\(account.signedIn)-\(phase == .active)") {
            guard phase == .active else { return }
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(for: .seconds(30))
            }
        }
    }

    private func load() async {
        do {
            home = try await APIClient.shared.send("GET", "/picks", account: account.session, as: PicksHome.self)
            failed = false
        } catch is CancellationError {
        } catch {
            failed = home == nil
        }
    }

    @ViewBuilder
    private func content(_ home: PicksHome) -> some View {
        if let event = home.event {
            Text([event.name, event.city].compactMap { $0 }.joined(separator: ", "))
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.muted)
                .padding(.leading, 4)
        }
        if !home.signedIn {
            SignInCard(title: "Make your picks", message: "Sign in with Google to guess the order of each race and see how you stack up.",
                       icon: "checklist", footnote: nil)
        } else if let me = home.me {
            scoreCard(me, players: home.players)
        }
        section("Pick now") {
            if home.open.isEmpty {
                Text("Start lists for quarterfinals, semifinals and finals come out the day before. They show up here.")
                    .font(.subheadline)
                    .foregroundStyle(Theme.muted)
                    .padding(16)
            } else {
                rows(home.open) { race in
                    if race.picked {
                        Label("Picked", systemImage: "checkmark.circle.fill").labelStyle(.iconOnly)
                            .font(.title3).foregroundStyle(Theme.positive)
                    } else {
                        Text("Pick").font(.subheadline.weight(.semibold)).foregroundStyle(.white)
                            .padding(.horizontal, 14).frame(height: 32).background(Theme.link, in: .capsule)
                    }
                }
            }
        }
        if !home.mine.isEmpty {
            section("Your picks") {
                rows(home.mine) { race in badge(race) }
            }
        }
        if !home.leaderboard.isEmpty {
            section("Leaderboard") {
                ForEach(Array(home.leaderboard.enumerated()), id: \.element) { index, row in
                    if index > 0 { RowDivider(leading: 16) }
                    HStack(spacing: 12) {
                        Text("\(row.rank)").font(.condensed(.headline)).foregroundStyle(Theme.muted).frame(width: 28)
                        Text(row.nickname).font(.callout.weight(row.me ? .bold : .medium)).foregroundStyle(Theme.ink)
                        Spacer()
                        Text("\(row.points)").font(.condensed(.title3)).monospacedDigit().foregroundStyle(Theme.ink)
                    }
                    .padding(.horizontal, 16)
                    .frame(minHeight: 46)
                    .background(row.me ? Theme.link.opacity(0.08) : .clear)
                }
            }
        }
    }

    private func scoreCard(_ me: PicksHome.Me, players: Int) -> some View {
        HStack(spacing: 0) {
            stat("\(me.points)", "Points")
            stat(me.rank.map(Fmt.ordinal) ?? "–", players > 0 ? "of \(players)" : "Rank")
            stat("\(me.picked)", "Picked")
        }
        .padding(.vertical, 16)
        .foregroundStyle(.white)
        .background(Theme.hero, in: .rect(cornerRadius: 20))
    }

    private func stat(_ value: String, _ label: String) -> some View {
        VStack(spacing: 2) {
            Text(value).font(.condensed(.title)).monospacedDigit()
            Text(label).font(.footnote).foregroundStyle(Theme.heroMuted)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).sectionLabel().padding(.leading, 16)
            VStack(spacing: 0) { content() }
                .card()
                .clipShape(.rect(cornerRadius: 16))
        }
    }

    private func rows<Trailing: View>(_ races: [PickSummary], @ViewBuilder trailing: @escaping (PickSummary) -> Trailing) -> some View {
        ForEach(Array(races.enumerated()), id: \.element.id) { index, race in
            if index > 0 { RowDivider(leading: 16) }
            ZStack {
                Rectangle().fill(split && selected == race.heatId ? Theme.link.opacity(0.12) : .clear)
                Button { open(race.heatId) } label: {
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(race.title).font(.callout.weight(.semibold)).foregroundStyle(Theme.ink)
                            Text([race.race, race.startsAt.map(startsText)].compactMap { $0 }.joined(separator: " · "))
                                .font(.footnote).foregroundStyle(Theme.muted)
                        }
                        Spacer(minLength: 8)
                        trailing(race)
                    }
                    .padding(.horizontal, 16)
                    .frame(minHeight: 60)
                    .contentShape(.rect)
                }
                .buttonStyle(RowButtonStyle())
                .focusEffectDisabled()
                .hoverEffectDisabled()
            }
        }
    }

    private func startsText(_ date: Date) -> String {
        date.timeIntervalSinceNow > 0 && date.timeIntervalSinceNow < 3600
            ? "in \(Int(date.timeIntervalSinceNow / 60) + 1) min"
            : date.formatted(.dateTime.weekday(.abbreviated).hour().minute())
    }

    @ViewBuilder
    private func badge(_ race: PickSummary) -> some View {
        let (text, fg, bg): (String, Color, Color) = switch race.state {
        case "running": ("LIVE", Theme.live, Theme.liveTint)
        case "official": ("+\(race.points ?? 0)", race.points ?? 0 > 0 ? Theme.positive : Theme.muted, (race.points ?? 0) > 0 ? Theme.positive.opacity(0.12) : Theme.segment)
        case "unofficial": ("Soon", Theme.muted, Theme.segment)
        default: ("Picked", Theme.link, Theme.link.opacity(0.1))
        }
        Text(text).font(.caption.weight(.bold)).foregroundStyle(fg)
            .padding(.horizontal, 9).frame(height: 24).background(bg, in: .capsule)
    }
}

// MARK: - One race

/// Pick the order, see how everyone picked, and your score once it's official.
struct PickView: View {
    let heatId: Int
    @Environment(AccountStore.self) private var account
    @Environment(\.scenePhase) private var phase
    @State private var heat: PickHeat?
    @State private var choice = PickChoice(finish: [], penalized: [])
    @State private var saving = false
    @State private var message: String?
    @State private var askNickname = false
    @State private var wide = false

    var body: some View {
        Group {
            if let heat {
                if wide && heat.crowd != nil {
                    HStack(alignment: .top, spacing: 0) {
                        pickList(heat, crowdToo: false)
                        Divider()
                        List { crowdSection(heat) }
                            .listStyle(.insetGrouped)
                            .scrollContentBackground(.hidden)
                    }
                } else {
                    pickList(heat, crowdToo: true)
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Theme.ground)
        .onGeometryChange(for: Bool.self) { $0.size.width >= 680 } action: { wide = $0 }
        .navigationTitle(heat.map { "\($0.title) · \($0.race)" } ?? "Pick")
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) { bottomBar }
        .sheet(isPresented: $askNickname) {
            NicknameSheet(purpose: "Your nickname shows on the leaderboard next to your points.") {
                Task { await save() }
            }
        }
        .task(id: phase == .active) {
            guard phase == .active else { return }
            while !Task.isCancelled {
                await load()
                // Every 15 s until the race is official.
                guard heat?.state != "official" else { return }
                try? await Task.sleep(for: .seconds(15))
            }
        }
    }

    private func load() async {
        guard let fresh = try? await APIClient.shared.send("GET", "/picks/heats/\(heatId)", account: account.session, as: PickHeat.self) else { return }
        let first = heat == nil
        withAnimation(.snappy) { heat = fresh }
        if first || fresh.locked { choice = fresh.startingChoice }
    }

    private func save() async {
        guard let heat else { return }
        saving = true
        defer { saving = false }
        do {
            if let fresh = try await APIClient.shared.send("PUT", "/picks/heats/\(heat.heatId)", body: choice, account: account.session, as: PickHeat.self) {
                withAnimation(.snappy) { self.heat = fresh }
                message = nil
            }
        } catch APIError.refused(_, _, needsNickname: true) {
            askNickname = true
        } catch {
            message = error.localizedDescription
            await load()
        }
    }

    // MARK: The list

    private func pickList(_ heat: PickHeat, crowdToo: Bool) -> some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 4) {
                    Text(heat.event).font(.subheadline).foregroundStyle(Theme.muted)
                    lockLine(heat)
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 0, leading: 4, bottom: 0, trailing: 4))
            }
            if let result = heat.result {
                resultSection(heat, result)
            } else {
                orderSection(heat)
                if !choice.penalized.isEmpty { penaltySection(heat) }
            }
            if crowdToo { crowdSection(heat) }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .environment(\.editMode, .constant(heat.locked || heat.result != nil ? .inactive : .active))
    }

    @ViewBuilder
    private func lockLine(_ heat: PickHeat) -> some View {
        if heat.state == "official" {
            Label("Official result", systemImage: "checkmark.seal.fill").font(.footnote.weight(.semibold)).foregroundStyle(Theme.positive)
        } else if heat.locked {
            Label("Locked: the race has started", systemImage: "lock.fill").font(.footnote.weight(.semibold)).foregroundStyle(Theme.muted)
        } else if let starts = heat.startsAt {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let left = starts.timeIntervalSince(context.date)
                Label(left > 0 ? "Picks lock when the race starts · \(countdown(left))" : "Picks lock when the race starts",
                      systemImage: "timer")
                    .font(.footnote.weight(.semibold)).foregroundStyle(Theme.link)
            }
        }
    }

    private func countdown(_ seconds: TimeInterval) -> String {
        let s = Int(seconds)
        return s >= 3600 ? "in \(s / 3600) h \(s % 3600 / 60) min" : "in \(s / 60):\(String(format: "%02d", s % 60))"
    }

    private func orderSection(_ heat: PickHeat) -> some View {
        Section {
            ForEach(Array(choice.finish.enumerated()), id: \.element) { index, id in
                if let entry = heat.entry(id) {
                    PickRow(place: index + 1, entry: entry, penalized: false, locked: heat.locked,
                            cutAbove: heat.cut.flatMap { $0.after == index && index > 0 ? $0.label : nil }) {
                        togglePenalty(id)
                    }
                }
            }
            .onMove { from, to in
                choice.finish.move(fromOffsets: from, toOffset: to)
            }
            .moveDisabled(heat.locked)
        } header: {
            Text(heat.locked ? "Your pick" : "Finishing order")
        } footer: {
            if !heat.locked {
                Text("Starts in start order. Drag to change it. PEN moves a skater to the penalties. 3 points for an exact place, 1 for one place off, 3 for a penalty called right.")
            }
        }
    }

    private func penaltySection(_ heat: PickHeat) -> some View {
        Section("Penalized") {
            ForEach(choice.penalized, id: \.self) { id in
                if let entry = heat.entry(id) {
                    PickRow(place: nil, entry: entry, penalized: true, locked: heat.locked, cutAbove: nil) { togglePenalty(id) }
                        .moveDisabled(true)
                }
            }
        }
    }

    private func togglePenalty(_ id: Int) {
        withAnimation(.snappy) {
            if let i = choice.penalized.firstIndex(of: id) {
                choice.penalized.remove(at: i)
                choice.finish.append(id)
            } else {
                choice.finish.removeAll { $0 == id }
                choice.penalized.append(id)
            }
        }
    }

    private func resultSection(_ heat: PickHeat, _ result: PickHeat.Result) -> some View {
        Section {
            if let score = result.score {
                HStack(spacing: 14) {
                    VStack(spacing: 0) {
                        Text("\(score.points)").font(.condensed(.largeTitle))
                        Text("of \(score.max)").font(.caption).foregroundStyle(Theme.heroMuted)
                    }
                    Text(score.points == score.max ? "A perfect pick." : "You scored \(score.points) points.")
                        .font(.headline)
                    Spacer()
                }
                .foregroundStyle(.white)
                .listRowBackground(Theme.hero)
            }
            ForEach(result.entries, id: \.self) { line in
                if let entry = heat.entry(line.entryId) {
                    let mine = result.score?.entries.first { $0.entryId == line.entryId }
                    HStack(spacing: 12) {
                        Text(line.rank.map(String.init) ?? (line.status ?? "–"))
                            .font(.condensed(.title3)).frame(width: 34)
                        FlagView(iso2: entry.iso2, nat: entry.nat, size: 16)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(entry.name).font(.callout.weight(.semibold)).lineLimit(1)
                            Text([line.time, mine.map { "You: \(Fmt.pickPlace($0.picked))" }].compactMap { $0 }.joined(separator: " · "))
                                .font(.footnote).foregroundStyle(Theme.muted)
                        }
                        Spacer()
                        if let mine {
                            Text("+\(mine.points)").font(.caption.weight(.bold))
                                .foregroundStyle(mine.points >= 3 ? Theme.positive : mine.points > 0 ? Theme.link : Theme.muted)
                                .padding(.horizontal, 8).frame(height: 24)
                                .background((mine.points >= 3 ? Theme.positive : mine.points > 0 ? Theme.link : Theme.muted).opacity(0.12), in: .capsule)
                        }
                    }
                    .frame(minHeight: 50)
                }
            }
        } header: {
            Text("Result")
        } footer: {
            if result.score == nil { Text("You didn't pick this race.") }
        }
    }

    // MARK: How everyone picked

    @ViewBuilder
    private func crowdSection(_ heat: PickHeat) -> some View {
        if let crowd = heat.crowd {
            Section {
                ForEach(crowd.entries.map(CrowdLine.init), id: \.self) { line in
                    if let entry = heat.entry(line.entryId) {
                        CrowdRow(entry: entry, line: line, mine: myOutcome(entry.entryId, heat), places: heat.entries.count)
                    }
                }
                if let most = crowd.mostPicked, crowd.picks > 1 {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Most picked order").font(.footnote.weight(.semibold)).foregroundStyle(Theme.muted)
                        Text((most.finish.compactMap { heat.entry($0)?.last } .joined(separator: ", "))
                             + (most.penalized.isEmpty ? "" : " · " + most.penalized.compactMap { heat.entry($0)?.last }.joined(separator: ", ") + " penalized"))
                            .font(.callout.weight(.semibold))
                        Text("\(most.share)% of picks").font(.footnote).foregroundStyle(Theme.muted)
                    }
                    .padding(.vertical, 4)
                }
            } header: {
                HStack { Text("How everyone picked"); Spacer(); Text("\(crowd.picks) pick\(crowd.picks == 1 ? "" : "s")") }
            } footer: {
                Text("Bars show how many people picked each place, or a penalty. Your pick is in blue. Tap a skater for the numbers.")
            }
        }
    }

    /// Your pick for this skater: 1-based place, 0 for a penalty, nil if you didn't pick.
    private func myOutcome(_ id: Int, _ heat: PickHeat) -> Int? {
        guard let pick = heat.myPick else { return nil }
        if pick.penalized.contains(id) { return 0 }
        return pick.finish.firstIndex(of: id).map { $0 + 1 }
    }

    // MARK: Bottom bar

    @ViewBuilder
    private var bottomBar: some View {
        if let heat, !heat.locked {
            VStack(spacing: 6) {
                if let message { Text(message).font(.footnote).foregroundStyle(Theme.live) }
                if account.signedIn {
                    Button { Task { await save() } } label: {
                        Group {
                            if saving { ProgressView().tint(.white) }
                            else { Text(heat.myPick == nil ? "Lock in my pick" : (heat.myPick == choice ? "Picked · change it until the start" : "Update my pick")) }
                        }
                        .font(.headline)
                        .frame(maxWidth: .infinity, minHeight: 52)
                        .foregroundStyle(.white)
                        .background(heat.myPick == choice ? Theme.positive : Theme.link, in: .capsule)
                    }
                    .buttonStyle(.plain)
                    .disabled(saving || heat.myPick == choice)
                } else {
                    SignInCard(title: "Sign in to pick", message: "Picks are saved to your account so they can be scored.",
                               icon: "checklist", footnote: nil)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .background(.bar)
        }
    }
}

private struct PickRow: View {
    let place: Int?
    let entry: PickHeat.Entry
    let penalized: Bool
    let locked: Bool
    /// Draw the cut line above this row ("To the final").
    let cutAbove: String?
    let togglePenalty: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Group {
                if let place {
                    Text("\(place)").font(.condensed(.title3)).foregroundStyle(Theme.link)
                } else {
                    RoundedRectangle(cornerRadius: 2).fill(Theme.yellowCard).frame(width: 12, height: 16).rotationEffect(.degrees(8))
                        .accessibilityLabel("Penalized")
                }
            }
            .frame(width: 26)
            FlagView(iso2: entry.iso2, nat: entry.nat, size: 16)
            VStack(alignment: .leading, spacing: 1) {
                Text(entry.name).font(.callout.weight(.semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                if let start = entry.start {
                    Text("Starts \(Fmt.ordinal(start))").font(.caption).foregroundStyle(Theme.muted)
                }
            }
            Spacer(minLength: 6)
            if !locked {
                Button(action: togglePenalty) {
                    Text("PEN").font(.caption.weight(.bold))
                        .foregroundStyle(penalized ? Color(hex: 0x3A2E00) : Theme.muted)
                        .padding(.horizontal, 10).frame(height: 30)
                        .background(penalized ? Theme.yellowCard : .clear, in: .capsule)
                        .overlay(Capsule().strokeBorder(penalized ? Theme.yellowCard : Theme.border, lineWidth: 1.5))
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Penalty for \(entry.name)")
                .accessibilityAddTraits(penalized ? .isSelected : [])
            }
        }
        .frame(minHeight: 50)
        .overlay(alignment: .top) {
            if let cutAbove {
                HStack(spacing: 6) {
                    Line().stroke(style: StrokeStyle(lineWidth: 1.5, dash: [5, 4])).frame(height: 1)
                    Text("\(cutAbove.uppercased()) ↑").font(.caption2.weight(.bold)).foregroundStyle(Theme.muted).fixedSize()
                    Line().stroke(style: StrokeStyle(lineWidth: 1.5, dash: [5, 4])).frame(height: 1)
                }
                .foregroundStyle(Theme.faint)
                .offset(y: -10)
                .accessibilityLabel(cutAbove)
            }
        }
    }

    private struct Line: Shape {
        func path(in rect: CGRect) -> Path { Path { $0.move(to: CGPoint(x: 0, y: rect.midY)); $0.addLine(to: CGPoint(x: rect.maxX, y: rect.midY)) } }
    }
}

private struct CrowdRow: View {
    let entry: PickHeat.Entry
    let line: CrowdLine
    /// Your pick: place, 0 = penalty, nil = none.
    let mine: Int?
    let places: Int
    @State private var open = false

    var body: some View {
        Button { withAnimation(.snappy) { open.toggle() } } label: {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 10) {
                    FlagView(iso2: entry.iso2, nat: entry.nat, size: 15)
                    Text(entry.name).font(.callout.weight(.semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                    Spacer(minLength: 6)
                    VStack(alignment: .trailing, spacing: 0) {
                        Text("MOST PICKED").font(.caption2.weight(.semibold)).foregroundStyle(Theme.muted)
                        HStack(alignment: .firstTextBaseline, spacing: 4) {
                            Text(Fmt.pickPlace(line.top)).font(.condensed(.title3))
                                .foregroundStyle(line.top == nil ? Color(hex: 0x8A6400) : Theme.ink)
                            Text("\(line.topShare)%").font(.footnote.weight(.semibold)).foregroundStyle(Theme.muted)
                        }
                    }
                }
                HStack(alignment: .bottom, spacing: 5) {
                    ForEach(Array(line.shares.enumerated()), id: \.offset) { i, share in
                        let isPen = i == line.shares.count - 1
                        let isMine = mine.map { $0 == 0 ? isPen : $0 == i + 1 } ?? false
                        VStack(spacing: 2) {
                            RoundedRectangle(cornerRadius: 2)
                                .fill(isMine ? Theme.link : isPen ? Theme.yellowCard.opacity(0.7) : Theme.link.opacity(0.18))
                                .frame(height: max(3, CGFloat(share) / CGFloat(max(line.topShare, 1)) * 26))
                            Text(isPen ? "PEN" : Fmt.ordinal(i + 1)).font(.caption2.weight(isMine ? .bold : .regular))
                                .foregroundStyle(isMine ? Theme.link : Theme.muted)
                            if open { Text("\(share)%").font(.caption2.weight(.semibold)).monospacedDigit().foregroundStyle(Theme.ink) }
                        }
                        .frame(maxWidth: .infinity)
                    }
                }
                .frame(minHeight: 44, alignment: .bottom)
                .accessibilityHidden(true)
            }
            .padding(.vertical, 4)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(entry.name): most picked \(Fmt.pickPlace(line.top)), \(line.topShare) percent")
    }
}

// MARK: - Nickname

/// Choose or change the name on the leaderboard (and in chat later).
struct NicknameSheet: View {
    var purpose = "Your nickname shows on the Picks leaderboard, and in race chat later."
    var saved: () -> Void = {}
    @Environment(AccountStore.self) private var account
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var error: String?
    @State private var saving = false
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                Text(purpose).font(.subheadline).foregroundStyle(Theme.muted)
                TextField("Nickname", text: $name)
                    .textContentType(.nickname)
                    .autocorrectionDisabled()
                    .focused($focused)
                    .submitLabel(.done)
                    .onSubmit { Task { await save() } }
                    .font(.title3)
                    .padding(14)
                    .card(radius: 12)
                if let error { Text(error).font(.footnote).foregroundStyle(Theme.live) }
                Text("2–20 letters, numbers or spaces. You can change it in Account.").font(.footnote).foregroundStyle(Theme.muted)
                Spacer()
            }
            .padding(16)
            .background(Theme.ground)
            .navigationTitle("Choose a nickname")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }.disabled(saving || name.trimmingCharacters(in: .whitespaces).count < 2)
                }
            }
        }
        .presentationDetents([.medium])
        .onAppear {
            name = account.account?.nickname ?? ""
            focused = true
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            try await account.setNickname(name)
            dismiss()
            saved()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
