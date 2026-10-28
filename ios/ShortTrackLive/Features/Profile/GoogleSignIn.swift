import AuthenticationServices
import CryptoKit
import UIKit

/// Sign in with Google without Google's SDK: Google's page in the system's
/// sign-in sheet, the authorization code flow with PKCE (an iOS client has no
/// secret), then the ID token, which our server checks.
@MainActor
final class GoogleSignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
    enum Failure: LocalizedError {
        case notSetUp, noCode, badState, noToken

        var errorDescription: String? {
            switch self {
            case .notSetUp: "Google sign-in isn’t set up in this build (GOOGLE_CLIENT_ID in ios/Config)."
            case .noCode, .badState, .noToken: "Google didn’t finish signing you in. Try again."
            }
        }
    }

    /// The iOS OAuth client id from Google Cloud ("123-abc.apps.googleusercontent.com").
    static var clientID: String? { AppConfig.setting("GoogleClientID") }

    static var isSetUp: Bool { clientID != nil }

    private var session: ASWebAuthenticationSession?

    /// Shows Google's sign-in and returns its ID token. Throws CancellationError
    /// when the person closes the sheet.
    func idToken() async throws -> String {
        guard let clientID = Self.clientID else { throw Failure.notSetUp }
        // Google's redirect for an iOS client: its id reversed, as a URL scheme.
        let scheme = clientID.split(separator: ".").reversed().joined(separator: ".")
        let redirect = "\(scheme):/oauthredirect"
        let verifier = Self.random(32)
        let state = Self.random(16)
        var auth = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
        auth.queryItems = [
            .init(name: "client_id", value: clientID),
            .init(name: "redirect_uri", value: redirect),
            .init(name: "response_type", value: "code"),
            .init(name: "scope", value: "openid email profile"),
            .init(name: "code_challenge", value: Self.base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))),
            .init(name: "code_challenge_method", value: "S256"),
            .init(name: "state", value: state),
            .init(name: "prompt", value: "select_account"),
        ]

        let callback: URL = try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: auth.url!, callback: .customScheme(scheme)) { url, error in
                if let url {
                    continuation.resume(returning: url)
                } else if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin {
                    continuation.resume(throwing: CancellationError())
                } else {
                    continuation.resume(throwing: error ?? Failure.noCode)
                }
            }
            session.presentationContextProvider = self
            self.session = session
            session.start()
        }
        session = nil

        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard items.first(where: { $0.name == "state" })?.value == state else { throw Failure.badState }
        guard let code = items.first(where: { $0.name == "code" })?.value else { throw Failure.noCode }

        var exchange = URLRequest(url: URL(string: "https://oauth2.googleapis.com/token")!)
        exchange.httpMethod = "POST"
        exchange.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var form = URLComponents()
        form.queryItems = [
            .init(name: "code", value: code),
            .init(name: "client_id", value: clientID),
            .init(name: "redirect_uri", value: redirect),
            .init(name: "grant_type", value: "authorization_code"),
            .init(name: "code_verifier", value: verifier),
        ]
        exchange.httpBody = Data((form.percentEncodedQuery ?? "").utf8)
        let (data, _) = try await URLSession.shared.data(for: exchange)
        struct Tokens: Decodable { let id_token: String? }
        guard let token = try JSONDecoder().decode(Tokens.self, from: data).id_token else { throw Failure.noToken }
        return token
    }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
            return windows.first(where: \.isKeyWindow) ?? windows.first ?? ASPresentationAnchor()
        }
    }

    private static func random(_ bytes: Int) -> String {
        var data = Data(count: bytes)
        _ = data.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, bytes, $0.baseAddress!) }
        return base64URL(data)
    }

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
