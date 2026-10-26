import Charts
import SwiftUI

/// One heat: results, a summary built from the lap data, position by lap,
/// and every lap time.
struct HeatView: View {
    @State private var live: Live<HeatResponse>

    init(id: Int) {
        _live = State(initialValue: Live("heats/\(id)") { heat in
            switch heat.heat.state {
            case .running, .unofficial: .seconds(5)
            case .official: nil
            case .scheduled, .startList: .seconds(30)
            }
        })
    }

    var body: some View {
        LiveContent(live: live) { data in
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    header(data)
                    results(data)
                    if !data.summary.isEmpty { summary(data.summary) }
                    if let chart = data.chart { PositionChart(chart: chart, notes: data.notes) }
                    if let table = data.lapTable { LapTableView(table: table) }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
                .frame(maxWidth: 700)
                .frame(maxWidth: .infinity)
            }
            .scrollIndicators(.hidden)
            .refreshable { await live.refresh() }
        }
        .screen(title: live.value?.heat.name ?? "Heat")
        .task { await live.run() }
    }

    private func header(_ data: HeatResponse) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 10) {
                Text(data.heat.name)
                    .font(.title.weight(.bold))
                    .foregroundStyle(Theme.ink)
                if data.heat.state == .running { LiveBadge() }
            }
            Text([data.heat.competition, data.heat.round, stateText(data.heat.state)].compactMap { $0 }.joined(separator: " · "))
                .font(.subheadline)
                .foregroundStyle(Theme.muted)
        }
    }

    private func stateText(_ state: HeatState) -> String? {
        switch state {
        case .official: "Official"
        case .unofficial: "Unofficial"
        case .running: nil
        case .startList: "Start list"
        case .scheduled: "Scheduled"
        }
    }

    private func results(_ data: HeatResponse) -> some View {
        let medals = data.heat.name.hasPrefix("Final A") || data.heat.name == "Final"
        let running = data.heat.state == .running
        return VStack(spacing: 0) {
            HStack(spacing: 10) {
                Text("Pos").frame(width: 28, alignment: .leading)
                Text(data.heat.isRelay ? "Team" : "Skater").frame(maxWidth: .infinity, alignment: .leading)
                Text(running ? "Last lap" : "Time").frame(width: 72, alignment: .trailing)
                Color.clear.frame(width: 22, height: 1)
            }
            .sectionLabel()
            .padding(.horizontal, 16)
            .frame(minHeight: 36)
            ForEach(data.results) { entry in
                RowDivider()
                HeatResultRow(entry: entry, medals: medals, running: running)
            }
        }
        .card()
    }

    private func summary(_ facts: [String]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text("Race summary").font(.headline).foregroundStyle(Theme.ink)
                Spacer()
                Text("From lap data").font(.caption).foregroundStyle(Theme.muted)
            }
            VStack(alignment: .leading, spacing: 10) {
                ForEach(facts, id: \.self) { fact in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("•").foregroundStyle(Theme.muted)
                        Text(fact)
                    }
                    .font(.subheadline)
                    .lineSpacing(3)
                    .foregroundStyle(Theme.text3)
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }
}

private struct HeatResultRow: View {
    let entry: Entry
    let medals: Bool
    let running: Bool

    var body: some View {
        HStack(spacing: 10) {
            RankText(rank: entry.rank, medals: medals && !running)
                .frame(width: 28, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.name)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.ink)
                    .lineLimit(1)
                HStack(spacing: 6) {
                    FlagView(iso2: entry.iso2, nat: entry.nat, size: 12)
                    Text([entry.nat, entry.startPosition.map { "Start \($0)" }].compactMap { $0 }.joined(separator: " · "))
                }
                .font(.caption)
                .foregroundStyle(Theme.muted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            VStack(alignment: .trailing, spacing: 2) {
                HStack(spacing: 5) {
                    CardIcon(status: entry.status)
                    Text(running ? entry.lastLap ?? "" : entry.time ?? entry.status ?? "")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(entry.rank == nil && !running ? Theme.muted : Theme.ink)
                        .contentTransition(.numericText())
                }
                if let gap = entry.gap {
                    Text(gap).font(.caption).foregroundStyle(Theme.muted)
                }
            }
            .monospacedDigit()
            .frame(minWidth: 72, alignment: .trailing)
            BadgeSlot(code: entry.badge, width: 28)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
        .frame(minHeight: 52)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Position by lap

private struct PositionChart: View {
    let chart: HeatResponse.Chart
    let notes: [String]

    private struct Point: Identifiable {
        let skater: String
        let lap: Int
        let position: Int
        var id: String { "\(skater)-\(lap)" }
    }

    /// Grey lines first so the winner and the biggest climber draw on top.
    private var ordered: [HeatResponse.Chart.Series] {
        chart.series.sorted { rank($0) < rank($1) }
    }

    private func rank(_ s: HeatResponse.Chart.Series) -> Int {
        s.last == chart.winner ? 2 : s.last == chart.climber ? 1 : 0
    }

    private func color(_ s: HeatResponse.Chart.Series) -> Color {
        s.last == chart.winner ? Theme.chartWinner : s.last == chart.climber ? Theme.chartClimber : Theme.chartOther
    }

    private var maxPosition: Int {
        chart.series.flatMap { $0.positions.compactMap { $0 } }.max() ?? chart.series.count
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Position by lap")
                .font(.headline)
                .foregroundStyle(Theme.ink)
                .padding(.horizontal, 8)
            Chart {
                ForEach(ordered) { series in
                    let points = series.positions.enumerated().compactMap { index, pos in
                        pos.map { Point(skater: series.last, lap: index + 1, position: $0) }
                    }
                    ForEach(points) { point in
                        LineMark(x: .value("Lap", point.lap), y: .value("Position", point.position), series: .value("Skater", point.skater))
                            .foregroundStyle(color(series))
                            .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                    }
                    if let end = points.last {
                        PointMark(x: .value("Lap", end.lap), y: .value("Position", end.position))
                            .foregroundStyle(color(series))
                            .symbolSize(40)
                            .annotation(position: .trailing, alignment: .leading, spacing: 6,
                                        overflowResolution: .init(x: .disabled, y: .disabled)) {
                                Text(series.last)
                                    .font(.caption.weight(rank(series) > 0 ? .semibold : .regular))
                                    .foregroundStyle(rank(series) > 0 ? Theme.ink : Theme.muted)
                                    .fixedSize()
                            }
                    }
                }
            }
            .chartYScale(domain: .automatic(includesZero: false, reversed: true))
            .chartXScale(domain: 1...max(2, chart.laps), range: .plotDimension(startPadding: 6, endPadding: 10))
            .chartYAxis {
                AxisMarks(position: .leading, values: Array(1...max(1, maxPosition))) { _ in
                    AxisGridLine().foregroundStyle(Theme.divider)
                    AxisValueLabel().foregroundStyle(Theme.muted)
                }
            }
            // Lap numbers drawn by hand: Charts' own axis drops the last lap's
            // label, and the last lap is the one that matters.
            .chartXAxis(.hidden)
            .chartOverlay { proxy in
                GeometryReader { geo in
                    if let anchor = proxy.plotFrame {
                        let plot = geo[anchor]
                        ForEach(xTicks, id: \.self) { lap in
                            if let x = proxy.position(forX: lap) {
                                Text("\(lap)")
                                    .font(.caption2)
                                    .monospacedDigit()
                                    .foregroundStyle(Theme.muted)
                                    .position(x: plot.minX + x, y: plot.maxY + 14)
                            }
                        }
                    }
                }
            }
            .padding(.bottom, 20)
            .chartLegend(.hidden)
            .frame(height: CGFloat(max(5, maxPosition)) * 24 + 40)
            .padding(.leading, 8)
            .padding(.trailing, 84) // room for the names at the end of each line
            .accessibilityLabel(accessibilitySummary)
            ForEach(notes, id: \.self) { note in
                Text(note)
                    .font(.caption)
                    .lineSpacing(2)
                    .foregroundStyle(Theme.muted)
                    .padding(.horizontal, 8)
            }
        }
        .padding(.vertical, 16)
        .padding(.horizontal, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }

    private var xTicks: [Int] {
        let laps = chart.laps
        if laps <= 6 { return Array(1...max(1, laps)) }
        var ticks = [1] + stride(from: 5, to: laps, by: laps > 20 ? 10 : 5).map { $0 }
        if laps - (ticks.last ?? 0) < 2 { ticks.removeLast() }
        return ticks + [laps]
    }

    private var accessibilitySummary: String {
        chart.series.map { s in
            let positions = s.positions.compactMap { $0 }
            return "\(s.last): from \(positions.first ?? 0) to \(positions.last ?? 0)"
        }.joined(separator: ". ")
    }
}

// MARK: - Lap times

private struct LapTableView: View {
    let table: HeatResponse.LapTable

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("Lap times").font(.headline).foregroundStyle(Theme.ink)
                Spacer()
                Text("Seconds").font(.caption).foregroundStyle(Theme.muted)
            }
            ViewThatFits(in: .horizontal) {
                grid(columnWidth: nil)
                ScrollView(.horizontal) { grid(columnWidth: 56) }.scrollIndicators(.hidden)
            }
            if let legend { Text(legend).font(.caption).foregroundStyle(Theme.muted) }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }

    private func grid(columnWidth: CGFloat?) -> some View {
        Grid(horizontalSpacing: 4, verticalSpacing: 0) {
            GridRow(alignment: .bottom) {
                Text("Lap")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Theme.muted)
                    .frame(width: 26, alignment: .leading)
                ForEach(table.columns, id: \.self) { column in
                    VStack(spacing: 4) {
                        FlagView(iso2: column.iso2, size: 12)
                        Text(column.last)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(Theme.text2)
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                    }
                    .frame(minWidth: columnWidth ?? 44, maxWidth: columnWidth ?? .infinity)
                }
            }
            .padding(.bottom, 8)
            ForEach(table.rows) { row in
                GridRow {
                    Text("\(row.lap)")
                        .font(.caption)
                        .foregroundStyle(Theme.muted)
                        .frame(width: 26, alignment: .leading)
                    ForEach(Array(row.cells.enumerated()), id: \.offset) { _, cell in
                        cellView(cell)
                            .frame(minWidth: columnWidth ?? 44, maxWidth: columnWidth ?? .infinity, alignment: .trailing)
                    }
                }
                .frame(minHeight: 26)
                .overlay(alignment: .top) { RowDivider() }
            }
        }
        .monospacedDigit()
    }

    @ViewBuilder
    private func cellView(_ cell: HeatResponse.LapTable.Cell) -> some View {
        let text = Text(cell.time ?? "–").font(.caption)
        if cell.fastest {
            text.fontWeight(.bold)
                .foregroundStyle(Theme.onInkFill)
                .padding(.horizontal, 4)
                .padding(.vertical, 2)
                .background(Theme.inkFill, in: .rect(cornerRadius: 4))
                .accessibilityLabel("\(cell.time ?? ""), fastest lap of the race")
        } else if cell.best {
            text.fontWeight(.bold).foregroundStyle(Theme.ink)
        } else {
            text.foregroundStyle(Theme.text2)
        }
    }

    private var legend: String? {
        for row in table.rows {
            if let index = row.cells.firstIndex(where: \.fastest), table.columns.indices.contains(index) {
                return "Bold: each skater's fastest lap. Highlighted: fastest lap of the race (\(table.columns[index].last), lap \(row.lap))."
            }
        }
        return nil
    }
}
