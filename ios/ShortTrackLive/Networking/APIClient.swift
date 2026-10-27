import Foundation

/// Server URL and token from ios/Config (App.xcconfig, overridden by the
/// gitignored Secrets.xcconfig). Launch arguments `-APIBaseURL <url>` and
/// `-APIToken <token>` override both.
enum AppConfig {
    static var baseURL: URL {
        if let text = setting("APIBaseURL"), let url = URL(string: text) { return url }
        return URL(string: "http://localhost:4310")!
    }

    static var token: String? { setting("APIToken") }

    private static func setting(_ key: String) -> String? {
        let value = UserDefaults.standard.string(forKey: key) ?? Bundle.main.object(forInfoDictionaryKey: key) as? String
        return value?.trimmingCharacters(in: .whitespaces).nonEmpty
    }
}

enum APIError: LocalizedError {
    case status(Int)

    var errorDescription: String? {
        switch self {
        case .status(401): "The server rejected the app's token (API_TOKEN in ios/Config/Secrets.xcconfig)"
        case .status(404): "Not found"
        case .status(let code): "Server error (\(code))"
        }
    }
}

/// Talks to our server only (never to ISU). Remembers each response's ETag so
/// a poll that finds nothing new costs a 304 and no decoding.
actor APIClient {
    static let shared = APIClient(baseURL: AppConfig.baseURL, token: AppConfig.token)

    private let baseURL: URL
    private let token: String?
    private let session: URLSession
    private var etags: [String: String] = [:]

    init(baseURL: URL, token: String? = nil) {
        self.baseURL = baseURL
        self.token = token
        let config = URLSessionConfiguration.default
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 15
        session = URLSession(configuration: config)
    }

    /// The decoded response, or nil when it hasn't changed since the last call
    /// for this path. `cached: false` always fetches (paged lists).
    func get<T: Decodable & Sendable>(_ path: String, query: [URLQueryItem] = [], cached: Bool = true,
                                      as type: T.Type = T.self) async throws -> T? {
        var url = baseURL.appending(path: path)
        if !query.isEmpty { url.append(queryItems: query) }
        let key = url.absoluteString
        var request = URLRequest(url: url)
        if cached, let etag = etags[key] { request.setValue(etag, forHTTPHeaderField: "If-None-Match") }
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await session.data(for: request)
        let http = response as? HTTPURLResponse
        switch http?.statusCode ?? 0 {
        case 304:
            return nil
        case 200:
            let value = try JSONDecoder.api.decode(T.self, from: data)
            if cached { etags[key] = http?.value(forHTTPHeaderField: "ETag") }
            return value
        case let code:
            throw APIError.status(code)
        }
    }

    /// Forget the ETag so the next call returns a value (a screen that was
    /// recreated has nothing to fall back on).
    func reset(_ path: String) {
        etags[baseURL.appending(path: path).absoluteString] = nil
    }
}
