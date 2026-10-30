import SwiftUI

/// Trackboard's graphite, warm-paper, and ice-blue visual language.
enum Theme {
    static let ground = Color(light: 0xE7EEF0, dark: 0x0B1218)
    static let surface = Color(light: 0xFFFCF6, dark: 0x17222A)
    static let divider = Color(light: 0xE1E8E8, dark: 0x293741)
    static let border = Color(light: 0xD0DDDE, dark: 0x34444E)
    static let segment = Color(light: 0xD9E4E6, dark: 0x202D35)
    static let segmentSelected = Color(light: 0xFFFCF6, dark: 0x31414B)
    static let selectedRow = Color(light: 0xF4FAFA, dark: 0x24343D)
    static let liveTint = Color(light: 0xFFE8E1, dark: 0x432320)

    static let ink = Color(light: 0x11222C, dark: 0xF7F3EA)
    static let text2 = Color(light: 0x354A54, dark: 0xCDD8D8)
    static let text3 = Color(light: 0x243942, dark: 0xDFE7E4)
    static let muted = Color(light: 0x5C737B, dark: 0x9BB0B3)
    static let muted2 = Color(light: 0x466069, dark: 0xB8C7C8)
    static let faint = Color(light: 0x81979D, dark: 0x80969A)
    static let link = Color(light: 0x16789E, dark: 0x80D3F2)

    static let live = Color(hex: 0xEE604D)
    /// Solid chips (Q badges, the selected round) flip to light in dark mode.
    static let inkFill = Color(light: 0x11222C, dark: 0xEDF4F1)
    static let onInkFill = Color(light: 0xFFFFFF, dark: 0x0B1218)

    /// The live event card stays dark in both modes.
    static let hero = Color(light: 0x11222C, dark: 0x101C23)
    static let heroDivider = Color(light: 0x2E4954, dark: 0x314A54)
    static let heroMuted = Color(hex: 0xAFC2C2)

    static let chartWinner = Color(light: 0x2284A9, dark: 0x55B6D8)
    static let chartClimber = Color(light: 0xE66A4E, dark: 0xF08368)
    static let chartOther = Color(light: 0xB7C5C5, dark: 0x52636A)

    static let yellowCard = Color(hex: 0xF2C200)
    static let redCard = Color(hex: 0xD7192F)
    static let gold = Color(hex: 0xD4A72C)
    static let silver = Color(hex: 0x9AA5B1)
    static let bronze = Color(hex: 0xB87333)
    /// Favorite star (darker than gold so it reads on white).
    static let star = Color(light: 0xB7791F, dark: 0xE0A82E)
    /// Moving up (standings).
    static let positive = Color(light: 0x21845D, dark: 0x5DCAA0)
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
    /// Warm scorecard that floats subtly above the cool app ground.
    func card(radius: CGFloat = 16) -> some View {
        background(Theme.surface, in: .rect(cornerRadius: radius))
            .overlay {
                RoundedRectangle(cornerRadius: radius)
                    .strokeBorder(Theme.border.opacity(0.72), lineWidth: 1)
            }
            .shadow(color: .black.opacity(0.045), radius: 8, y: 3)
    }

    /// Small uppercase section label ("QUALIFIED · 8/14").
    func sectionLabel() -> some View {
        font(.caption.weight(.semibold))
            .tracking(0.5)
            .textCase(.uppercase)
            .foregroundStyle(Theme.muted)
    }
}
