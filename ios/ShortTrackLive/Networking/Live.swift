import SwiftUI

/// One screen's data, kept fresh while the screen is visible:
///
///     .task { await live.run() }
///
/// `run()` loads, then polls at whatever `interval` says for the current value
/// (nil = stop, e.g. a finished round). SwiftUI cancels the task when the
/// screen goes away, which stops the polling.
@MainActor @Observable
final class Live<Value: Decodable & Sendable> {
    private(set) var value: Value?
    private(set) var error: (any Error)?
    private(set) var updatedAt: Date?

    let path: String
    @ObservationIgnored private let interval: (Value) -> Duration?
    @ObservationIgnored private let client: APIClient

    init(_ path: String, client: APIClient = .shared, interval: @escaping (Value) -> Duration?) {
        self.path = path
        self.client = client
        self.interval = interval
    }

    /// For previews and tests.
    init(preview value: Value) {
        self.path = ""
        self.client = .shared
        self.interval = { _ in nil }
        self.value = value
        self.updatedAt = .now
    }

    func refresh() async {
        guard !path.isEmpty else { return }
        do {
            if value == nil { await client.reset(path) }
            if let fresh = try await client.get(path, as: Value.self) {
                withAnimation(.snappy) { value = fresh }
            }
            updatedAt = .now
            error = nil
        } catch is CancellationError {
        } catch let err as URLError where err.code == .cancelled {
        } catch {
            self.error = error
        }
    }

    func run() async {
        await refresh()
        while !Task.isCancelled {
            let wait: Duration? = if let value { interval(value) } else { error != nil ? .seconds(5) : nil }
            // Retry sooner after an error, even on a screen that doesn't poll.
            guard let wait = error != nil ? min(wait ?? .seconds(10), .seconds(10)) : wait else { return }
            try? await Task.sleep(for: wait)
            if Task.isCancelled { return }
            await refresh()
        }
    }
}
