import SwiftUI

// MARK: - Badges

/// Red LIVE pill with a pulsing dot.
struct LiveBadge: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(.white)
                .frame(width: 6, height: 6)
                .phaseAnimator(reduceMotion ? [1.0] : [1.0, 0.3]) { dot, opacity in
                    dot.opacity(opacity)
                } animation: { _ in .easeInOut(duration: 0.8) }
            Text("LIVE")
                .font(.caption.weight(.bold))
                .tracking(0.7)
        }
        .foregroundStyle(.white)
        .padding(.vertical, 4)
        .padding(.horizontal, 8)
        .background(Theme.live, in: .rect(cornerRadius: 6))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Live")
    }
}

/// Small red dot for compact live markers (day tabs, sidebar rows).
struct LiveDot: View {
    var body: some View {
        Circle().fill(Theme.live).frame(width: 6, height: 6).accessibilityLabel("Live")
    }
}

enum Codes {
    /// Confirmed qualification: drawn solid. Anything else (p = waiting on
    /// time) is outlined.
    static let qualified: Set<String> = ["Q", "QA", "QB", "q", "qA", "qB", "ADV", "ADVA", "ADVB"]

    static func spoken(_ code: String) -> String {
        switch code {
        case "Q", "QA", "QB": "Qualified"
        case "q", "qA", "qB": "Qualified on time"
        case "ADV", "ADVA", "ADVB": "Advanced by the referee"
        case "p": "Waiting on time"
        default: code
        }
    }
}

/// Q / q / ADV / p chip.
struct QualBadge: View {
    let code: String

    var body: some View {
        let solid = Codes.qualified.contains(code)
        Text(code)
            .font(.caption2.weight(.bold))
            .foregroundStyle(solid ? Theme.onInkFill : Theme.muted2)
            .padding(.horizontal, 5)
            .frame(minWidth: 22, minHeight: 20)
            .background {
                RoundedRectangle(cornerRadius: 5)
                    .fill(solid ? Theme.inkFill : .clear)
                    .strokeBorder(solid ? .clear : Theme.faint, lineWidth: 1)
            }
            .fixedSize()
            .accessibilityLabel(Codes.spoken(code))
    }
}

/// Fixed-width column for a badge, so times line up whether or not a row has one.
struct BadgeSlot: View {
    let code: String?
    var width: CGFloat = 34

    var body: some View {
        Color.clear
            .frame(width: width, height: 20)
            .overlay(alignment: .trailing) {
                if let code { QualBadge(code: code) }
            }
    }
}

/// Yellow or red card next to a time.
struct CardIcon: View {
    let status: String?

    var body: some View {
        switch status {
        case "YC":
            RoundedRectangle(cornerRadius: 2).fill(Theme.yellowCard)
                .frame(width: 8, height: 11)
                .accessibilityLabel("Yellow card")
        case "RC":
            RoundedRectangle(cornerRadius: 2).fill(Theme.redCard)
                .frame(width: 8, height: 11)
                .accessibilityLabel("Red card")
        default:
            EmptyView()
        }
    }
}

/// Outlined status chip ("1 PEN", "YC").
struct OutlineChip: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.caption2.weight(.bold))
            .tracking(0.4)
            .foregroundStyle(Theme.text2)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(Theme.faint, lineWidth: 1))
            .fixedSize()
    }
}

// MARK: - Flags and ranks

/// 4:3 flag (flag-icons artwork, MIT, rendered to PNG because iOS skips the
/// shapes some SVGs reuse, like the Korean trigrams) from an ISO 3166 code, `size` points
/// tall. Falls back to the emoji flag for a nation we don't bundle, and to
/// the IOC code in a chip when there's no country (e.g. AIN, neutral athletes).
struct FlagView: View {
    let iso2: String?
    var nat: String? = nil
    var size: CGFloat = 15

    var body: some View {
        Group {
            if let iso2, let image = UIImage(named: "Flags/\(iso2.lowercased())") {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: (size * 4 / 3).rounded(), height: size)
                    .clipShape(.rect(cornerRadius: 2))
                    .overlay(RoundedRectangle(cornerRadius: 2).strokeBorder(Theme.ink.opacity(0.12), lineWidth: 0.5))
            } else if let iso2, iso2.count == 2 {
                Text(Flags.emoji(iso2))
                    .font(.system(size: size))
            } else {
                Text(nat ?? "–")
                    .font(.system(size: size * 0.5, weight: .bold))
                    .foregroundStyle(Theme.muted)
                    .frame(width: size * 1.33, height: size)
                    .background(Theme.divider, in: .rect(cornerRadius: 2))
            }
        }
        .accessibilityLabel(Flags.countryName(iso2) ?? nat ?? "")
    }
}

enum Flags {
    /// "IT" → 🇮🇹 (two regional indicator symbols).
    static func emoji(_ iso2: String) -> String {
        var flag = ""
        for letter in iso2.uppercased().unicodeScalars {
            if let indicator = Unicode.Scalar(0x1F1A5 + letter.value) { flag.unicodeScalars.append(indicator) }
        }
        return flag
    }

    static func countryName(_ iso2: String?) -> String? {
        iso2.flatMap { Locale.current.localizedString(forRegionCode: $0) }
    }
}

/// Big condensed place number; gold, silver and bronze in an A final.
struct RankText: View {
    let rank: Int?
    var medals = false
    @ScaledMetric(relativeTo: .title3) private var width: CGFloat = 22

    var body: some View {
        Group {
            if medals, let rank, rank <= 3 {
                Text("\(rank)")
                    .font(.condensed(.subheadline))
                    .foregroundStyle(.white)
                    .frame(width: 22, height: 22)
                    .background([Theme.gold, Theme.silver, Theme.bronze][rank - 1], in: .circle)
            } else {
                Text(rank.map(String.init) ?? "–")
                    .font(.condensed(.title3))
                    .foregroundStyle(Theme.ink)
                    .contentTransition(.numericText(value: Double(rank ?? 0)))
            }
        }
        .frame(width: width, alignment: .leading)
    }
}

struct Chevron: View {
    var direction: Direction = .forward
    var color: Color = Theme.faint

    enum Direction { case forward, down, up }

    var body: some View {
        Image(systemName: direction == .forward ? "chevron.right" : direction == .down ? "chevron.down" : "chevron.up")
            .font(.footnote.weight(.semibold))
            .foregroundStyle(color)
            .accessibilityHidden(true)
    }
}

// MARK: - Layout

/// Wraps its children onto new lines (qualified skaters in the places card).
struct FlowLayout: Layout {
    var spacing: CGFloat = 14
    var lineSpacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        let width = rows.map { $0.width }.max() ?? 0
        let height = rows.reduce(0) { $0 + $1.height } + lineSpacing * CGFloat(max(0, rows.count - 1))
        return CGSize(width: proposal.width ?? width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y + (row.height - size.height) / 2), proposal: .unspecified)
                x += size.width + spacing
            }
            y += row.height + lineSpacing
        }
    }

    private struct Row { var indices: [Int] = []; var width: CGFloat = 0; var height: CGFloat = 0 }

    private func arrange(width: CGFloat, subviews: Subviews) -> [Row] {
        var rows: [Row] = [Row()]
        for (index, subview) in subviews.enumerated() {
            let size = subview.sizeThatFits(.unspecified)
            let needed = rows[rows.count - 1].indices.isEmpty ? size.width : rows[rows.count - 1].width + spacing + size.width
            if needed > width, !rows[rows.count - 1].indices.isEmpty {
                rows.append(Row())
            }
            var row = rows[rows.count - 1]
            row.width = row.indices.isEmpty ? size.width : row.width + spacing + size.width
            row.height = max(row.height, size.height)
            row.indices.append(index)
            rows[rows.count - 1] = row
        }
        return rows
    }
}

/// Hairline between rows.
struct RowDivider: View {
    var leading: CGFloat = 0

    var body: some View {
        Rectangle().fill(Theme.divider).frame(height: 1).padding(.leading, leading)
    }
}

// MARK: - Loading and errors

/// Shows a `Live` value, a spinner while the first load runs, or an error
/// with a retry button. Once there's a value, a failed refresh only shows a
/// small banner and keeps the last data on screen.
struct LiveContent<Value: Decodable & Sendable, Content: View>: View {
    let live: Live<Value>
    @ViewBuilder let content: (Value) -> Content

    var body: some View {
        if let value = live.value {
            content(value)
                .overlay(alignment: .bottom) {
                    if live.error != nil {
                        Label("Can't reach the server. Retrying…", systemImage: "wifi.exclamationmark")
                            .font(.footnote.weight(.semibold))
                            .padding(.horizontal, 14)
                            .padding(.vertical, 10)
                            .background(.regularMaterial, in: .capsule)
                            .padding(.bottom, 12)
                            .transition(.move(edge: .bottom).combined(with: .opacity))
                    }
                }
                .animation(.snappy, value: live.error != nil)
        } else if let error = live.error {
            ContentUnavailableView {
                Label("Can't load this", systemImage: "wifi.exclamationmark")
            } description: {
                Text("\(error.localizedDescription)\n\(AppConfig.baseURL.absoluteString)")
            } actions: {
                Button("Try again") { Task { await live.refresh() } }
                    .buttonStyle(.borderedProminent)
            }
        } else {
            ProgressView()
                .controlSize(.large)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}
