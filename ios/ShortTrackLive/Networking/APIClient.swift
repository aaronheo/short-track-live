import Foundation

enum AppConfig {
    /// `-APIBaseURL http://192.168.1.20:4310` as a launch argument overrides the
    /// build setting (handy on a real device, where localhost is the phone).
    static var baseURL: URL {
        if let text = UserDefaults.standard.string(forKey: "APIBaseURL"), let url = URL(string: text) { return url }
        if let text = Bundle.main.object(forInfoDictionaryKey: "APIBaseURL") as? String, let url = URL(string: text) { return url }
        return URL(string: "http://localhost:4310")!
    }
}

enum APIError: LocalizedError {
    case status(Int)

    var errorDescription: String? {
        switch self {
        case .status(404): "Not found"
        case .status(let code): "Server error (\(code))"
        }
    }
}

/// Talks to our server only (never to ISU). Remembers each response's ETag so
/// a poll that finds nothing new costs a 304 and no decoding.
actor APIClient {
    static let shared = APIClient(baseURL: AppConfig.baseURL)

    private let baseURL: URL
    private let session: URLSession
    private var etags: [String: String] = [:]

    init(baseURL: URL) {
        self.baseURL = baseURL
        let config = URLSessionConfiguration.default
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 15
        session = URLSession(configuration: config)
    }

    /// The decoded response, or nil when it hasn't changed since the last call
    /// for this path.
    func get<T: Decodable & Sendable>(_ path: String, as type: T.Type = T.self) async throws -> T? {
        var request = URLRequest(url: baseURL.appending(path: path))
        if let etag = etags[path] { request.setValue(etag, forHTTPHeaderField: "If-None-Match") }
        let (data, response) = try await session.data(for: request)
        let http = response as? HTTPURLResponse
        switch http?.statusCode ?? 0 {
        case 304:
            return nil
        case 200:
            let value = try JSONDecoder.api.decode(T.self, from: data)
            etags[path] = http?.value(forHTTPHeaderField: "ETag")
            return value
        case let code:
            throw APIError.status(code)
        }
    }

    /// Forget the ETag so the next call returns a value (a screen that was
    /// recreated has nothing to fall back on).
    func reset(_ path: String) {
        etags[path] = nil
    }
}
