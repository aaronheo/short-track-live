import SwiftUI

/// Design tokens from the canvas. Dark values come from design/theme.py.
enum Theme {
    static let ground = Color(light: 0xF3F6F9, dark: 0x0B0E12)
    static let surface = Color(light: 0xFFFFFF, dark: 0x161B22)
    static let divider = Color(light: 0xEEF2F5, dark: 0x232A33)
    static let border = Color(light: 0xDDE4EA, dark: 0x2A333D)
    static let segment = Color(light: 0xE3E9EF, dark: 0x1F262E)
    static let segmentSelected = Color(light: 0xFFFFFF, dark: 0x3A4552)
    static let selectedRow = Color(light: 0xFFFFFF, dark: 0x232A33)
    static let liveTint = Color(light: 0xFCE8EB, dark: 0x3A1419)

    static let ink = Color(light: 0x0D1B2A, dark: 0xF1F4F8)
    static let text2 = Color(light: 0x3A4652, dark: 0xC5CED8)
    static let text3 = Color(light: 0x23303C, dark: 0xD5DCE4)
    static let muted = Color(light: 0x576574, dark: 0x97A3B0)
    static let muted2 = Color(light: 0x46525E, dark: 0xB3BDC8)
    static let faint = Color(light: 0x8A97A4, dark: 0x7D8996)
    static let link = Color(light: 0x1E47B8, dark: 0x7AA7FF)

    static let live = Color(hex: 0xC8102E)
    /// Solid chips (Q badges, the selected round) flip to light in dark mode.
    static let inkFill = Color(light: 0x0D1B2A, dark: 0xE6EBF0)
    static let onInkFill = Color(light: 0xFFFFFF, dark: 0x0B0E12)

    /// The live event card stays dark in both modes.
    static let hero = Color(light: 0x0D1B2A, dark: 0x1B2A3C)
    static let heroDivider = Color(light: 0x24364A, dark: 0x2E4258)
    static let heroMuted = Color(hex: 0xA9B6C3)

    static let chartWinner = Color(light: 0x2A78D6, dark: 0x3987E5)
    static let chartClimber = Color(light: 0xEB6834, dark: 0xD95926)
    static let chartOther = Color(light: 0xB9C2CB, dark: 0x4A5562)

    static let yellowCard = Color(hex: 0xF2C200)
    static let redCard = Color(hex: 0xD7192F)
    static let gold = Color(hex: 0xD4A72C)
    static let silver = Color(hex: 0x9AA5B1)
    static let bronze = Color(hex: 0xB87333)
}

extension Color {
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }

    init(light: UInt32, dark: UInt32) {
        self.init(UIColor { traits in
            UIColor(Color(hex: traits.userInterfaceStyle == .dark ? dark : light))
        })
    }
}

extension Font {
    /// SF Pro condensed, for big numbers and event titles (the design's Barlow Condensed).
    static func condensed(_ style: Font.TextStyle, weight: Font.Weight = .bold) -> Font {
        .system(style, weight: weight).width(.condensed)
    }
}

extension View {
    /// White rounded card on the ground color.
    func card(radius: CGFloat = 16) -> some View {
        background(Theme.surface, in: .rect(cornerRadius: radius))
    }

    /// Small uppercase section label ("QUALIFIED · 8/14").
    func sectionLabel() -> some View {
        font(.caption.weight(.semibold))
            .tracking(0.5)
            .textCase(.uppercase)
            .foregroundStyle(Theme.muted)
    }
}
