import SwiftUI

/// Light, dark, or follow the iPhone. Saved on the phone; RootView applies it.
enum Appearance: String, CaseIterable {
    case system, light, dark

    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

struct SettingsView: View {
    @AppStorage("appearance") private var appearance = Appearance.system
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    section("Appearance") {
                        VStack(spacing: 0) {
                            HStack(spacing: 0) {
                                choice(.light, title: "Light")
                                choice(.dark, title: "Dark")
                            }
                            .padding(.horizontal, 16)
                            .padding(.top, 20)
                            .padding(.bottom, 14)
                            RowDivider(leading: 16)
                            Toggle(isOn: Binding(
                                get: { appearance == .system },
                                set: { appearance = $0 ? .system : (scheme == .dark ? .dark : .light) }
                            )) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Match iPhone").font(.callout.weight(.medium)).foregroundStyle(Theme.ink)
                                    Text("Switches with your iPhone’s light or dark mode")
                                        .font(.footnote)
                                        .foregroundStyle(Theme.muted)
                                }
                            }
                            .tint(.green)
                            .padding(.horizontal, 16)
                            .frame(minHeight: 60)
                        }
                    }
                    section("About") {
                        VStack(spacing: 0) {
                            row("Results", value: "ISU")
                            RowDivider(leading: 16)
                            row("Version", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "–")
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
            .scrollIndicators(.hidden)
            .tabBarHidesOnScroll()
            .background(Theme.ground)
            .navigationTitle("Settings")
        }
        .sensoryFeedback(.selection, trigger: appearance)
    }

    /// The appearance in effect now (Match iPhone shows the iPhone's).
    private var current: Appearance {
        appearance == .system ? (scheme == .dark ? .dark : .light) : appearance
    }

    private func choice(_ option: Appearance, title: String) -> some View {
        let selected = current == option
        return Button {
            withAnimation(.snappy) { appearance = option }
        } label: {
            VStack(spacing: 8) {
                AppearancePreview(dark: option == .dark)
                Text(title).font(.subheadline.weight(.medium)).foregroundStyle(Theme.ink)
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(selected ? Theme.link : Theme.faint)
                    .contentTransition(.symbolEffect(.replace))
            }
            .frame(maxWidth: .infinity)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).sectionLabel().padding(.leading, 16)
            content()
                .card()
                .clipShape(.rect(cornerRadius: 16))
        }
    }

    private func row(_ title: String, value: String) -> some View {
        HStack {
            Text(title).foregroundStyle(Theme.ink)
            Spacer()
            Text(value).foregroundStyle(Theme.muted)
        }
        .font(.callout)
        .padding(.horizontal, 16)
        .frame(minHeight: 48)
    }
}

/// A tiny phone showing the app in light or dark, whatever mode is on now.
private struct AppearancePreview: View {
    let dark: Bool

    var body: some View {
        let ground = dark ? Color(hex: 0x0B0E12) : Color(hex: 0xF4F6F8)
        let card = dark ? Color(hex: 0x161B22) : .white
        let line = dark ? Color(hex: 0x2A333D) : Color(hex: 0xD9E0E6)
        VStack(alignment: .leading, spacing: 7) {
            Capsule().fill(dark ? Color(hex: 0x3A4552) : Color(hex: 0xC9D2DA)).frame(width: 40, height: 7)
            ForEach(0..<2, id: \.self) { _ in
                VStack(alignment: .leading, spacing: 6) {
                    ForEach([0.7, 0.45, 0.6], id: \.self) { width in
                        Capsule().fill(line).frame(width: 56 * width, height: 5)
                    }
                }
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(card, in: .rect(cornerRadius: 8))
            }
            Spacer(minLength: 0)
        }
        .padding(EdgeInsets(top: 18, leading: 10, bottom: 10, trailing: 10))
        .frame(width: 92, height: 150)
        .background(ground, in: .rect(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(line, lineWidth: 1))
        .accessibilityHidden(true)
    }
}
