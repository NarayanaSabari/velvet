//! Blocking native API client. Call from a worker thread, never the UI thread.
use anyhow::{Result, anyhow, bail};
use reqwest::{
    Method, StatusCode,
    blocking::{Client, Response},
};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::time::Duration;
use url::{Host, Url};

/// Canonical server identity shared by requests and Keychain accounts.
pub fn normalize_server(server: &str) -> Result<String> {
    let mut url = Url::parse(server.trim()).map_err(|_| anyhow!("Invalid server URL"))?;
    let loopback = match url.host() {
        Some(Host::Domain(name)) => name.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    };
    if url.host().is_none() || !(url.scheme() == "https" || (url.scheme() == "http" && loopback)) {
        bail!("Server must use HTTPS, except HTTP on loopback");
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("Server URL must not contain credentials, query, or fragment");
    }
    let path = url.path().trim_end_matches('/').to_owned();
    url.set_path(&path);
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

#[derive(Clone)]
pub struct ApiClient {
    client: Client,
    server: String,
    token: Option<String>,
}

impl ApiClient {
    pub fn new(server: &str, token: Option<String>) -> Result<Self> {
        let server = normalize_server(server)?;
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .user_agent("Velvet for macOS")
            .build()
            .map_err(|_| anyhow!("Could not initialize HTTP client"))?;
        Ok(Self {
            client,
            server,
            token,
        })
    }

    pub fn server(&self) -> &str {
        &self.server
    }

    fn url(&self, segments: &[&str]) -> Result<Url> {
        let mut url =
            Url::parse(&format!("{}/", self.server)).map_err(|_| anyhow!("Invalid server URL"))?;
        let mut path = url
            .path_segments_mut()
            .map_err(|_| anyhow!("Invalid server URL"))?;
        path.pop_if_empty();
        // Reject dot segments rather than allowing URL normalization to change routes.
        if segments
            .iter()
            .any(|part| part.is_empty() || *part == "." || *part == "..")
        {
            bail!("Invalid API path component");
        }
        path.extend(segments.iter().copied());
        drop(path);
        Ok(url)
    }

    fn request(
        &self,
        method: Method,
        segments: &[&str],
        query: &[(&str, &str)],
        body: Option<Value>,
        authenticated: bool,
    ) -> Result<Response> {
        let mut request = self
            .client
            .request(method, self.url(segments)?)
            .query(query);
        if authenticated {
            let token = self
                .token
                .as_ref()
                .ok_or_else(|| anyhow!("Sign in first"))?;
            request = request.bearer_auth(token);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        // Never expose transport errors, response bodies, or URLs: servers can echo credentials.
        request
            .send()
            .map_err(|_| anyhow!("Could not reach server. Check connection and server address"))
    }

    fn success(response: Response) -> Result<Response> {
        if !response.status().is_success() {
            bail!(
                "Server request failed (HTTP {})",
                response.status().as_u16()
            );
        }
        Ok(response)
    }

    fn decode<T: DeserializeOwned>(response: Response) -> Result<T> {
        Self::success(response)?
            .json()
            .map_err(|_| anyhow!("Server returned an invalid response"))
    }

    pub fn start_login(&self) -> Result<DeviceSession> {
        Self::decode(self.request(
            Method::POST,
            &["api", "v1", "cli", "sessions"],
            &[],
            Some(json!({"flow":"desktop","client_name":"Velvet for macOS"})),
            false,
        )?)
    }
    pub fn poll_login(&self, device_code: &str) -> Result<Option<Grant>> {
        let response = self.request(
            Method::POST,
            &["api", "v1", "cli", "sessions", "token"],
            &[],
            Some(json!({"device_code":device_code})),
            false,
        )?;
        if response.status() == StatusCode::ACCEPTED {
            return Ok(None);
        }
        let grant: Grant = Self::decode(response)?;
        if grant.kind != "desktop" || grant.token.is_empty() {
            bail!("Server did not issue a desktop credential");
        }
        Ok(Some(grant))
    }
    pub fn identity(&self) -> Result<Identity> {
        let identity: Identity =
            Self::decode(self.request(Method::GET, &["api", "v1", "me"], &[], None, true)?)?;
        if identity.token_kind != "desktop" {
            bail!("A desktop credential is required. Sign in again");
        }
        Ok(identity)
    }
    pub fn projects(&self, slug: &str) -> Result<Vec<Project>> {
        #[derive(Deserialize)]
        struct Envelope {
            #[serde(default, deserialize_with = "null_vec")]
            projects: Vec<Project>,
        }
        let result: Envelope = Self::decode(self.request(
            Method::GET,
            &["api", "v1", "w", slug, "projects"],
            &[],
            None,
            true,
        )?)?;
        Ok(result.projects)
    }
    pub fn issues_page(
        &self,
        slug: &str,
        project: Option<&str>,
        status: Option<&str>,
        cursor: Option<&str>,
    ) -> Result<IssuePage> {
        let mut query = Vec::new();
        if let Some(value) = project {
            query.push(("project", value));
        }
        if let Some(value) = status {
            query.push(("status", value));
        }
        if let Some(value) = cursor {
            query.push(("cursor", value));
        }
        Self::decode(self.request(
            Method::GET,
            &["api", "v1", "w", slug, "issues"],
            &query,
            None,
            true,
        )?)
    }
    pub fn issue(&self, slug: &str, key: &str) -> Result<Issue> {
        Self::decode(self.request(
            Method::GET,
            &["api", "v1", "w", slug, "issues", key],
            &[],
            None,
            true,
        )?)
    }
    pub fn comments(&self, slug: &str, key: &str) -> Result<Vec<Comment>> {
        #[derive(Deserialize)]
        struct Envelope {
            #[serde(default, deserialize_with = "null_vec")]
            comments: Vec<Comment>,
        }
        let result: Envelope = Self::decode(self.request(
            Method::GET,
            &["api", "v1", "w", slug, "issues", key, "comments"],
            &[],
            None,
            true,
        )?)?;
        Ok(result.comments)
    }
    pub fn add_comment(
        &self,
        slug: &str,
        key: &str,
        body: &str,
        kind: Option<&str>,
    ) -> Result<Comment> {
        Self::decode(self.request(
            Method::POST,
            &["api", "v1", "w", slug, "issues", key, "comments"],
            &[],
            Some(json!({"body":body,"kind":kind})),
            true,
        )?)
    }
    pub fn create_issue_in_project(
        &self,
        slug: &str,
        title: &str,
        description: &str,
        project: Option<&str>,
    ) -> Result<Issue> {
        let mut body = json!({"title":title,"description":description});
        if let Some(project) = project {
            body["project"] = json!(project);
        }
        Self::decode(self.request(
            Method::POST,
            &["api", "v1", "w", slug, "issues"],
            &[],
            Some(body),
            true,
        )?)
    }
    pub fn update_issue(
        &self,
        slug: &str,
        key: &str,
        title: &str,
        description: &str,
    ) -> Result<Issue> {
        Self::decode(self.request(
            Method::PATCH,
            &["api", "v1", "w", slug, "issues", key],
            &[],
            Some(json!({"title":title,"description":description})),
            true,
        )?)
    }
    pub fn update_status(&self, slug: &str, key: &str, status: &str) -> Result<Issue> {
        Self::decode(self.request(
            Method::PATCH,
            &["api", "v1", "w", slug, "issues", key],
            &[],
            Some(json!({"status":status})),
            true,
        )?)
    }
    pub fn revoke(&self) -> Result<()> {
        let response = self.request(
            Method::DELETE,
            &["api", "v1", "me", "token"],
            &[],
            None,
            true,
        )?;
        // A missing or previously revoked credential is already signed out remotely.
        if response.status() != StatusCode::UNAUTHORIZED {
            Self::success(response)?;
        }
        Ok(())
    }
}

fn null_vec<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> std::result::Result<Vec<T>, D::Error> {
    Ok(Option::<Vec<T>>::deserialize(deserializer)?.unwrap_or_default())
}

// Secret-bearing models deliberately do not implement Debug.
#[derive(Clone, Deserialize)]
pub struct DeviceSession {
    pub device_code: String,
    pub user_code: String,
    pub interval: u64,
}
#[derive(Clone, Deserialize)]
pub struct Grant {
    pub token: String,
    pub kind: String,
}
#[derive(Clone, Debug, Deserialize)]
pub struct Identity {
    pub token_kind: String,
    pub user: User,
    #[serde(default, deserialize_with = "null_vec")]
    pub memberships: Vec<Membership>,
}
#[derive(Clone, Debug, Default, Deserialize)]
pub struct User {
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub name: String,
}
impl User {
    /// Accounts may have no display name, so fall back to the email like the web app.
    pub fn label(&self) -> String {
        if self.name.trim().is_empty() {
            self.email.clone()
        } else {
            self.name.clone()
        }
    }
}
#[derive(Clone, Debug, Deserialize)]
pub struct Membership {
    pub workspace_slug: String,
    pub workspace_name: String,
    pub role: String,
}
#[derive(Clone, Debug, Deserialize)]
pub struct Project {
    pub id: String,
    pub key: String,
    pub name: String,
}
#[derive(Clone, Debug, Deserialize)]
pub struct IssuePage {
    #[serde(default, deserialize_with = "null_vec")]
    pub issues: Vec<Issue>,
    #[serde(default)]
    pub next_cursor: Option<String>,
}
#[derive(Clone, Debug, Default, Deserialize)]
pub struct Issue {
    pub id: String,
    pub key: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub status: String,
    #[serde(default)]
    pub priority: i32,
    pub project_id: Option<String>,
}
#[derive(Clone, Debug, Deserialize)]
pub struct Comment {
    pub author: User,
    pub body: String,
    pub source: String,
    pub kind: Option<String>,
    pub deleted_at: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::mpsc,
        thread,
    };

    fn server(
        status: &str,
        body: &str,
        headers: &str,
    ) -> (String, mpsc::Receiver<String>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}",
            body.len()
        );
        let (tx, rx) = mpsc::channel();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0; 4096];
            loop {
                let count = stream.read(&mut buffer).unwrap();
                if count == 0 {
                    break;
                }
                bytes.extend_from_slice(&buffer[..count]);
                if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&bytes[..end]);
                    let length: usize = head
                        .lines()
                        .find_map(|line| {
                            let (key, value) = line.split_once(':')?;
                            key.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse().unwrap())
                        })
                        .unwrap_or(0);
                    if bytes.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let _ = tx.send(String::from_utf8(bytes).unwrap());
            stream.write_all(response.as_bytes()).unwrap();
        });
        (address, rx, handle)
    }

    #[test]
    fn canonical_server_and_transport_policy() {
        for allowed in [
            "http://127.0.0.1:8080",
            "http://localhost",
            "http://[::1]",
            "https://example.com/base",
        ] {
            assert!(normalize_server(allowed).is_ok(), "{allowed}");
        }
        assert_eq!(
            normalize_server(" HTTPS://Example.COM:443/base/// ").unwrap(),
            "https://example.com/base"
        );
        for forbidden in [
            "http://example.com",
            "http://192.168.1.2",
            "ftp://localhost",
            "https://u:p@example.com",
            "https://example.com?",
            "https://example.com#",
            "not a url",
        ] {
            assert!(normalize_server(forbidden).is_err(), "{forbidden}");
        }
    }

    #[test]
    fn login_contract_never_sends_saved_bearer() {
        let body = r#"{"device_code":"device","user_code":"ABCD-EFGH","verification_uri":"https://example.com/cli/approve","verification_uri_complete":"https://example.com/cli/approve?code=ABCD-EFGH","expires_at":"2026-10-26T12:00:00Z","interval":2}"#;
        let (address, received, handle) = server("201 Created", body, "");
        let session = ApiClient::new(&address, Some("secret-bearer".into()))
            .unwrap()
            .start_login()
            .unwrap();
        assert_eq!(session.interval, 2);
        let request = received.recv().unwrap();
        assert!(request.starts_with("POST /api/v1/cli/sessions HTTP/1.1"));
        assert!(!request.to_lowercase().contains("authorization:"));
        let body: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(
            body,
            json!({"flow":"desktop","client_name":"Velvet for macOS"})
        );
        handle.join().unwrap();
    }

    #[test]
    fn pending_and_grant_contract() {
        let (address, received, handle) = server(
            "202 Accepted",
            r#"{"error":{"code":"authorization_pending"}}"#,
            "",
        );
        assert!(
            ApiClient::new(&address, None)
                .unwrap()
                .poll_login("device-secret")
                .unwrap()
                .is_none()
        );
        let request = received.recv().unwrap();
        assert!(request.starts_with("POST /api/v1/cli/sessions/token "));
        assert!(request.contains(r#"{"device_code":"device-secret"}"#));
        handle.join().unwrap();
        let (address, _, handle) = server(
            "200 OK",
            r#"{"token":"desktop-secret","kind":"desktop"}"#,
            "",
        );
        assert_eq!(
            ApiClient::new(&address, None)
                .unwrap()
                .poll_login("device")
                .unwrap()
                .unwrap()
                .token,
            "desktop-secret"
        );
        handle.join().unwrap();
    }

    #[test]
    fn issue_query_and_null_collection_contract() {
        let (address, received, handle) =
            server("200 OK", r#"{"issues":null,"next_cursor":"next"}"#, "");
        let result = ApiClient::new(&address, Some("secret".into()))
            .unwrap()
            .issues_page(
                "my org",
                Some("project&one"),
                Some("in_progress"),
                Some("a+b"),
            )
            .unwrap();
        assert!(result.issues.is_empty());
        assert_eq!(result.next_cursor.as_deref(), Some("next"));
        let request = received.recv().unwrap();
        assert!(request.starts_with(
            "GET /api/v1/w/my%20org/issues?project=project%26one&status=in_progress&cursor=a%2Bb "
        ));
        assert!(
            request
                .to_lowercase()
                .contains("authorization: bearer secret")
        );
        handle.join().unwrap();
    }

    #[test]
    fn redirects_are_not_followed_and_errors_hide_secrets() {
        let sink = TcpListener::bind("127.0.0.1:0").unwrap();
        sink.set_nonblocking(true).unwrap();
        let headers = format!("Location: http://{}/stolen\r\n", sink.local_addr().unwrap());
        let (address, _, handle) = server("302 Found", "secret-bearer", &headers);
        let error = ApiClient::new(&address, Some("secret-bearer".into()))
            .unwrap()
            .issues_page("org", None, None, None)
            .unwrap_err();
        assert!(error.to_string().contains("302"));
        assert!(!format!("{error:?}").contains("secret-bearer"));
        handle.join().unwrap();
        assert_eq!(
            sink.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[test]
    fn identity_rejects_non_desktop_keys() {
        let (address, _, handle) = server(
            "200 OK",
            r#"{"token_kind":"management","user":{"id":"u"},"memberships":null}"#,
            "",
        );
        let error = ApiClient::new(&address, Some("secret".into()))
            .unwrap()
            .identity()
            .unwrap_err();
        assert!(error.to_string().contains("desktop credential"));
        handle.join().unwrap();
    }

    #[test]
    fn projects_comments_and_revoke_contracts() {
        let (address, received, handle) = server("200 OK", r#"{"projects":null}"#, "");
        let client = ApiClient::new(&address, Some("secret".into())).unwrap();
        assert!(client.projects("org").unwrap().is_empty());
        assert!(
            received
                .recv()
                .unwrap()
                .starts_with("GET /api/v1/w/org/projects ")
        );
        handle.join().unwrap();

        let (address, received, handle) = server("200 OK", r#"{"comments":null}"#, "");
        assert!(
            ApiClient::new(&address, Some("secret".into()))
                .unwrap()
                .comments("org", "V-1")
                .unwrap()
                .is_empty()
        );
        assert!(
            received
                .recv()
                .unwrap()
                .starts_with("GET /api/v1/w/org/issues/V-1/comments ")
        );
        handle.join().unwrap();

        let comment = r#"{"id":"c","author":{"id":"u","email":"u@example.com"},"body":"Update","source":"human","kind":"note","created_at":"now"}"#;
        let (address, received, handle) = server("201 Created", comment, "");
        let comment = ApiClient::new(&address, Some("secret".into()))
            .unwrap()
            .add_comment("org", "V-1", "Update", Some("note"))
            .unwrap();
        assert_eq!(comment.author.email, "u@example.com");
        let request = received.recv().unwrap();
        assert!(request.starts_with("POST /api/v1/w/org/issues/V-1/comments "));
        assert_eq!(
            serde_json::from_str::<Value>(request.split_once("\r\n\r\n").unwrap().1).unwrap(),
            json!({"body":"Update","kind":"note"})
        );
        handle.join().unwrap();

        let (address, received, handle) = server("204 No Content", "", "");
        ApiClient::new(&address, Some("secret".into()))
            .unwrap()
            .revoke()
            .unwrap();
        assert!(
            received
                .recv()
                .unwrap()
                .starts_with("DELETE /api/v1/me/token ")
        );
        handle.join().unwrap();
    }

    #[test]
    fn error_body_and_decode_details_are_never_exposed() {
        for (status, body) in [
            ("500 Internal Server Error", "secret-bearer"),
            ("200 OK", "secret-bearer"),
        ] {
            let (address, _, handle) = server(status, body, "");
            let error = ApiClient::new(&address, Some("secret-bearer".into()))
                .unwrap()
                .issues_page("org", None, None, None)
                .unwrap_err();
            assert!(!format!("{error:?}").contains("secret-bearer"));
            handle.join().unwrap();
        }
    }

    #[test]
    fn edit_issue_and_project_creation_contracts() {
        let issue = r#"{"id":"i","key":"V-1","title":"A","status":"todo"}"#;
        let (address, received, handle) = server("200 OK", issue, "");
        ApiClient::new(&address, Some("secret".into()))
            .unwrap()
            .update_issue("org", "V-1", "A", "B")
            .unwrap();
        let request = received.recv().unwrap();
        assert!(request.starts_with("PATCH /api/v1/w/org/issues/V-1 HTTP/1.1"));
        assert_eq!(
            serde_json::from_str::<Value>(request.split_once("\r\n\r\n").unwrap().1).unwrap(),
            json!({"title":"A","description":"B"})
        );
        handle.join().unwrap();

        for project in [None, Some("velvet")] {
            let (address, received, handle) = server("201 Created", issue, "");
            ApiClient::new(&address, Some("secret".into()))
                .unwrap()
                .create_issue_in_project("org", "A", "B", project)
                .unwrap();
            let request = received.recv().unwrap();
            assert!(request.starts_with("POST /api/v1/w/org/issues HTTP/1.1"));
            let mut expected = json!({"title":"A","description":"B"});
            if let Some(project) = project {
                expected["project"] = json!(project);
            }
            assert_eq!(
                serde_json::from_str::<Value>(request.split_once("\r\n\r\n").unwrap().1).unwrap(),
                expected
            );
            handle.join().unwrap();
        }
    }

    #[test]
    fn revoke_accepts_401_but_preserves_other_failures() {
        for (status, success) in [
            ("401 Unauthorized", true),
            ("403 Forbidden", false),
            ("500 Internal Server Error", false),
        ] {
            let (address, received, handle) = server(status, "secret-bearer", "");
            let result = ApiClient::new(&address, Some("secret-bearer".into()))
                .unwrap()
                .revoke();
            assert_eq!(result.is_ok(), success);
            if let Err(error) = result {
                assert!(!format!("{error:?}").contains("secret-bearer"));
            }
            assert!(
                received
                    .recv()
                    .unwrap()
                    .starts_with("DELETE /api/v1/me/token HTTP/1.1")
            );
            handle.join().unwrap();
        }
    }

    #[test]
    fn mutation_request_contracts() {
        let issue = r#"{"id":"i","key":"V-1","title":"A","status":"todo"}"#;
        for (method, path, body) in [
            (
                "POST",
                "/api/v1/w/org/issues",
                json!({"title":"A","description":"B"}),
            ),
            (
                "PATCH",
                "/api/v1/w/org/issues/V-1",
                json!({"status":"done"}),
            ),
        ] {
            let (address, received, handle) = server("200 OK", issue, "");
            let client = ApiClient::new(&address, Some("secret".into())).unwrap();
            if method == "POST" {
                client
                    .create_issue_in_project("org", "A", "B", None)
                    .unwrap();
            } else {
                client.update_status("org", "V-1", "done").unwrap();
            }
            let request = received.recv().unwrap();
            assert!(request.starts_with(&format!("{method} {path} HTTP/1.1")));
            assert_eq!(
                serde_json::from_str::<Value>(request.split_once("\r\n\r\n").unwrap().1).unwrap(),
                body
            );
            handle.join().unwrap();
        }
    }
}
