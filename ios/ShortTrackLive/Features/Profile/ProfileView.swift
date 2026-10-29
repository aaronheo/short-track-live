import SwiftUI
import UserNotifications

/// Light, dark, or follow the iPhone. Saved on the phone; RootView applies it.
enum Appearance: String, CaseIterable {
    case system, light, dark

    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

/// The Profile tab: the account (or signing in), favorite skaters, their
/// notifications, then appearance and about.
struct ProfileView: View {
    @Environment(Favorites.self) private var favorites
    @Environment(AccountStore.self) private var account
    @AppStorage("appearance") private var appearance = Appearance.system
    @Environment(\.colorScheme) private var scheme
    @Environment(\.scenePhase) private var phase
    @State private var path: [Route] = []
    /// The rows on screen. A favorite you un-star keeps its row (empty star)
    /// until you leave, so a second tap undoes it.
    @State private var shown: [FavoriteSkater] = []
    @State private var adding = false
    @State private var permission: UNAuthorizationStatus = .notDetermined

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    if account.signedIn {
                        AccountRow()
                    } else if GoogleSignIn.isSetUp {
                        SignInCard()
                    }
                    favoritesSection
                    notificationsSection
                    appearanceSection
                    section("About") {
                        VStack(spacing: 0) {
                            row("Results", value: "ISU")
                            RowDivider(leading: 16)
                            row("Version", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "–")
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
            .scrollIndicators(.hidden)
            .tabBarHidesOnScroll()
            .background(Theme.ground)
            .navigationTitle("Profile")
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .athlete(let id): AthleteView(id: id).id(id)
                case .heat(let id): HeatView(id: id).id(id)
                case .round(let id): RoundView(id: id).id(id)
                case .event(let slug): ScheduleView(slug: slug).id(slug)
                case .ask(let question): AskView(question: question).id(question)
                }
            }
            .onAppear { shown = favorites.skaters }
        }
        .sheet(isPresented: $adding) { AddFavoritesView() }
        .overlay(alignment: .bottom) {
            if let notice = account.notice {
                Label(notice, systemImage: "checkmark")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 12)
                    .background(Color(hex: 0x0D1B2A), in: .capsule)
                    .padding(.horizontal, 24)
                    .padding(.bottom, 16)
                    .onTapGesture { account.notice = nil }
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .task(id: notice) {
                        try? await Task.sleep(for: .seconds(4))
                        account.notice = nil
                    }
            }
        }
        .animation(.snappy, value: account.notice)
        .alert("Couldn’t sign in", isPresented: Binding(get: { account.error != nil }, set: { if !$0 { account.error = nil } })) {
            Button("OK") {}
        } message: {
            Text(account.error ?? "")
        }
        .onChange(of: favorites.skaters) { _, now in
            shown += now.filter { new in !shown.contains { $0.id == new.id } }
        }
        .task(id: phase) { permission = await RaceAlerts.shared.status() }
        .sensoryFeedback(.selection, trigger: appearance)
    }

    // MARK: Favorites

    private var favoritesSection: some View {
        section("Favorite skaters") {
            VStack(spacing: 0) {
                if shown.isEmpty {
                    Text("Star skaters to follow them here and get notified when they race.")
                        .font(.subheadline)
                        .foregroundStyle(Theme.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(16)
                }
                ForEach(Array(shown.enumerated()), id: \.element.id) { index, skater in
                    if index > 0 { RowDivider(leading: 52) }
                    HStack(spacing: 0) {
                        NavigationLink(value: Route.athlete(skater.id)) {
                            SkaterLabel(name: skater.name, nat: skater.nat, iso2: skater.iso2,
                                        meta: [Fmt.country(iso2: skater.iso2, fallback: skater.nat), skater.gender].compactMap { $0 }.joined(separator: " · "))
                                .padding(.leading, 16)
                                .frame(minHeight: 60)
                                .contentShape(.rect)
                        }
                        .buttonStyle(RowButtonStyle())
                        StarButton(name: skater.name, on: favorites.contains(skater.id)) {
                            if favorites.contains(skater.id) {
                                favorites.remove(skater.id)
                            } else {
                                favorites.add(id: skater.id, name: skater.name, last: skater.last, nat: skater.nat, iso2: skater.iso2, gender: skater.gender)
                            }
                        }
                        .padding(.trailing, 6)
                    }
                }
                RowDivider(leading: shown.isEmpty ? 0 : 52)
                Button { adding = true } label: {
                    Label { Text("Add skaters").font(.callout.weight(.semibold)) } icon: {
                        Image(systemName: "plus").font(.callout.weight(.semibold)).frame(width: 24)
                    }
                    .foregroundStyle(Theme.link)
                    .padding(.horizontal, 16)
                    .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
                    .contentShape(.rect)
                }
                .buttonStyle(RowButtonStyle())
            }
        }
    }

    // MARK: Notifications

    private var notificationsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            section("Notifications") {
                NotificationToggles(picks: account.signedIn) { if permission == .notDetermined { Task { await allow() } } }
            }
            Group {
                switch permission {
                case .denied:
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Notifications are off for Short Track in iPhone Settings.")
                        Button("Open Settings") {
                            if let url = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(url) }
                        }
                        .fontWeight(.semibold)
                    }
                case .notDetermined where (!favorites.skaters.isEmpty && (favorites.notifyStarts || favorites.notifyResults))
                    || (account.signedIn && favorites.notifyPicks):
                    Button("Turn on notifications") { Task { await allow() } }
                        .fontWeight(.semibold)
                default:
                    Text(account.signedIn ? "Saved to your account. Tap a notification to open the race."
                         : "For every favorite at every ISU event. Tap one to open the race.")
                }
            }
            .font(.footnote)
            .foregroundStyle(Theme.muted)
            .padding(.horizontal, 16)
        }
    }

    private func allow() async {
        await RaceAlerts.shared.requestPermission()
        favorites.askedAboutNotifications = true
        permission = await RaceAlerts.shared.status()
        await RaceAlerts.shared.check()
    }

    // MARK: Appearance

    private var appearanceSection: some View {
        section("Appearance") {
            VStack(spacing: 0) {
                HStack(spacing: 0) {
                    choice(.light, title: "Light")
                    choice(.dark, title: "Dark")
                }
                .padding(.horizontal, 16)
                .padding(.top, 20)
                .padding(.bottom, 14)
                RowDivider(leading: 16)
                Toggle(isOn: Binding(
                    get: { appearance == .system },
                    set: { appearance = $0 ? .system : (scheme == .dark ? .dark : .light) }
                )) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Match iPhone").font(.callout.weight(.medium)).foregroundStyle(Theme.ink)
                        Text("Switches with your iPhone’s light or dark mode")
                            .font(.footnote)
                            .foregroundStyle(Theme.muted)
                    }
                }
                .tint(.green)
                .padding(.horizontal, 16)
                .frame(minHeight: 60)
            }
        }
    }

    /// The appearance in effect now (Match iPhone shows the iPhone's).
    private var current: Appearance {
        appearance == .system ? (scheme == .dark ? .dark : .light) : appearance
    }

    private func choice(_ option: Appearance, title: String) -> some View {
        let selected = current == option
        return Button {
            withAnimation(.snappy) { appearance = option }
        } label: {
            VStack(spacing: 8) {
                AppearancePreview(dark: option == .dark)
                Text(title).font(.subheadline.weight(.medium)).foregroundStyle(Theme.ink)
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(selected ? Theme.link : Theme.faint)
                    .contentTransition(.symbolEffect(.replace))
            }
            .frame(maxWidth: .infinity)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).sectionLabel().padding(.leading, 16)
            content()
                .card()
                .clipShape(.rect(cornerRadius: 16))
        }
    }

    private func row(_ title: String, value: String) -> some View {
        HStack {
            Text(title).foregroundStyle(Theme.ink)
            Spacer()
            Text(value).foregroundStyle(Theme.muted)
        }
        .font(.callout)
        .padding(.horizontal, 16)
        .frame(minHeight: 48)
    }
}

/// The notification switches, in Profile and in the first-star prompt.
struct NotificationToggles: View {
    @Environment(Favorites.self) private var favorites
    /// Show the picks switch (signed in, in Profile).
    var picks = false
    /// Called when a switch is turned on.
    var turnedOn: () -> Void = {}

    var body: some View {
        @Bindable var favorites = favorites
        VStack(spacing: 0) {
            toggle("Race about to start", note: "When a favorite’s race is next on the ice", isOn: $favorites.notifyStarts)
            RowDivider(leading: 16)
            toggle("Race results", note: favorites.notifyResults ? "Place, time and whether they advanced" : "Off, so nothing gets spoiled",
                   isOn: $favorites.notifyResults)
            if picks {
                RowDivider(leading: 16)
                toggle("Picks are open", note: "When a quarterfinal, semifinal or final gets its start list", isOn: $favorites.notifyPicks)
            }
        }
        .onChange(of: favorites.notifyStarts) { _, on in if on { turnedOn() } }
        .onChange(of: favorites.notifyResults) { _, on in if on { turnedOn() } }
        .onChange(of: favorites.notifyPicks) { _, on in if on { turnedOn() } }
    }

    private func toggle(_ title: String, note: String, isOn: Binding<Bool>) -> some View {
        Toggle(isOn: isOn) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.callout.weight(.medium)).foregroundStyle(Theme.ink)
                Text(note).font(.footnote).foregroundStyle(Theme.muted)
                    .contentTransition(.opacity)
            }
        }
        .tint(.green)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(minHeight: 68)
    }
}

/// Flag, name, and a line under it.
struct SkaterLabel: View {
    let name: String
    let nat: String?
    let iso2: String?
    let meta: String

    var body: some View {
        HStack(spacing: 12) {
            FlagView(iso2: iso2, nat: nat, size: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(name)
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(Theme.ink)
                    .lineLimit(1)
                Text(meta)
                    .font(.footnote)
                    .foregroundStyle(Theme.muted)
                    .lineLimit(2)
            }
            Spacer(minLength: 8)
        }
        .accessibilityElement(children: .combine)
    }
}

/// Filled when the skater is a favorite; tap to change.
struct StarButton: View {
    let name: String
    let on: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: on ? "star.fill" : "star")
                .font(.title3)
                .foregroundStyle(on ? Theme.star : Theme.muted)
                .contentTransition(.symbolEffect(.replace))
                .frame(width: 44, height: 44)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Favorite: \(name)")
        .accessibilityAddTraits(on ? .isSelected : [])
        .sensoryFeedback(.selection, trigger: on)
    }
}

/// A tiny phone showing the app in light or dark, whatever mode is on now.
private struct AppearancePreview: View {
    let dark: Bool

    var body: some View {
        let ground = dark ? Color(hex: 0x0B0E12) : Color(hex: 0xF4F6F8)
        let card = dark ? Color(hex: 0x161B22) : .white
        let line = dark ? Color(hex: 0x2A333D) : Color(hex: 0xD9E0E6)
        VStack(alignment: .leading, spacing: 7) {
            Capsule().fill(dark ? Color(hex: 0x3A4552) : Color(hex: 0xC9D2DA)).frame(width: 40, height: 7)
            ForEach(0..<2, id: \.self) { _ in
                VStack(alignment: .leading, spacing: 6) {
                    ForEach([0.7, 0.45, 0.6], id: \.self) { width in
                        Capsule().fill(line).frame(width: 56 * width, height: 5)
                    }
                }
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(card, in: .rect(cornerRadius: 8))
            }
            Spacer(minLength: 0)
        }
        .padding(EdgeInsets(top: 18, leading: 10, bottom: 10, trailing: 10))
        .frame(width: 92, height: 150)
        .background(ground, in: .rect(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(line, lineWidth: 1))
        .accessibilityHidden(true)
    }
}
