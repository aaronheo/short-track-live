import SwiftUI

/// Top of Profile, signed out: sign in with Google to keep favorites.
struct SignInCard: View {
    @Environment(AccountStore.self) private var account

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "checkmark.icloud")
                    .font(.title3.weight(.medium))
                    .foregroundStyle(Theme.link)
                    .frame(width: 40, height: 40)
                    .background(Theme.link.opacity(0.1), in: .circle)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Keep your favorites").font(.headline).foregroundStyle(Theme.ink)
                    Text("Sign in with Google to save your favorite skaters and settings, and get them back on any iPhone or iPad.")
                        .font(.subheadline)
                        .foregroundStyle(Theme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            GoogleButton()
            Text("Without an account, everything stays on this iPhone.")
                .font(.footnote)
                .foregroundStyle(Theme.muted)
                .frame(maxWidth: .infinity)
        }
        .padding(EdgeInsets(top: 20, leading: 16, bottom: 16, trailing: 16))
        .card()
        .clipShape(.rect(cornerRadius: 16))
    }
}

/// Google's standard button: white with its "G", dark in dark mode.
private struct GoogleButton: View {
    @Environment(AccountStore.self) private var account
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button { Task { await account.signInWithGoogle() } } label: {
            HStack(spacing: 10) {
                if account.signingIn {
                    ProgressView().controlSize(.small)
                } else {
                    Image("GoogleG").resizable().frame(width: 18, height: 18).accessibilityHidden(true)
                }
                Text("Continue with Google").font(.body.weight(.semibold))
            }
            .foregroundStyle(scheme == .dark ? Color(hex: 0xE3E3E3) : Color(hex: 0x1F1F1F))
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(scheme == .dark ? Color(hex: 0x131314) : .white, in: .capsule)
            .overlay(Capsule().strokeBorder(scheme == .dark ? Color(hex: 0x8E918F) : Color(hex: 0xC6CCD2), lineWidth: 1))
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .disabled(account.signingIn)
    }
}

/// Top of Profile, signed in: who, and when it last synced. Opens Account.
struct AccountRow: View {
    @Environment(AccountStore.self) private var account

    var body: some View {
        NavigationLink { AccountView() } label: {
            HStack(spacing: 12) {
                Avatar(name: account.account?.name, size: 44)
                VStack(alignment: .leading, spacing: 2) {
                    Text(account.account?.name ?? account.account?.email ?? "Signed in")
                        .font(.headline)
                        .foregroundStyle(Theme.ink)
                        .lineLimit(1)
                    Text(account.syncedAt == nil ? "Google" : "Google · Synced \(syncedText)")
                        .font(.footnote)
                        .foregroundStyle(Theme.muted)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.faint)
            }
            .padding(.leading, 16)
            .padding(.trailing, 14)
            .frame(minHeight: 72)
            .contentShape(.rect)
        }
        .buttonStyle(RowButtonStyle())
        .card()
        .clipShape(.rect(cornerRadius: 16))
    }

    private var syncedText: String {
        guard let date = account.syncedAt else { return "" }
        return Date.now.timeIntervalSince(date) < 60 ? "just now" : date.formatted(.relative(presentation: .named))
    }
}

/// The account: who's signed in, sign out, delete.
struct AccountView: View {
    @Environment(AccountStore.self) private var account
    @Environment(\.dismiss) private var dismiss
    @State private var confirmSignOut = false
    @State private var confirmDelete = false
    @State private var failed: String?

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                VStack(spacing: 6) {
                    Avatar(name: account.account?.name, size: 76)
                    Text(account.account?.name ?? "Your account")
                        .font(.title.weight(.bold))
                        .foregroundStyle(Theme.ink)
                        .padding(.top, 6)
                    Text("Signed in with Google").font(.subheadline).foregroundStyle(Theme.muted)
                }
                .frame(maxWidth: .infinity)

                VStack(alignment: .leading, spacing: 8) {
                    VStack(spacing: 0) {
                        row("Name", account.account?.name ?? "–")
                        RowDivider(leading: 16)
                        row("Email", account.account?.email ?? "–")
                    }
                    .card()
                    .clipShape(.rect(cornerRadius: 16))
                    Text("Your favorites and settings sync to this account.\(synced)")
                        .font(.footnote)
                        .foregroundStyle(Theme.muted)
                        .padding(.horizontal, 16)
                }

                VStack(alignment: .leading, spacing: 8) {
                    VStack(spacing: 0) {
                        Button("Sign out") { confirmSignOut = true }
                            .buttonStyle(ActionRowStyle(color: Theme.link))
                        RowDivider(leading: 16)
                        Button("Delete account") { confirmDelete = true }
                            .buttonStyle(ActionRowStyle(color: Theme.live))
                    }
                    .card()
                    .clipShape(.rect(cornerRadius: 16))
                    Text("Signing out keeps your favorites on this iPhone. Deleting the account removes everything saved in it.")
                        .font(.footnote)
                        .foregroundStyle(Theme.muted)
                        .padding(.horizontal, 16)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
        .scrollIndicators(.hidden)
        .background(Theme.ground)
        .navigationTitle("Account")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Sign out?", isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button("Sign out") { Task { await account.signOut(); dismiss() } }
        } message: {
            Text("Your favorites and notifications stay on this iPhone, and stay saved in your account for next time.")
        }
        .alert("Delete your account?", isPresented: $confirmDelete) {
            Button("Delete account", role: .destructive) {
                Task {
                    do {
                        try await account.deleteAccount()
                        dismiss()
                    } catch {
                        failed = "Couldn’t delete your account. Check your connection and try again."
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This deletes your account and the favorites and settings saved in it. It can’t be undone. This iPhone keeps its own copy.")
        }
        .alert("Not deleted", isPresented: Binding(get: { failed != nil }, set: { if !$0 { failed = nil } })) {
            Button("OK") {}
        } message: {
            Text(failed ?? "")
        }
    }

    private var synced: String {
        guard let date = account.syncedAt else { return "" }
        return Date.now.timeIntervalSince(date) < 60 ? " Synced just now." : " Synced \(date.formatted(.relative(presentation: .named)))."
    }

    private func row(_ title: String, _ value: String) -> some View {
        HStack(spacing: 12) {
            Text(title).foregroundStyle(Theme.ink)
            Spacer()
            Text(value).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.middle)
        }
        .font(.callout)
        .padding(.horizontal, 16)
        .frame(minHeight: 48)
    }
}

/// A full-width text button row in a card ("Sign out").
private struct ActionRowStyle: ButtonStyle {
    let color: Color

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.callout.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 16)
            .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
            .background(configuration.isPressed ? Theme.divider : .clear)
            .contentShape(.rect)
    }
}

/// The account's initial in a circle.
private struct Avatar: View {
    let name: String?
    let size: CGFloat

    var body: some View {
        Text(name?.first.map { String($0).uppercased() } ?? "?")
            .font(.system(size: size * 0.42, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(Theme.link, in: .circle)
            .accessibilityHidden(true)
    }
}
