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
            .tabBarHidesOnScroll()
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// When the lap-by-lap drawing started; nil when it isn't playing.
    @State private var startedAt: Date?
    /// Played through once (or never animated), so later live laps just appear.
    @State private var played = false

    private static let secondsPerLap = 0.26

    private struct Point: Identifiable {
        let skater: String
        let lap: Double
        let position: Double
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

    /// How far the drawing has got, in laps: 1 (the first crossing) up to the last lap.
    private func progress(at date: Date) -> Double {
        let end = Double(max(1, chart.laps))
        guard let startedAt else { return played || reduceMotion ? end : 1 }
        return min(end, 1 + date.timeIntervalSince(startedAt) / Self.secondsPerLap)
    }

    /// A skater's line up to `lap`, ending partway to the next crossing.
    private func points(_ s: HeatResponse.Chart.Series, upTo lap: Double) -> [Point] {
        let known = s.positions.enumerated().compactMap { i, pos in pos.map { (lap: Double(i + 1), pos: Double($0)) } }
        var points: [Point] = []
        for (k, cur) in known.enumerated() {
            if cur.lap <= lap {
                points.append(Point(skater: s.last, lap: cur.lap, position: cur.pos))
                continue
            }
            if k > 0, known[k - 1].lap < lap {
                let prev = known[k - 1]
                let f = (lap - prev.lap) / (cur.lap - prev.lap)
                points.append(Point(skater: s.last, lap: lap, position: prev.pos + (cur.pos - prev.pos) * f))
            }
            break
        }
        return points
    }

    private func play() {
        played = false
        let start = Date.now
        startedAt = start
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(Double(max(0, chart.laps - 1)) * Self.secondsPerLap))
            if startedAt == start {
                startedAt = nil
                played = true
            }
        }
    }

    var body: some View {
        TimelineView(.animation(paused: startedAt == nil)) { context in
            let lap = progress(at: context.date)
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 4) {
                    Text("Position by lap")
                        .font(.headline)
                        .foregroundStyle(Theme.ink)
                    Spacer(minLength: 8)
                    Text("Lap \(min(chart.laps, Int(lap))) of \(chart.laps)")
                        .font(.caption)
                        .monospacedDigit()
                        .foregroundStyle(Theme.muted)
                    Button { play() } label: {
                        Image(systemName: "arrow.counterclockwise")
                            .font(.body.weight(.semibold))
                            .foregroundStyle(Theme.link)
                            .frame(width: 44, height: 44)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Replay position by lap")
                }
                .padding(.leading, 8)
                chartView(upTo: lap)
                ForEach(notes, id: \.self) { note in
                    Text(note)
                        .font(.caption)
                        .lineSpacing(2)
                        .foregroundStyle(Theme.muted)
                        .padding(.horizontal, 8)
                }
            }
        }
        .padding(.vertical, 16)
        .padding(.horizontal, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
        // Draws itself the first time it's mostly on screen.
        .onScrollVisibilityChange(threshold: 0.6) { visible in
            if visible, !played, startedAt == nil, !reduceMotion { play() }
        }
    }

    private func chartView(upTo lap: Double) -> some View {
        Chart {
            // Every place from the start, so the axis stays put while the lines grow.
            PointMark(x: .value("Lap", 1.0), y: .value("Position", 1.0)).opacity(0)
            PointMark(x: .value("Lap", 1.0), y: .value("Position", Double(maxPosition))).opacity(0)
            ForEach(ordered) { series in
                let points = points(series, upTo: lap)
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
                            HStack(spacing: 4) {
                                FlagView(iso2: series.iso2, size: 11)
                                Text(series.last)
                                    .font(.caption.weight(rank(series) > 0 ? .semibold : .regular))
                                    .foregroundStyle(rank(series) > 0 ? Theme.ink : Theme.muted)
                            }
                            .fixedSize()
                        }
                }
            }
        }
        .chartYScale(domain: .automatic(includesZero: false, reversed: true))
        .chartXScale(domain: 1...Double(max(2, chart.laps)), range: .plotDimension(startPadding: 6, endPadding: 10))
        .chartYAxis {
            AxisMarks(position: .leading, values: (1...max(1, maxPosition)).map(Double.init)) { value in
                AxisGridLine().foregroundStyle(Theme.divider)
                AxisValueLabel {
                    if let place = value.as(Double.self) { Text("\(Int(place))") }
                }
                .foregroundStyle(Theme.muted)
            }
        }
        // Lap numbers drawn by hand: Charts' own axis drops the last lap's
        // label, and the last lap is the one that matters.
        .chartXAxis(.hidden)
        .chartOverlay { proxy in
            GeometryReader { geo in
                if let anchor = proxy.plotFrame {
                    let plot = geo[anchor]
                    ForEach(xTicks, id: \.self) { tick in
                        if let x = proxy.position(forX: Double(tick)) {
                            Text("\(tick)")
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
        .padding(.trailing, 104) // room for the flags and names at the end of each line
        .accessibilityLabel(accessibilitySummary)
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
