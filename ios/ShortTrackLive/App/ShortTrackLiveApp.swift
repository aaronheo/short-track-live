import SwiftUI

@main
struct ShortTrackLiveApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}

/// Two tabs: Events and Search (iOS's search tab). Wide windows (iPad, Duo
/// unfolded: about 626 pt portrait, 890 landscape) get sidebar layouts;
/// phones get one stack per tab.
struct RootView: View {
    @State private var model = AppModel()

    var body: some View {
        GeometryReader { geo in
            let split = geo.size.width >= 600
            TabView(selection: $model.tab) {
                Tab("Events", systemImage: "calendar", value: AppTab.events) {
                    if split { SplitLayout() } else { StackLayout() }
                }
                Tab("Search", systemImage: "magnifyingglass", value: AppTab.search, role: .search) {
                    SearchTab(split: split)
                }
            }
            .onChange(of: split, initial: true) { _, split in model.setSplit(split) }
        }
        .environment(model)
        .tint(Theme.link)
        .onOpenURL { model.open($0) }
    }
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
                    }
                }
        }
        .environment(\.zoomNamespace, zoom)
    }
}

private struct SplitLayout: View {
    @Environment(AppModel.self) private var model
    @State private var columns = NavigationSplitViewVisibility.all

    var body: some View {
        @Bindable var model = model
        NavigationSplitView(columnVisibility: $columns) {
            NavigationStack(path: $model.sidebarPath) {
                EventsView()
                    .navigationDestination(for: Route.self) { route in
                        if case .event(let slug) = route { ScheduleView(slug: slug).id(slug) }
                    }
            }
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
