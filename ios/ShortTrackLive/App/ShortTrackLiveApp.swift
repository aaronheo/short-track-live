import SwiftUI
import UserNotifications

@main
struct ShortTrackLiveApp: App {
    @Environment(\.scenePhase) private var phase

    init() {
        UNUserNotificationCenter.current().delegate = AlertDelegate.shared
    }

    var body: some Scene {
        WindowGroup {
            RootView()
        }
        // Checks favorites' races for notifications when iOS gives the app time.
        .backgroundTask(.appRefresh(RaceAlerts.refreshTask)) {
            await RaceAlerts.shared.backgroundRefresh()
        }
        .onChange(of: phase) { _, phase in
            if phase == .background { RaceAlerts.shared.scheduleRefresh() }
        }
    }
}

/// Tabs: Events, Profile, and Search (iOS's search tab, which sits apart).
/// Wide windows (iPad, Duo unfolded: about 626 pt portrait, 890 landscape)
/// get sidebar layouts; phones get one stack per tab.
struct RootView: View {
    @State private var model = AppModel()
    @State private var favorites = Favorites.shared
    @State private var inbox = AlertInbox.shared
    @Environment(\.scenePhase) private var phase
    @State private var split = false
    @State private var tabBarAtSide = false
    @AppStorage("appearance") private var appearance = Appearance.system

    var body: some View {
        TabView(selection: $model.tab) {
            Tab("Events", systemImage: "calendar", value: AppTab.events) {
                if split { SplitLayout() } else { StackLayout() }
            }
            Tab("Profile", systemImage: "person.crop.circle", value: AppTab.profile) {
                ProfileView()
            }
            Tab("Search", systemImage: "magnifyingglass", value: AppTab.search, role: .search) {
                SearchTab(split: split, tabBarAtSide: tabBarAtSide)
            }
        }
        // Width decides the layout (not a GeometryReader around the tabs,
        // which stops the tab bar from seeing the scrolling).
        .onGeometryChange(for: Bool.self) { $0.size.width >= 600 } action: { split = $0 }
        .onChange(of: split, initial: true) { _, split in model.setSplit(split) }
        // The Duo's cover screen puts the status and tab bars down the trailing
        // edge: an inset on that side only (a landscape phone has both sides inset).
        .onGeometryChange(for: Bool.self) { $0.safeAreaInsets.trailing > $0.safeAreaInsets.leading + 20 } action: { tabBarAtSide = $0 }
        .environment(model)
        .environment(favorites)
        .tint(Theme.link)
        .preferredColorScheme(appearance.colorScheme)
        .onOpenURL { model.open($0) }
        // A tapped notification opens its race.
        .onChange(of: inbox.url, initial: true) { _, url in
            guard let url else { return }
            model.open(url)
            inbox.url = nil
        }
        // While the app is open, check favorites' races: every 30 s while
        // one is racing, else every 5 minutes.
        .task(id: phase == .active) {
            guard phase == .active else { return }
            while !Task.isCancelled {
                let busy = await RaceAlerts.shared.check(favorites)
                try? await Task.sleep(for: busy ? .seconds(30) : .seconds(300))
            }
        }
        .onChange(of: favorites.skaters) { Task { await RaceAlerts.shared.check(favorites) } }
    }
}

/// The tab bar hides while you scroll down and comes back when you scroll
/// up or reach the top. Put on each screen's scroll view.
struct TabBarHidesOnScroll: ViewModifier {
    @State private var hidden = false

    func body(content: Content) -> some View {
        content
            .onScrollGeometryChange(for: CGFloat.self) { $0.contentOffset.y + $0.contentInsets.top } action: { old, new in
                let next = new < 24 ? false : new - old > 6 ? true : new - old < -6 ? false : hidden
                if next != hidden { withAnimation(.snappy) { hidden = next } }
            }
            // .automatic, not .visible: a root screen saying .visible would
            // keep the bar up over a pushed screen that hides it (Ask).
            .toolbarVisibility(hidden ? .hidden : .automatic, for: .tabBar)
    }
}

extension View {
    func tabBarHidesOnScroll() -> some View { modifier(TabBarHidesOnScroll()) }
}

private struct StackLayout: View {
    @Environment(AppModel.self) private var model
    @Namespace private var zoom

    var body: some View {
        @Bindable var model = model
        NavigationStack(path: $model.path) {
            EventsView()
                .navigationDestination(for: Route.self) { route in
                    switch route {
                    // .id: a destination swapped in place (deep link) must
                    // start fresh, not keep the previous one's state.
                    case .event(let slug):
                        ScheduleView(slug: slug).id(slug)
                    case .round(let id):
                        if model.zoomSource == id {
                            RoundView(id: id).id(id).navigationTransition(.zoom(sourceID: id, in: zoom))
                        } else {
                            RoundView(id: id).id(id)
                        }
                    case .heat(let id):
                        HeatView(id: id).id(id)
                    case .athlete(let id):
                        AthleteView(id: id).id(id)
                    case .ask(let question):
                        AskView(question: question).id(question)
                    }
                }
        }
        .environment(\.zoomNamespace, zoom)
    }
}

private struct SplitLayout: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        NavigationSplitView(columnVisibility: .constant(.all)) {
            NavigationStack(path: $model.sidebarPath) {
                EventsView()
                    .navigationDestination(for: Route.self) { route in
                        if case .event(let slug) = route { ScheduleView(slug: slug).id(slug) }
                    }
            }
            .toolbar(removing: .sidebarToggle) // the sidebar stays open
            .navigationSplitViewColumnWidth(min: 260, ideal: 300, max: 360)
        } detail: {
            NavigationStack(path: $model.detailPath) {
                Group {
                    if let id = model.detailRound {
                        RoundView(id: id).id(id)
                    } else {
                        ContentUnavailableView("Pick a race", systemImage: "list.bullet.rectangle",
                                               description: Text("Choose an event, then a race from its schedule."))
                    }
                }
                .navigationDestination(for: Route.self) { route in
                    if case .heat(let id) = route { HeatView(id: id).id(id) }
                }
            }
        }
        .navigationSplitViewStyle(.balanced)
    }
}

extension EnvironmentValues {
    /// Schedule rows register as zoom sources for the round they open (phone only).
    @Entry var zoomNamespace: Namespace.ID? = nil
}

/// Ground color and hidden title used by every screen. The title stays set so
/// the next screen's back button reads "Schedule", "Quarterfinals" etc.
extension View {
    func screen(title: String) -> some View {
        background(Theme.ground)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(removing: .title)
            .toolbarBackground(Theme.ground, for: .navigationBar)
    }
}
