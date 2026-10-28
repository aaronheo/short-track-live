import SwiftUI

/// Ask: a conversation about results. Answers stream in after the lookups
/// they needed; names and races in them link to the athlete and heat screens.
struct AskView: View {
    @Environment(AppModel.self) private var app
    @State private var ask = AskModel()
    @State private var draft = ""
    @FocusState private var composing: Bool
    let question: String

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(ask.turns) { turn in
                        TurnView(turn: turn).id(turn.id)
                    }
                    if !ask.turns.isEmpty && !ask.isWorking {
                        Text("AI answers can be wrong. Tap a race or athlete to check.\nThis chat isn’t saved.")
                            .font(.caption)
                            .foregroundStyle(Theme.muted)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 4)
                    }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 16)
                .frame(maxWidth: 700)
                .frame(maxWidth: .infinity)
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: ask.turns.last?.answer.count) { withAnimation { proxy.scrollTo("end", anchor: .bottom) } }
            .onChange(of: ask.turns.count) { withAnimation { proxy.scrollTo("end", anchor: .bottom) } }
        }
        .safeAreaInset(edge: .bottom) { composer }
        // On a phone the composer takes the tab bar's place; beside a sidebar
        // there's no back button, so the tab bar is the way out.
        .toolbarVisibility(app.isSplit ? .automatic : .hidden, for: .tabBar)
        .environment(\.openURL, OpenURLAction { url in
            app.openFromAsk(url) ? .handled : .systemAction
        })
        .screen(title: "Ask")
        .toolbar {
            ToolbarItem(placement: .principal) {
                Text("Ask").font(.headline).foregroundStyle(Theme.ink)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("New chat", systemImage: "square.and.pencil") {
                    ask.newChat()
                    composing = true
                }
                .disabled(ask.turns.isEmpty)
            }
        }
        .task {
            if ask.turns.isEmpty { ask.ask(question) }
        }
        .onDisappear { ask.stop() }
        .sensoryFeedback(.success, trigger: ask.turns.last?.state == .done)
    }

    private var composer: some View {
        HStack(spacing: 8) {
            TextField(ask.turns.isEmpty ? "Ask a question" : "Ask a follow-up", text: $draft, axis: .vertical)
                .lineLimit(1...4)
                .focused($composing)
                .submitLabel(.send)
                .onSubmit(send)
                .font(.body)
                .padding(.leading, 18)
                .padding(.vertical, 12)
            Button {
                if ask.isWorking { ask.stop() } else { send() }
            } label: {
                Image(systemName: ask.isWorking ? "stop.fill" : "arrow.up")
                    .font(.system(size: ask.isWorking ? 13 : 17, weight: .bold))
                    .foregroundStyle(canSend || ask.isWorking ? Theme.onInkFill : Theme.faint)
                    .frame(width: 40, height: 40)
                    .background(canSend || ask.isWorking ? Theme.inkFill : Theme.border, in: .circle)
                    .contentTransition(.symbolEffect(.replace))
            }
            .buttonStyle(.plain)
            .disabled(!canSend && !ask.isWorking)
            .accessibilityLabel(ask.isWorking ? "Stop answering" : "Send")
            .padding(.trailing, 6)
        }
        .background(.regularMaterial, in: .rect(cornerRadius: 26))
        .shadow(color: .black.opacity(0.1), radius: 12, y: 4)
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
    }

    private var canSend: Bool {
        !ask.isWorking && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func send() {
        guard canSend else { return }
        ask.ask(draft)
        draft = ""
    }
}

private struct TurnView: View {
    let turn: AskTurn

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(turn.question)
                .font(.body)
                .foregroundStyle(Theme.onInkFill)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Theme.inkFill, in: UnevenRoundedRectangle(topLeadingRadius: 20, bottomLeadingRadius: 20, bottomTrailingRadius: 6, topTrailingRadius: 20))
                .frame(maxWidth: 300, alignment: .trailing)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .textSelection(.enabled)

            if !turn.steps.isEmpty || turn.state == .working {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(turn.steps.enumerated()), id: \.offset) { _, step in
                        Label(step, systemImage: "checkmark.circle")
                            .transition(.opacity.combined(with: .move(edge: .top)))
                    }
                    if turn.state == .working {
                        HStack(spacing: 6) {
                            ProgressView().controlSize(.mini)
                            Text(turn.answer.isEmpty ? (turn.steps.isEmpty ? "Thinking…" : "Looking it up…") : "Writing the answer…")
                        }
                    }
                }
                .font(.footnote)
                .foregroundStyle(Theme.muted)
            }

            if !turn.answer.isEmpty {
                Text(AskText.attributed(turn.answer))
                    .font(.body)
                    .lineSpacing(3)
                    .foregroundStyle(Theme.text3)
                    // No .textSelection here: it swallows taps on the links.
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            switch turn.state {
            case .failed(let message):
                Label(message, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(Theme.muted)
            case .stopped:
                Text("Stopped").font(.footnote).foregroundStyle(Theme.muted)
            case .working, .done:
                EmptyView()
            }
        }
    }
}
