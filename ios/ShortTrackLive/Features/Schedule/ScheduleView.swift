import SwiftUI

/// The event's running order by venue day. Tapping a race opens its round.
struct ScheduleView: View {
    @Environment(AppModel.self) private var model
    @State private var live: Live<ScheduleResponse>
    @State private var day: String?
    @State private var showEarlier = false
    @AppStorage("scheduleInVenueTime") private var venueTime = true

    init(slug: String) {
        _live = State(initialValue: Live("events/\(slug)/schedule") { schedule in
            schedule.event.summary.state == .finished ? nil : .seconds(30)
        })
    }

    var body: some View {
        LiveContent(live: live) { data in
            let zone = TimeZone(identifier: data.event.timeZone) ?? .current
            let selected = data.days.first { $0.key == day } ?? defaultDay(data, zone: zone)
            VStack(spacing: 0) {
                header(data, selected: selected)
                ScrollViewReader { proxy in
                    ScrollView {
                        if let selected {
                            rows(selected, zone: zone)
                                .padding(.horizontal, 16)
                                .padding(.bottom, 24)
                        } else {
                            ContentUnavailableView("No schedule yet", systemImage: "calendar",
                                                   description: Text("ISU hasn't published the running order."))
                        }
                    }
                    .scrollIndicators(.hidden)
                    .refreshable { await live.refresh() }
                    .onAppear {
                        if let target = selected?.items.first(where: { $0.state == .live })?.id {
                            proxy.scrollTo(target, anchor: .center)
                        }
                    }
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { zoneMenu(zone) }
            }
        }
        .screen(title: "Schedule")
        .task { await live.run() }
    }

    // MARK: Header

    private func header(_ data: ScheduleResponse, selected: ScheduleResponse.Day?) -> some View {
        let event = data.event.summary
        return VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(event.shortName)
                    .font(.condensed(.largeTitle))
                    .textCase(.uppercase)
                    .foregroundStyle(Theme.ink)
                Text([event.city, Fmt.dateRange(event.startsOn, event.endsOn)].compactMap { $0 }.joined(separator: " · "))
                    .font(.subheadline)
                    .foregroundStyle(Theme.muted)
            }
            if data.days.count > 1 {
                DayTabs(days: data.days, selected: selected?.key) { key in
                    withAnimation(.snappy) {
                        day = key
                        showEarlier = false
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.bottom, 14)
    }

    private func zoneMenu(_ zone: TimeZone) -> some View {
        Menu {
            Picker("Times", selection: $venueTime) {
                Text("Venue time · \(Fmt.zoneName(zone))").tag(true)
                Text("Your time · \(Fmt.zoneName(.current))").tag(false)
            }
        } label: {
            HStack(spacing: 4) {
                Text(venueTime ? "Venue time · \(Fmt.zoneName(zone))" : "Your time · \(Fmt.zoneName(.current))")
                Image(systemName: "chevron.down").font(.caption.weight(.bold))
            }
            .font(.subheadline.weight(.semibold))
        }
        .accessibilityLabel(venueTime ? "Times shown in venue time. Change to your time" : "Times shown in your time. Change to venue time")
    }

    /// The live day, else today at the venue, else the first day.
    private func defaultDay(_ data: ScheduleResponse, zone: TimeZone) -> ScheduleResponse.Day? {
        if let live = data.days.first(where: \.live) { return live }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let c = calendar.dateComponents([.year, .month, .day], from: .now)
        let today = String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
        return data.days.first { $0.key == today } ?? data.days.first
    }

    // MARK: Rows

    @ViewBuilder
    private func rows(_ day: ScheduleResponse.Day, zone: TimeZone) -> some View {
        if model.isSplit {
            // Sidebar: every race as a compact row, the open round highlighted.
            VStack(spacing: 2) {
                ForEach(day.items) { item in
                    SidebarRow(item: item, time: time(item)).id(item.id)
                }
            }
        } else {
            cardRows(day)
        }
    }

    private func time(_ item: ScheduleItem) -> String {
        venueTime ? item.venueTime : Fmt.clock(item.startsAt, in: .current)
    }

    @ViewBuilder
    private func cardRows(_ day: ScheduleResponse.Day) -> some View {
        // On the day that's racing, fold away all but the last three finished races.
        let firstOpen = day.items.firstIndex { $0.state != .finished } ?? day.items.count
        let isToday = day.live || (firstOpen > 0 && firstOpen < day.items.count)
        let hidden = isToday && !showEarlier && firstOpen > 4 ? firstOpen - 3 : 0
        let shown = day.items.dropFirst(hidden)
        VStack(spacing: 0) {
            if hidden > 0 {
                Button {
                    withAnimation(.snappy) { showEarlier = true }
                } label: {
                    HStack {
                        Text("Show \(hidden) earlier rounds")
                        Spacer()
                        Chevron(direction: .down, color: Theme.link)
                    }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.link)
                    .padding(.horizontal, 16)
                    .frame(minHeight: 48)
                    .contentShape(.rect)
                }
                .buttonStyle(RowButtonStyle())
            }
            ForEach(Array(shown.enumerated()), id: \.element.id) { index, item in
                if index > 0 || hidden > 0 { RowDivider(leading: 76) }
                ScheduleRow(item: item, time: time(item)).id(item.id)
            }
        }
        .card()
        .clipShape(.rect(cornerRadius: 16))
    }
}

private struct DayTabs: View {
    let days: [ScheduleResponse.Day]
    let selected: String?
    let pick: (String) -> Void
    @Namespace private var pill

    var body: some View {
        HStack(spacing: 4) {
            ForEach(days) { day in
                let isSelected = day.key == selected
                Button { pick(day.key) } label: {
                    HStack(spacing: 6) {
                        if day.live { LiveDot() }
                        Text(day.label)
                    }
                    .font(.subheadline.weight(isSelected ? .semibold : .medium))
                    .foregroundStyle(isSelected ? Theme.ink : Theme.muted2)
                    .frame(maxWidth: .infinity, minHeight: 36)
                    .background {
                        if isSelected {
                            RoundedRectangle(cornerRadius: 9)
                                .fill(Theme.segmentSelected)
                                .shadow(color: .black.opacity(0.12), radius: 1.5, y: 1)
                                .matchedGeometryEffect(id: "pill", in: pill)
                        }
                    }
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(isSelected ? .isSelected : [])
            }
        }
        .padding(4)
        .background(Theme.segment, in: .rect(cornerRadius: 12))
        .sensoryFeedback(.selection, trigger: selected)
    }
}

private struct ScheduleRow: View {
    @Environment(AppModel.self) private var model
    @Environment(\.zoomNamespace) private var zoom
    let item: ScheduleItem
    let time: String

    var body: some View {
        Button {
            if let id = item.roundId { model.openRound(id, zoom: true) }
        } label: {
            content
                .background(item.state == .live ? Theme.liveTint : .clear)
                .contentShape(.rect)
        }
        .buttonStyle(RowButtonStyle())
        .disabled(item.roundId == nil)
        .modifier(ZoomSource(id: item.roundId, namespace: zoom))
    }

    private var content: some View {
        HStack(spacing: 12) {
            Text(time)
                .font(.subheadline.weight(item.state == .live ? .bold : .semibold))
                .monospacedDigit()
                .foregroundStyle(item.state == .finished ? Theme.muted : Theme.ink)
                .frame(width: 48, alignment: .leading)
            VStack(alignment: .leading, spacing: item.state == .live ? 3 : 2) {
                Text(item.title)
                    .font(.callout.weight(item.state == .live ? .bold : .semibold))
                    .foregroundStyle(item.state == .finished ? Theme.text2 : Theme.ink)
                Text(item.liveDetail.map { "\(item.round) · \($0)" } ?? item.round)
                    .font(.footnote.weight(item.isFinal && item.state == .upcoming ? .bold : .regular))
                    .foregroundStyle(item.state == .live ? Theme.text2 : item.isFinal && item.state == .upcoming ? Theme.ink : Theme.muted)
                    .contentTransition(.numericText())
            }
            Spacer(minLength: 8)
            switch item.state {
            case .live:
                LiveBadge()
            case .finished:
                Image(systemName: "checkmark")
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(Theme.muted)
                    .accessibilityLabel("Finished")
            case .upcoming:
                EmptyView()
            }
            if item.roundId != nil { Chevron() }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, item.state == .live ? 12 : 8)
        .frame(minHeight: item.state == .live ? 76 : 60)
        .accessibilityElement(children: .combine)
    }
}

/// Compact schedule row for the sidebar (Duo unfolded, iPad).
private struct SidebarRow: View {
    @Environment(AppModel.self) private var model
    let item: ScheduleItem
    let time: String

    var body: some View {
        let selected = item.roundId != nil && item.roundId == (model.visibleRound ?? model.detailRound)
        Button {
            if let id = item.roundId { model.openRound(id) }
        } label: {
            HStack(spacing: 10) {
                Text(time)
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(item.state == .finished && !selected ? Theme.muted : Theme.ink)
                    .frame(width: 46, alignment: .leading)
                VStack(alignment: .leading, spacing: 1) {
                    Text(item.title)
                        .font(.subheadline.weight(item.state == .live || selected ? .bold : .semibold))
                        .foregroundStyle(item.state == .finished && !selected ? Theme.text2 : Theme.ink)
                    Text(item.liveDetail.map { "\(item.round) · \($0)" } ?? item.round)
                        .font(.caption.weight(item.isFinal && item.state == .upcoming ? .bold : .regular))
                        .foregroundStyle(Theme.muted)
                        .contentTransition(.numericText())
                }
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
                if item.state == .live {
                    LiveDot()
                } else if item.state == .finished {
                    Image(systemName: "checkmark")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(Theme.muted)
                        .accessibilityLabel("Finished")
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background {
                if selected {
                    RoundedRectangle(cornerRadius: 10)
                        .fill(Theme.selectedRow)
                        .shadow(color: .black.opacity(0.06), radius: 2, y: 1)
                }
            }
            .contentShape(.rect)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(selected ? .isSelected : [])
        }
        .buttonStyle(.plain)
        .disabled(item.roundId == nil)
        .animation(.snappy, value: selected)
    }
}

private struct ZoomSource: ViewModifier {
    let id: Int?
    let namespace: Namespace.ID?

    func body(content: Content) -> some View {
        if let id, let namespace {
            content.matchedTransitionSource(id: id, in: namespace) { $0.clipShape(RoundedRectangle(cornerRadius: 0)) }
        } else {
            content
        }
    }
}
