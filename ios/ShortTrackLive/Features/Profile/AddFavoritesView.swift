import SwiftUI

/// Sheet from Profile: the latest event's medalists to start with, or any
/// skater by name. Stars add and remove favorites right away.
struct AddFavoritesView: View {
    @Environment(Favorites.self) private var favorites
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var suggested: SuggestedSkatersResponse?
    @State private var results: [AthleteHit] = []
    @State private var resultsFor = ""
    @State private var failed = false

    private var trimmed: String { query.trimmingCharacters(in: .whitespaces) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    if trimmed.count >= 2 {
                        if failed && results.isEmpty {
                            note("Can’t search skaters right now")
                        } else if resultsFor == trimmed && results.isEmpty {
                            note("No skater matches “\(trimmed)”")
                        } else if !results.isEmpty {
                            list(title: results.count == 1 ? "1 skater" : "\(results.count) skaters",
                                 rows: results.map { ($0.id, $0.name, $0.last, $0.nat, $0.iso2, $0.gender, $0.gender, $0.helmet) })
                        }
                    } else if let suggested, !suggested.skaters.isEmpty {
                        list(title: suggested.event.map { "Medalists at \($0)" } ?? "Medalists",
                             rows: suggested.skaters.map { ($0.id, $0.name, $0.last, $0.nat, $0.iso2, $0.gender, $0.note, $0.helmet) })
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .scrollDismissesKeyboard(.immediately)
            .background(Theme.ground)
            .navigationTitle("Add skaters")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search skaters")
            .task {
                suggested = try? await APIClient.shared.get("favorites/suggested", cached: false, as: SuggestedSkatersResponse.self)
            }
            .task(id: trimmed) { await search() }
        }
    }

    private typealias Row = (id: Int, name: String, last: String, nat: String?, iso2: String?, gender: String?, note: String?, helmet: Int?)

    private func list(title: String, rows: [Row]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).sectionLabel().padding(.leading, 16)
            VStack(spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                    if index > 0 { RowDivider(leading: 52) }
                    HStack(spacing: 0) {
                        SkaterLabel(name: row.name, nat: row.nat, iso2: row.iso2, helmet: row.helmet,
                                    meta: [Fmt.country(iso2: row.iso2, fallback: row.nat), row.note].compactMap { $0 }.joined(separator: " · "))
                            .padding(.leading, 16)
                        StarButton(name: row.name, on: favorites.contains(row.id)) {
                            if favorites.contains(row.id) {
                                favorites.remove(row.id)
                            } else {
                                favorites.add(id: row.id, name: row.name, last: row.last, nat: row.nat, iso2: row.iso2, gender: row.gender, helmet: row.helmet)
                            }
                        }
                        .padding(.trailing, 6)
                    }
                    .frame(minHeight: 60)
                }
            }
            .card()
            .clipShape(.rect(cornerRadius: 16))
        }
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(Theme.muted)
            .padding(.leading, 16)
            .padding(.top, 8)
    }

    private func search() async {
        guard trimmed.count >= 2 else {
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

/// The star on an athlete's page. The first favorite asks about notifications.
struct FavoriteButton: View {
    let athlete: AthleteResponse.Athlete
    @Environment(Favorites.self) private var favorites
    @State private var asking = false

    var body: some View {
        let on = favorites.contains(athlete.id)
        Button {
            if on {
                favorites.remove(athlete.id)
                return
            }
            favorites.add(id: athlete.id, name: athlete.name, last: athlete.last, nat: athlete.nat, iso2: athlete.iso2, gender: athlete.gender, helmet: athlete.helmet)
            guard !favorites.askedAboutNotifications else { return }
            Task {
                if await RaceAlerts.shared.status() == .notDetermined { asking = true } else { favorites.askedAboutNotifications = true }
            }
        } label: {
            Image(systemName: on ? "star.fill" : "star")
                .foregroundStyle(on ? Theme.star : Theme.ink)
                .contentTransition(.symbolEffect(.replace))
        }
        .accessibilityLabel("Favorite")
        .accessibilityAddTraits(on ? .isSelected : [])
        .sensoryFeedback(.success, trigger: on) { _, now in now }
        .sheet(isPresented: $asking) {
            NotificationsPrompt(name: athlete.name)
                .presentationDetents([.height(480), .large])
        }
    }
}

/// Asked once, after the first star: which notifications, then iOS's own prompt.
private struct NotificationsPrompt: View {
    let name: String
    @Environment(Favorites.self) private var favorites
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let any = favorites.notifyStarts || favorites.notifyResults
        ScrollView {
            VStack(spacing: 16) {
                VStack(spacing: 8) {
                    Image(systemName: "star.fill")
                        .font(.system(size: 28))
                        .foregroundStyle(Theme.star)
                        .frame(width: 56, height: 56)
                        .background(Theme.star.opacity(0.14), in: .circle)
                    Text("\(name) is a favorite")
                        .font(.title2.weight(.bold))
                        .foregroundStyle(Theme.ink)
                        .multilineTextAlignment(.center)
                    Text("Get a notification when your favorites race?")
                        .font(.subheadline)
                        .foregroundStyle(Theme.muted)
                        .multilineTextAlignment(.center)
                }
                .padding(.top, 8)
                NotificationToggles()
                    .card()
                    .clipShape(.rect(cornerRadius: 16))
                VStack(spacing: 4) {
                    Button {
                        Task {
                            if any {
                                await RaceAlerts.shared.requestPermission()
                                await RaceAlerts.shared.check()
                            }
                            favorites.askedAboutNotifications = true
                            dismiss()
                        }
                    } label: {
                        Text(any ? "Turn on notifications" : "Done")
                            .font(.body.weight(.semibold))
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.capsule)
                    Button("Not now") {
                        favorites.askedAboutNotifications = true
                        dismiss()
                    }
                    .frame(minHeight: 44)
                    Text("Change this anytime in Profile")
                        .font(.footnote)
                        .foregroundStyle(Theme.muted)
                }
            }
            .padding(20)
        }
        .scrollBounceBehavior(.basedOnSize)
        .background(Theme.ground)
        .onDisappear { favorites.askedAboutNotifications = true }
    }
}
