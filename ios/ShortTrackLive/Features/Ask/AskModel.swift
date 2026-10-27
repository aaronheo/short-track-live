import SwiftUI

/// One question and its answer.
struct AskTurn: Identifiable, Equatable {
    enum State: Equatable { case working, done, stopped, failed(String) }

    let id = UUID()
    let question: String
    /// Lookups that finished ("Searched athletes for “van”").
    var steps: [String] = []
    var answer = ""
    var state = State.working
}

/// A conversation with Ask. Kept only while the screen is open: nothing is
/// saved on the phone or the server.
@MainActor @Observable
final class AskModel {
    private(set) var turns: [AskTurn] = []
    @ObservationIgnored private var task: Task<Void, Never>?

    var isWorking: Bool { turns.last?.state == .working }

    func ask(_ question: String) {
        let text = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isWorking else { return }
        // Earlier answers give the model the context for follow-ups.
        var messages: [[String: String]] = []
        for turn in turns where !turn.answer.isEmpty {
            messages.append(["role": "user", "content": turn.question])
            messages.append(["role": "assistant", "content": turn.answer])
        }
        messages.append(["role": "user", "content": text])
        turns.append(AskTurn(question: text))
        let index = turns.count - 1
        task = Task { await stream(messages, into: index) }
    }

    func stop() {
        task?.cancel()
        if let last = turns.indices.last, turns[last].state == .working { turns[last].state = .stopped }
    }

    func newChat() {
        stop()
        withAnimation(.snappy) { turns = [] }
    }

    private func stream(_ messages: [[String: String]], into index: Int) async {
        do {
            var request = URLRequest(url: AppConfig.baseURL.appending(path: "chat"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            if let token = AppConfig.token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
            request.httpBody = try JSONSerialization.data(withJSONObject: ["messages": messages])
            let config = URLSessionConfiguration.default
            config.timeoutIntervalForRequest = 90 // between bytes; lookups can take a while
            let (bytes, response) = try await URLSession(configuration: config).bytes(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard status == 200 else {
                var body = Data()
                for try await byte in bytes { body.append(byte) }
                let message = (try? JSONDecoder().decode([String: String].self, from: body))?["error"]
                throw AskError.server(message ?? APIError.status(status).localizedDescription)
            }
            for try await line in bytes.lines {
                guard line.hasPrefix("data: "), let data = line.dropFirst(6).data(using: .utf8),
                      let event = try? JSONDecoder().decode(AskEvent.self, from: data) else { continue }
                apply(event, to: index)
            }
            if turns.indices.contains(index), turns[index].state == .working { turns[index].state = .done }
        } catch is CancellationError {
        } catch let error as URLError where error.code == .cancelled {
        } catch {
            guard turns.indices.contains(index), turns[index].state == .working else { return }
            turns[index].state = .failed((error as? AskError)?.message ?? "Couldn’t reach the server. Check your connection and try again.")
        }
    }

    private func apply(_ event: AskEvent, to index: Int) {
        guard turns.indices.contains(index) else { return }
        switch event.type {
        case "step":
            withAnimation(.snappy) { turns[index].steps.append(event.text ?? "") }
        case "delta":
            turns[index].answer += event.text ?? ""
        case "reset":
            turns[index].answer = ""
        case "done":
            withAnimation(.snappy) { turns[index].state = .done }
        case "error":
            turns[index].state = .failed(event.message ?? "Something went wrong answering that.")
        default:
            break
        }
    }
}

private struct AskEvent: Decodable {
    let type: String
    let text: String?
    let message: String?
}

private enum AskError: Error {
    case server(String)

    var message: String {
        switch self { case .server(let message): message }
    }
}

enum AskText {
    /// Whether search text reads like a question rather than a name. Names
    /// run to four words ("Jens van 't Wout"), so only five count as a question.
    static func looksLikeQuestion(_ text: String) -> Bool {
        let t = text.trimmingCharacters(in: .whitespaces).lowercased()
        guard !t.isEmpty else { return false }
        let words = t.split(separator: " ")
        if t.hasSuffix("?") || words.count >= 5 { return true }
        let first = words.first.map(String.init) ?? ""
        return ["who", "who's", "whos", "what", "what's", "when", "where", "which", "how", "why", "did", "does", "do",
                "has", "have", "is", "was", "were", "can", "show", "compare", "list", "tell", "fastest", "best"].contains(first)
    }

    /// Answer text with bold and links; "- " list lines become bullets.
    static func attributed(_ markdown: String) -> AttributedString {
        let bulleted = markdown.split(separator: "\n", omittingEmptySubsequences: false).map { line -> String in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            return trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") ? "•  " + trimmed.dropFirst(2) : String(line)
        }.joined(separator: "\n")
        return (try? AttributedString(markdown: bulleted, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(markdown)
    }
}
