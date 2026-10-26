import SwiftUI

// MARK: - Places card

/// The running qualification list: who's through on place, and who holds the
/// time spots so far.
struct PlacesCardView: View {
    let card: PlacesCard
    @ScaledMetric(relativeTo: .subheadline) private var timeWidth: CGFloat = 62

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 2) {
                Text(card.title)
                    .font(.headline)
                    .foregroundStyle(Theme.ink)
                if let rule = card.rule {
                    Text(rule)
                        .font(.footnote)
                        .foregroundStyle(Theme.muted)
                }
            }
            qualified
            if let time = card.time {
                timeSpots(time)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, card.time == nil ? 14 : 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }

    private var qualified: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(card.qualified.total.map { "Qualified · \(card.qualified.count)/\($0)" } ?? "Qualified · \(card.qualified.count)")
                .sectionLabel()
                .contentTransition(.numericText(value: Double(card.qualified.count)))
            if card.qualified.skaters.isEmpty {
                Text("No heats finished yet")
                    .font(.subheadline)
                    .foregroundStyle(Theme.faint)
            } else {
                FlowLayout(spacing: 14, lineSpacing: 8) {
                    ForEach(card.qualified.skaters, id: \.self) { skater in
                        HStack(spacing: 5) {
                            FlagView(iso2: skater.iso2, nat: skater.nat, size: 13)
                            Text(skater.last)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(Theme.ink)
                        }
                        .accessibilityElement(children: .combine)
                        .transition(.scale(scale: 0.8).combined(with: .opacity))
                    }
                }
            }
        }
    }

    private func timeSpots(_ time: PlacesCard.TimeSpots) -> some View {
        VStack(spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                Text("\(time.label) · \(time.filled)/\(time.total)").sectionLabel()
                Spacer(minLength: 8)
                Text(time.note)
                    .font(.caption)
                    .foregroundStyle(Theme.muted)
            }
            .padding(.bottom, 6)
            ForEach(time.rows, id: \.self) { row in
                RowDivider()
                timeRow(row)
            }
        }
    }

    private func timeRow(_ row: PlacesCard.TimeRow) -> some View {
        HStack(spacing: 10) {
            Text(row.pos)
                .font(.condensed(.title3))
                .foregroundStyle(row.kind == .out ? Theme.muted : Theme.ink)
                .frame(width: 18, alignment: .leading)
            if row.kind == .open {
                Text("Open")
                    .font(.subheadline)
                    .foregroundStyle(Theme.faint)
                Spacer()
            } else {
                FlagView(iso2: row.iso2, nat: row.nat).opacity(row.kind == .out ? 0.5 : 1)
                Text(row.last ?? "")
                    .font(.subheadline.weight(row.kind == .out ? .regular : .semibold))
                    .foregroundStyle(row.kind == .out ? Theme.muted : Theme.ink)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let heat = row.heat {
                    Text(heat)
                        .font(.caption)
                        .foregroundStyle(Theme.muted)
                        .fixedSize()
                }
                Text(row.time ?? "")
                    .font(.subheadline)
                    .monospacedDigit()
                    .foregroundStyle(row.kind == .out ? Theme.muted : Theme.ink)
                    .fixedSize()
                    .frame(minWidth: timeWidth, alignment: .trailing)
                if row.kind == .out {
                    Text("Out")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Theme.muted)
                        .frame(width: 34, alignment: .trailing)
                } else {
                    BadgeSlot(code: row.badge)
                }
            }
        }
        .frame(minHeight: 36)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Finished heats

struct FinishedHeats: View {
    @Environment(AppModel.self) private var model
    let heats: [HeatBlock]
    let isRelay: Bool
    @Binding var expanded: Set<Int>

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(heats.enumerated()), id: \.element.id) { index, heat in
                if index > 0 { RowDivider() }
                let open = expanded.contains(heat.id)
                Button {
                    withAnimation(.snappy) {
                        if open { expanded.remove(heat.id) } else { expanded.insert(heat.id) }
                    }
                } label: {
                    HeatSummaryRow(heat: heat, open: open)
                }
                .buttonStyle(RowButtonStyle())
                .accessibilityHint(open ? "Hides results" : "Shows results")
                if open {
                    VStack(spacing: 0) {
                        ForEach(heat.entries) { entry in
                            RowDivider()
                            ResultRow(entry: entry, medals: heat.name.hasPrefix("Final A") || heat.name == "Final")
                        }
                        RowDivider()
                        Button { model.openHeat(heat.id) } label: {
                            HStack {
                                Text("Lap times and race summary")
                                Spacer()
                                Chevron(color: Theme.link)
                            }
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Theme.link)
                            .padding(.horizontal, 16)
                            .frame(minHeight: 44)
                            .contentShape(.rect)
                        }
                        .buttonStyle(RowButtonStyle())
                    }
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
        }
        .card()
        .clipShape(.rect(cornerRadius: 16))
    }
}

/// "Heat 1 / Qualified: 🇮🇹 Nadalini 🇰🇷 Lee   [1 PEN] ⌄"
private struct HeatSummaryRow: View {
    let heat: HeatBlock
    let open: Bool

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(heat.name)
                        .font(.callout.weight(.bold))
                        .foregroundStyle(Theme.ink)
                    if heat.state == .unofficial {
                        Text("Unofficial")
                            .font(.caption)
                            .foregroundStyle(Theme.muted)
                    }
                }
                if !open { outcome }
            }
            Spacer(minLength: 8)
            if let sanctions = heat.sanctions { OutlineChip(text: sanctions) }
            Chevron(direction: open ? .up : .down)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(minHeight: 64)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }

    /// Both names when two qualify; past that, one name and a count. A final
    /// has no qualifiers, so it shows the winner.
    @ViewBuilder private var outcome: some View {
        let names: [(String, String?)] = heat.qualified.isEmpty
            ? heat.entries.filter { $0.rank == 1 }.map { ($0.last, $0.iso2) }
            : heat.qualified.map { ($0.last, $0.iso2) }
        let shown = names.count > 2 ? Array(names.prefix(1)) : names
        if !names.isEmpty {
            HStack(spacing: 6) {
                Text(heat.qualified.isEmpty ? "Winner:" : "Qualified:").fixedSize()
                HStack(spacing: 10) {
                    ForEach(shown, id: \.0) { last, iso2 in
                        HStack(spacing: 5) {
                            FlagView(iso2: iso2, size: 13)
                            Text(last)
                                .fontWeight(.semibold)
                                .foregroundStyle(Theme.ink)
                                .lineLimit(1)
                        }
                    }
                }
                if names.count > shown.count {
                    Text("+\(names.count - shown.count) more").fixedSize()
                }
            }
            .font(.footnote)
            .foregroundStyle(Theme.muted)
        }
    }
}

/// Place, flag, name, time (with a card), badge.
struct ResultRow: View {
    let entry: Entry
    var medals = false
    @ScaledMetric(relativeTo: .subheadline) private var timeWidth: CGFloat = 66

    var body: some View {
        HStack(spacing: 10) {
            RankText(rank: entry.rank, medals: medals)
            FlagView(iso2: entry.iso2, nat: entry.nat)
            Text(entry.name)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.ink)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 5) {
                CardIcon(status: entry.status)
                Text(entry.time ?? entry.status ?? "")
                    .font(.subheadline)
                    .monospacedDigit()
                    .foregroundStyle(entry.rank == nil ? Theme.muted : Theme.ink)
                    .fixedSize()
            }
            .frame(minWidth: timeWidth, alignment: .trailing)
            BadgeSlot(code: entry.badge)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
        .frame(minHeight: 40)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Live heat

struct LiveHeatCard: View {
    @Environment(AppModel.self) private var model
    let heat: HeatBlock
    let updatedAt: Date?

    var body: some View {
        VStack(spacing: 0) {
            Button { model.openHeat(heat.id) } label: {
                HStack(spacing: 10) {
                    Text(heat.name)
                        .font(.callout.weight(.bold))
                        .foregroundStyle(Theme.ink)
                    LiveBadge()
                    Spacer()
                    if let updatedAt { UpdatedAgo(since: updatedAt) }
                    Chevron()
                }
                .padding(.horizontal, 16)
                .frame(minHeight: 44)
                .contentShape(.rect)
            }
            .buttonStyle(RowButtonStyle())

            if let lap = heat.lap {
                lapProgress(lap)
            }
            ForEach(heat.entries) { entry in
                RowDivider()
                HStack(spacing: 10) {
                    RankText(rank: entry.rank)
                    FlagView(iso2: entry.iso2, nat: entry.nat)
                    Text(entry.name)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.ink)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(entry.lastLap ?? "")
                        .font(.subheadline)
                        .monospacedDigit()
                        .foregroundStyle(Theme.ink)
                        .contentTransition(.numericText())
                }
                .padding(.horizontal, 16)
                .frame(minHeight: 36)
                .accessibilityElement(children: .combine)
            }
        }
        .card()
        .clipShape(.rect(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Theme.live.opacity(0.35), lineWidth: 1))
    }

    private func lapProgress(_ lap: HeatBlock.Lap) -> some View {
        VStack(spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                HStack(spacing: 5) {
                    Text("LAP \(lap.current)")
                        .foregroundStyle(Theme.ink)
                        .contentTransition(.numericText(value: Double(lap.current)))
                    if let total = lap.total {
                        Text("OF \(total)").foregroundStyle(Theme.muted)
                    }
                }
                .font(.condensed(.title2))
                Spacer()
                Text("Last lap")
                    .font(.footnote)
                    .foregroundStyle(Theme.muted)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Theme.divider)
                    Capsule().fill(Theme.live)
                        .frame(width: geo.size.width * min(1, Double(lap.current) / Double(max(1, lap.total ?? lap.current))))
                }
            }
            .frame(height: 4)
            .accessibilityHidden(true)
        }
        .padding(.horizontal, 16)
        .padding(.top, 4)
        .padding(.bottom, 8)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Lap \(lap.current)\(lap.total.map { " of \($0)" } ?? "")")
    }
}

/// "Updated 4s ago", ticking.
private struct UpdatedAgo: View {
    let since: Date

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            Text("Updated \(max(0, Int(context.date.timeIntervalSince(since))))s ago")
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(Theme.muted)
        }
    }
}

// MARK: - Start lists

struct StartListCard: View {
    @Environment(AppModel.self) private var model
    let heat: HeatBlock
    let upNext: Bool
    let zone: TimeZone
    @State private var width: CGFloat = 0

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(heat.name)
                    .font(.callout.weight(.bold))
                    .foregroundStyle(Theme.ink)
                Spacer()
                Text(label)
                    .font(.footnote)
                    .foregroundStyle(Theme.muted)
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 44)

            if !heat.entries.isEmpty {
                RowDivider()
                let entries = heat.entries.sorted { ($0.startPosition ?? 99) < ($1.startPosition ?? 99) }
                // Phones list full names; the narrow columns of the wide layout
                // fit two across with surnames, and a wide card fits both.
                let columns = (model.isSplit || width >= 560) && entries.count > 3 ? 2 : 1
                let surnames = columns == 2 && width < 560
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12, alignment: .leading), count: columns), spacing: 0) {
                    ForEach(entries) { entry in
                        HStack(spacing: 10) {
                            Text(entry.startPosition.map(String.init) ?? "–")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(Theme.text2)
                                .frame(width: 20, height: 20)
                                .background(Theme.divider, in: .circle)
                                .accessibilityLabel("Start \(entry.startPosition ?? 0)")
                            FlagView(iso2: entry.iso2, nat: entry.nat)
                            Text(surnames ? entry.last : entry.name)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(Theme.ink)
                                .lineLimit(1)
                        }
                        .frame(minHeight: 32)
                        .accessibilityElement(children: .combine)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 4)
                .padding(.bottom, 8)
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
            }
        }
        .card()
    }

    private var label: String {
        let list = heat.state == .startList ? "Start list" : heat.startsAt.map { Fmt.clock($0, in: zone) } ?? "Scheduled"
        return upNext ? "Up next · \(list)" : list
    }
}
