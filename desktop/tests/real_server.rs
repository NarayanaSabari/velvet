//! Opt-in connected acceptance against the guarded disposable e2e stack.
//! First read e2e/README.md and run ./e2e/stack-up.sh. Do not run alongside Playwright.
//! Run: cargo test --manifest-path desktop/Cargo.toml --test real_server connected_desktop_flow -- --ignored
//! This test creates and deletes its own user/workspace, never touches Keychain, and never prints credentials.
// This flow exercises a subset of the shared client, so unused items are expected.
#[allow(dead_code)]
#[path = "../src/api.rs"]
mod api;
#[path = "../src/pages.rs"]
mod pages;
#[allow(dead_code)]
#[path = "../src/state.rs"]
mod state;

use anyhow::{Context, Result, bail};
use api::ApiClient;
use serde_json::json;
use std::{
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

const SERVER: &str = "http://localhost:18399";

fn sql(root: &Path, statement: &str) -> Result<()> {
    let output = Command::new("bash")
        .arg(root.join("e2e/stack-common.sh"))
        .args([
            "exec",
            "-T",
            "postgres",
            "psql",
            "-U",
            "worklog",
            "-d",
            "worklog",
            "-tA",
            "-v",
            "ON_ERROR_STOP=1",
            "-c",
            statement,
        ])
        .output()
        .context("Could not run guarded disposable database command")?;
    // SQL can include the temporary browser session, so never print command output.
    if !output.status.success() {
        bail!("Disposable fixture SQL failed");
    }
    Ok(())
}

struct Fixture {
    root: PathBuf,
    slug: String,
    email: String,
    session: String,
    cleaned: bool,
}

impl Fixture {
    fn new() -> Result<Self> {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_owned();
        let unique = format!(
            "{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
        );
        let mut random = [0u8; 32];
        File::open("/dev/urandom")?.read_exact(&mut random)?;
        let session: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let fixture = Self {
            root,
            slug: format!("rust-desktop-{unique}"),
            email: format!("rust.desktop.{unique}@example.test"),
            session,
            cleaned: false,
        };
        sql(
            &fixture.root,
            &format!(
                "BEGIN; INSERT INTO workspace(name,slug,issue_prefix) VALUES('Rust Desktop Acceptance','{slug}','RST'); \
             INSERT INTO app_user(email,name) VALUES('{email}','Rust Desktop Tester'); \
             INSERT INTO membership(workspace_id,user_id,role) SELECT w.id,u.id,'admin' FROM workspace w,app_user u WHERE w.slug='{slug}' AND u.email='{email}'; \
             INSERT INTO project(workspace_id,key,name,description,created_by) SELECT w.id,'native-smoke','Native Smoke','Disposable Rust acceptance',u.id FROM workspace w,app_user u WHERE w.slug='{slug}' AND u.email='{email}'; \
             INSERT INTO session(id,user_id,expires_at) SELECT encode(sha256(convert_to('{session}','UTF8')),'hex'),id,now()+interval '1 hour' FROM app_user WHERE email='{email}'; COMMIT;",
                slug = fixture.slug,
                email = fixture.email,
                session = fixture.session,
            ),
        )?;
        Ok(fixture)
    }

    fn cleanup(&mut self) -> Result<()> {
        sql(
            &self.root,
            &format!(
                "BEGIN; DELETE FROM workspace WHERE slug='{}'; DELETE FROM app_user WHERE email='{}'; COMMIT;",
                self.slug, self.email,
            ),
        )?;
        self.cleaned = true;
        Ok(())
    }

    fn approve_in_browser(&self, verification_url: &str) -> Result<()> {
        // Only the browser session and approval URL go over stdin. The desktop bearer stays in Rust.
        let script = r#"
const {chromium,expect} = require(process.argv[1] + '/e2e/node_modules/@playwright/test');
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', async () => {
  let browser;
  try {
    const data = JSON.parse(input);
    browser = await chromium.launch();
    const context = await browser.newContext();
    await context.addCookies([{name:'ticket_session',value:data.session,url:data.server}]);
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(data.url);
    await expect(page.getByRole('heading',{name:'Connect Velvet for macOS'})).toBeVisible();
    await page.getByRole('button',{name:'Approve desktop app',exact:true}).click();
    await expect(page.getByText('Connected.',{exact:true})).toBeVisible();
  } catch (_) {
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
});
"#;
        let mut child = Command::new("node")
            .arg("-e")
            .arg(script)
            .arg(&self.root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("Could not launch browser approval helper")?;
        child.stdin.take().unwrap().write_all(
            serde_json::to_string(&json!({
                "server": SERVER, "session": self.session, "url": verification_url,
            }))?
            .as_bytes(),
        )?;
        let output = child.wait_with_output()?;
        if !output.status.success() {
            bail!("Browser desktop approval failed");
        }
        Ok(())
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if !self.cleaned && self.cleanup().is_err() {
            eprintln!("Disposable native acceptance fixture cleanup failed");
        }
    }
}

#[test]
#[ignore = "requires sole access to guarded disposable e2e stack and Playwright Chromium"]
fn connected_desktop_flow() -> Result<()> {
    let mut fixture = Fixture::new()?;
    let anonymous = ApiClient::new(SERVER, None)?;
    let device = anonymous.start_login()?;
    assert!(anonymous.poll_login(&device.device_code)?.is_none());
    // Approve the same URL the app opens, built from the user code.
    fixture.approve_in_browser(&format!("{SERVER}/cli/approve?code={}", device.user_code))?;
    let grant = anonymous
        .poll_login(&device.device_code)?
        .context("Approved desktop grant was not ready")?;
    assert_eq!(grant.kind, "desktop");
    // Grant collection is one-shot.
    assert!(anonymous.poll_login(&device.device_code).is_err());
    let client = ApiClient::new(SERVER, Some(grant.token))?;
    let identity = client.identity()?;
    assert_eq!(identity.token_kind, "desktop");
    assert_eq!(identity.user.email, fixture.email);
    assert!(
        identity
            .memberships
            .iter()
            .any(|member| member.workspace_slug == fixture.slug)
    );
    let projects = client.projects(&fixture.slug)?;
    let project = projects
        .iter()
        .find(|project| project.key == "native-smoke")
        .context("Fixture project missing")?;
    let issue = client.create_issue_in_project(
        &fixture.slug,
        "Rust native ticket",
        "Created through native client",
        Some(&project.key),
    )?;
    assert_eq!(issue.project_id.as_deref(), Some(project.id.as_str()));
    let edited = client.update_issue(
        &fixture.slug,
        &issue.key,
        "Edited native ticket",
        "Edited through Rust",
    )?;
    assert_eq!(edited.title, "Edited native ticket");
    assert_eq!(edited.description, "Edited through Rust");
    let changed = client.update_status(&fixture.slug, &issue.key, "in_progress")?;
    assert_eq!(changed.status, "in_progress");
    let fetched = client.issue(&fixture.slug, &issue.key)?;
    assert_eq!(fetched.title, edited.title);
    assert_eq!(fetched.status, "in_progress");
    let page = client.issues_page(&fixture.slug, Some(&project.key), Some("in_progress"), None)?;
    assert!(page.issues.iter().any(|item| item.id == issue.id));
    let comment = client.add_comment(
        &fixture.slug,
        &issue.key,
        "Human update through native client",
        Some("note"),
    )?;
    assert_eq!(comment.source, "human");
    assert_eq!(comment.author.email, identity.user.email);
    let comments = client.comments(&fixture.slug, &issue.key)?;
    assert!(
        comments
            .iter()
            .any(|item| item.body == comment.body && item.source == "human")
    );
    // Every native page reads live endpoints with the desktop credential.
    for nav in [
        "", "projects", "reports", "feed", "mentions", "unlinked", "worklog",
    ] {
        let page = pages::Page::from_nav(nav).unwrap();
        let responses = page
            .requests()
            .iter()
            .map(|(segments, query)| {
                let segments: Vec<&str> = segments
                    .iter()
                    .map(|s| {
                        if *s == "{slug}" {
                            fixture.slug.as_str()
                        } else {
                            s
                        }
                    })
                    .collect();
                client.get_json(&segments, query)
            })
            .collect::<Result<Vec<_>>>()
            .with_context(|| format!("{} page", page.title()))?;
        let sections = page.build(&responses);
        assert!(!sections.is_empty(), "{}", page.title());
        if matches!(page, pages::Page::Feed | pages::Page::Dashboard) {
            let rows: Vec<_> = sections.iter().flat_map(|s| &s.rows).collect();
            assert!(
                rows.iter()
                    .any(|r| r.issue_key.as_deref() == Some(issue.key.as_str())),
                "{} shows the new issue",
                page.title()
            );
        }
    }
    client.revoke()?;
    let revoked = client.identity().unwrap_err();
    assert!(revoked.to_string().contains("401"));
    client.revoke()?;
    fixture.cleanup()?;
    Ok(())
}
