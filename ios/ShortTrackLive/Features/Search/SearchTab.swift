import SwiftUI

/// The Search tab: type a name to find an athlete and their races, or a
/// question to ask about results. One stack on a phone; results in the
/// sidebar and the athlete or conversation beside them on wide screens.
struct SearchTab: View {
    @Environment(AppModel.self) private var model
    let split: Bool
    @State private var query = ""

    var body: some View {
        @Bindable var model = model
        if split {
            NavigationSplitView {
                SearchResults(query: query)
                    .navigationTitle("Search")
                    .searchable(text: $query, placement: .sidebar, prompt: "Search or ask")
                    .navigationSplitViewColumnWidth(min: 260, ideal: 300, max: 360)
            } detail: {
                NavigationStack(path: $model.searchDetailPath) {
                    Group {
                        if let question = model.searchQuestion {
                            AskView(question: question).id(question)
                        } else if let id = model.searchAthlete {
                            AthleteView(id: id).id(id)
                        } else {
                            ContentUnavailableView("Search or ask", systemImage: "magnifyingglass",
                                                   description: Text("Find an athlete by name, or ask a question about results."))
                        }
                    }
                    .navigationDestination(for: Route.self) { route in destination(route) }
                }
            }
            .navigationSplitViewStyle(.balanced)
        } else {
            NavigationStack(path: $model.searchPath) {
                SearchResults(query: query)
                    .navigationTitle("Search")
                    .searchable(text: $query, prompt: "Search or ask")
                    .navigationDestination(for: Route.self) { route in destination(route) }
            }
        }
    }

    @ViewBuilder
    private func destination(_ route: Route) -> some View {
        switch route {
        case .athlete(let id): AthleteView(id: id).id(id)
        case .heat(let id): HeatView(id: id).id(id)
        case .round(let id): RoundView(id: id).id(id)
        case .ask(let question): AskView(question: question).id(question)
        case .event(let slug): ScheduleView(slug: slug).id(slug)
        }
    }
}

/// Someone you opened before, shown when the search field is empty.
struct RecentAthlete: Codable, Hashable, Identifiable {
    let id: Int
    let name: String
    let nat: String?
    let iso2: String?
    let gender: String?
    let races: Int
}

private struct SearchResults: View {
    @Environment(AppModel.self) private var model
    let query: String
    @State private var results: [AthleteHit] = []
    @State private var resultsFor = ""
    @State private var failed = false
    @AppStorage("recentAthletes") private var recentData = Data()

    private var trimmed: String { query.trimmingCharacters(in: .whitespaces) }

    private var recent: [RecentAthlete] {
        (try? JSONDecoder().decode([RecentAthlete].self, from: recentData)) ?? []
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if trimmed.count < 2 {
                    if !recent.isEmpty { recentSection }
                    suggestionsSection
                } else if isQuestion {
                    askCard
                } else {
                    if failed && results.isEmpty {
                        Label("Can’t search athletes right now", systemImage: "wifi.exclamationmark")
                            .font(.subheadline)
                            .foregroundStyle(Theme.muted)
                            .padding(.leading, 16)
                    } else if resultsFor == trimmed && results.isEmpty {
                        Text("No athletes match “\(trimmed)”")
                            .font(.subheadline)
                            .foregroundStyle(Theme.muted)
                            .padding(.leading, 16)
                    } else if !results.isEmpty {
                        section(title: results.count == 1 ? "1 athlete" : "\(results.count) athletes") {
                            ForEach(Array(results.enumerated()), id: \.element.id) { index, hit in
                                if index > 0 { RowDivider(leading: 52) }
                                row(id: hit.id, name: hit.name, nat: hit.nat, iso2: hit.iso2, gender: hit.gender, races: hit.races)
                            }
                        }
                    }
                    askRow
                }
            }
            .padding(.horizontal, model.isSplit ? 10 : 16)
            .padding(.top, 8)
            .padding(.bottom, 24)
        }
        .scrollDismissesKeyboard(.immediately)
        .tabBarHidesOnScroll()
        .background(Theme.ground)
        .task(id: trimmed) { await search() }
        .onSubmit(of: .search) {
            // Return on a question (or a name with no matches) asks it.
            if isQuestion || (resultsFor == trimmed && results.isEmpty && trimmed.count >= 2) { model.openAsk(trimmed) }
        }
    }

    private var isQuestion: Bool { AskText.looksLikeQuestion(trimmed) }

    private static let suggestions = [
        "Who has won the most 500 m finals?",
        "How did Courtney Sarault do at the Olympics?",
        "Who won the men’s 1500 m in Vancouver?",
    ]

    private var suggestionsSection: some View {
        section(title: "Try asking") {
            ForEach(Array(Self.suggestions.enumerated()), id: \.offset) { index, question in
                if index > 0 { RowDivider(leading: 52) }
                Button { model.openAsk(question) } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "sparkles")
                            .font(.callout)
                            .foregroundStyle(Theme.link)
                            .frame(width: 24)
                        Text(question)
                            .font(.callout.weight(.medium))
                            .foregroundStyle(Theme.ink)
                            .multilineTextAlignment(.leading)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .frame(minHeight: 52)
                    .contentShape(.rect)
                }
                .buttonStyle(RowButtonStyle())
            }
        }
    }

    /// The query reads like a question: ask it.
    private var askCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { model.openAsk(trimmed) } label: {
                HStack(spacing: 12) {
                    Image(systemName: "sparkles")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Theme.link)
                        .frame(width: 34, height: 34)
                        .background(Theme.link.opacity(0.12), in: .circle)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Ask").font(.footnote.weight(.bold)).foregroundStyle(Theme.link)
                        Text(trimmed).font(.callout.weight(.semibold)).foregroundStyle(Theme.ink)
                            .multilineTextAlignment(.leading)
                    }
                    Spacer(minLength: 8)
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                        .foregroundStyle(Theme.link)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .frame(minHeight: 68)
                .card()
                .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Theme.link, lineWidth: 1.5))
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            Text("Answered by AI from ISU results")
                .font(.footnote)
                .foregroundStyle(Theme.muted)
                .padding(.leading, 16)
        }
    }

    /// Under name results, in case it was meant as a question.
    private var askRow: some View {
        Button { model.openAsk(trimmed) } label: {
            HStack(spacing: 12) {
                Image(systemName: "sparkles")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.link)
                    .frame(width: 28, height: 28)
                    .background(Theme.link.opacity(0.12), in: .circle)
                (Text("Ask about “") + Text(trimmed).fontWeight(.bold).foregroundColor(Theme.ink) + Text("”"))
                    .font(.callout.weight(.medium))
                    .foregroundStyle(Theme.text3)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Chevron()
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 56)
            .card()
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }

    private var recentSection: some View {
        section(title: "Recent", action: ("Clear", { withAnimation(.snappy) { recentData = Data() } })) {
            ForEach(Array(recent.enumerated()), id: \.element.id) { index, athlete in
                if index > 0 { RowDivider(leading: 52) }
                row(id: athlete.id, name: athlete.name, nat: athlete.nat, iso2: athlete.iso2, gender: athlete.gender, races: athlete.races)
            }
        }
    }

    private func section<Content: View>(title: String, action: (String, () -> Void)? = nil,
                                        @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(title).sectionLabel()
                Spacer()
                if let action {
                    Button(action.0, action: action.1)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.link)
                }
            }
            .padding(.leading, 16)
            VStack(spacing: 0) { content() }
                .card()
                .clipShape(.rect(cornerRadius: 16))
        }
    }

    private func row(id: Int, name: String, nat: String?, iso2: String?, gender: String?, races: Int) -> some View {
        let selected = model.isSplit && model.searchAthlete == id
        return Button {
            remember(RecentAthlete(id: id, name: name, nat: nat, iso2: iso2, gender: gender, races: races))
            model.openAthlete(id)
        } label: {
            HStack(spacing: 12) {
                FlagView(iso2: iso2, nat: nat, size: 18)
                VStack(alignment: .leading, spacing: 2) {
                    Text(highlighted(name))
                        .lineLimit(1)
                    Text([Fmt.country(iso2: iso2, fallback: nat), gender, "\(races) races"].compactMap { $0 }.joined(separator: " · "))
                        .font(.footnote)
                        .foregroundStyle(Theme.muted)
                }
                Spacer(minLength: 8)
                Chevron()
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .frame(minHeight: 60)
            .background(selected ? Theme.divider : .clear)
            .contentShape(.rect)
        }
        .buttonStyle(RowButtonStyle())
        .accessibilityElement(children: .combine)
    }

    /// The name with the typed text in bold.
    private func highlighted(_ name: String) -> AttributedString {
        var text = AttributedString(name)
        text.font = .callout.weight(.medium)
        text.foregroundColor = Theme.text3
        if trimmed.count >= 2, let range = text.range(of: trimmed, options: [.caseInsensitive, .diacriticInsensitive]) {
            text[range].font = .callout.weight(.bold)
            text[range].foregroundColor = Theme.ink
        }
        return text
    }

    private func remember(_ athlete: RecentAthlete) {
        let list = [athlete] + recent.filter { $0.id != athlete.id }
        recentData = (try? JSONEncoder().encode(Array(list.prefix(8)))) ?? Data()
    }

    private func search() async {
        guard trimmed.count >= 2, !isQuestion else {
            results = []
            resultsFor = ""
            return
        }
        try? await Task.sleep(for: .milliseconds(250)) // wait for typing to pause
        if Task.isCancelled { return }
        do {
            let response = try await APIClient.shared.get("athletes", query: [URLQueryItem(name: "q", value: trimmed)],
                                                          cached: false, as: AthleteSearchResponse.self)
            if let response, !Task.isCancelled {
                withAnimation(.snappy) {
                    results = response.results
                    resultsFor = trimmed
                }
                failed = false
            }
        } catch is CancellationError {
        } catch let error as URLError where error.code == .cancelled {
        } catch {
            failed = true
        }
    }
}
