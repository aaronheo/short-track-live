import ActivityKit
import SwiftUI
import WidgetKit

@main
struct ShortTrackWidgets: WidgetBundle {
    var body: some Widget {
        RaceActivityWidget()
    }
}

/// The Lock Screen card and Dynamic Island for a favorite's race. Always dark,
/// like the app's live event card.
struct RaceActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RaceActivityAttributes.self) { context in
            LockScreenView(attributes: context.attributes, state: context.state)
                .activityBackgroundTint(Palette.hero)
                .activitySystemActionForegroundColor(.white)
                .widgetURL(URL(string: "shorttrack://heat/\(context.attributes.heatId)"))
        } dynamicIsland: { context in
            let state = context.state
            return DynamicIsland {
                // One full-width region: the corners beside the camera are too narrow for the race's name.
                DynamicIslandExpandedRegion(.bottom) {
                  VStack(spacing: 10) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(context.attributes.race).font(.subheadline.weight(.bold)).lineLimit(1)
                        Spacer(minLength: 8)
                        LapText(state: state).font(.subheadline.weight(.bold))
                    }
                    if state.rows.isEmpty {
                        Text("\(state.headline) · \(state.detail)").font(.subheadline).foregroundStyle(Palette.muted)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        HStack(spacing: 8) {
                            ForEach(state.rows.prefix(3), id: \.self) { row in
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(ordinal(row.pos)).font(.caption2).foregroundStyle(Palette.muted)
                                    Text(row.name).font(.subheadline.weight(.bold)).lineLimit(1)
                                    HStack(spacing: 5) {
                                        Flag(iso2: row.iso2, height: 12)
                                        Text(row.gap ?? "").font(.caption).foregroundStyle(Palette.muted).monospacedDigit()
                                    }
                                }
                                .padding(.horizontal, 10).padding(.vertical, 8)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(row.mine ? Palette.mineCell : Color(white: 0.11), in: .rect(cornerRadius: 14))
                            }
                        }
                    }
                  }
                  .padding(.horizontal, 6)
                }
            } compactLeading: {
                HStack(spacing: 5) {
                    Flag(iso2: context.attributes.iso2, height: 12)
                    Text(compactPlace(state)).font(.caption.weight(.semibold))
                }
            } compactTrailing: {
                LapText(state: state, short: true).font(.caption.weight(.semibold))
            } minimal: {
                Text(minimalPlace(state)).font(.caption.weight(.bold))
            }
            .widgetURL(URL(string: "shorttrack://heat/\(context.attributes.heatId)"))
            .keylineTint(Palette.live)
        }
    }

    private func myRow(_ state: RaceActivityAttributes.ContentState) -> RaceActivityAttributes.ContentState.Row? {
        state.rows.first(where: \.mine)
    }

    private func compactPlace(_ state: RaceActivityAttributes.ContentState) -> String {
        if state.phase == "upNext" { return "Next" }
        return myRow(state).map { ordinal($0.pos) } ?? "–"
    }

    private func minimalPlace(_ state: RaceActivityAttributes.ContentState) -> String {
        if state.phase == "upNext" { return "▸" }
        return myRow(state).map { String($0.pos) } ?? "–"
    }
}

private struct LockScreenView: View {
    let attributes: RaceActivityAttributes
    let state: RaceActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(state.phase == "upNext" ? attributes.event : attributes.race)
                    .font(.caption2.weight(.semibold)).textCase(.uppercase).kerning(0.6)
                    .foregroundStyle(Palette.muted).lineLimit(1)
                Spacer()
                Badge(phase: state.phase)
            }
            switch state.phase {
            case "upNext":
                HStack(spacing: 10) {
                    Flag(iso2: attributes.iso2, height: 18)
                    Text(state.headline).font(.headline)
                }
                Text("\(attributes.race) · \(state.detail)").font(.subheadline).foregroundStyle(Palette.muted)
            case "racing":
                HStack(alignment: .firstTextBaseline) {
                    Text(state.headline).font(.headline)
                    Spacer()
                    LapText(state: state).font(.title3.weight(.bold).width(.condensed))
                }
                ProgressView(value: state.progress).tint(Palette.live)
                rows(gaps: true)
            default:
                Text(state.headline).font(.headline).fixedSize(horizontal: false, vertical: true)
                Text(state.detail).font(.subheadline).foregroundStyle(Palette.muted).lineLimit(2)
            }
        }
        .foregroundStyle(.white)
        .padding(16)
    }

    private func rows(gaps: Bool) -> some View {
        VStack(spacing: 2) {
            ForEach(state.rows, id: \.self) { row in
                HStack(spacing: 10) {
                    Text("\(row.pos)").font(.callout.weight(.bold)).monospacedDigit().frame(width: 16, alignment: .leading)
                    Flag(iso2: row.iso2, height: 15)
                    Text(row.name).font(.subheadline.weight(row.mine ? .bold : .medium)).lineLimit(1)
                    Spacer()
                    Text(row.gap ?? "").font(.footnote).monospacedDigit().foregroundStyle(Palette.muted)
                }
                .padding(.horizontal, 8)
                .frame(height: 26)
                .background(row.mine ? Palette.mine : .clear, in: .rect(cornerRadius: 8))
                .padding(.horizontal, -8)
            }
        }
    }
}

private struct Badge: View {
    let phase: String

    var body: some View {
        let (text, live): (String, Bool) = switch phase {
        case "racing": ("LIVE", true)
        case "unofficial": ("UNOFFICIAL", false)
        case "official": ("OFFICIAL", false)
        default: ("UP NEXT", false)
        }
        Text(text)
            .font(.caption2.weight(.bold)).kerning(0.6)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(live ? Palette.live : Palette.divider, in: .capsule)
    }
}

/// "Lap 9 of 13½" (or "9 of 13½" when short).
private struct LapText: View {
    let state: RaceActivityAttributes.ContentState
    var short = false

    var body: some View {
        if let lap = state.lap, state.phase == "racing" {
            Text("\(short ? "" : "Lap ")\(lap) \(Text("of \(state.laps)").foregroundStyle(Palette.muted))")
        } else if state.phase == "upNext" {
            Text("Up next")
        } else {
            Text(state.phase == "official" ? "Final" : "Result")
        }
    }
}

private struct Flag: View {
    let iso2: String?
    let height: CGFloat

    var body: some View {
        if let iso2, let image = UIImage(named: "Flags/\(iso2.lowercased())") {
            Image(uiImage: image).resizable().scaledToFill()
                .frame(width: (height * 4 / 3).rounded(), height: height)
                .clipShape(.rect(cornerRadius: 2))
        }
    }
}

private func ordinal(_ n: Int) -> String {
    let teen = (11...13).contains(n % 100)
    let suffix = teen ? "th" : ["th", "st", "nd", "rd"][safe: n % 10] ?? "th"
    return "\(n)\(suffix)"
}

private extension Array {
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}

/// The app's Theme colors the widget uses (hero card, live red).
private enum Palette {
    static let hero = Color(red: 0x11 / 255, green: 0x22 / 255, blue: 0x2C / 255)
    static let muted = Color(red: 0xAF / 255, green: 0xC2 / 255, blue: 0xC2 / 255)
    static let divider = Color(red: 0x2E / 255, green: 0x49 / 255, blue: 0x54 / 255)
    static let live = Color(red: 0xEE / 255, green: 0x60 / 255, blue: 0x4D / 255)
    static let mine = Color(red: 0x80 / 255, green: 0xD3 / 255, blue: 0xF2 / 255).opacity(0.16)
    static let mineCell = Color(red: 0x1F / 255, green: 0x3A / 255, blue: 0x47 / 255)
}
