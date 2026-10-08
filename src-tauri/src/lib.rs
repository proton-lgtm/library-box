use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use futures_util::StreamExt;
use regex::Regex;
use reqwest::{header, Client};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncWriteExt;
use zip::ZipArchive;

#[derive(Clone)]
struct AppState {
    db: Arc<Mutex<Connection>>,
    transfers: Arc<Mutex<HashMap<i64, Arc<TransferControl>>>>,
    running: Arc<Mutex<HashMap<i64, Child>>>,
}

#[test]
fn reads_csrf_tokens_from_itch_meta_and_form_inputs() {
    assert_eq!(
        parse_csrf_token(r#"<meta name="csrf_token" content="meta-token">"#).unwrap(),
        Some("meta-token".into())
    );
    assert_eq!(
        parse_csrf_token(r#"<input name="csrf_token" value="form-token">"#).unwrap(),
        Some("form-token".into())
    );
    assert_eq!(parse_csrf_token("<html></html>").unwrap(), None);
}

struct TransferControl {
    paused: AtomicBool,
    cancelled: AtomicBool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Game {
    id: i64,
    slug: String,
    title: String,
    creator: String,
    description: String,
    cover_url: String,
    game_url: String,
    download_url: Option<String>,
    genre: String,
    published: String,
    browser_only: bool,
    browser_playable: bool,
    download_status: Option<String>,
    files: Vec<GameFile>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GameFile {
    upload_id: Option<i64>,
    file_name: String,
    size: Option<String>,
    platforms: Vec<String>,
    installable: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Download {
    game_id: i64,
    title: String,
    cover_url: String,
    status: String,
    bytes_downloaded: u64,
    total_bytes: Option<u64>,
    error: Option<String>,
    install_dir: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InstalledGame {
    game_id: i64,
    title: String,
    creator: String,
    cover_url: String,
    install_dir: String,
    running: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    game_id: i64,
    status: String,
    bytes_downloaded: u64,
    total_bytes: Option<u64>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct CatalogSeed {
    slug: String,
    title: String,
    creator: String,
    description: String,
    cover_url: String,
    game_url: String,
    download_url: Option<String>,
    genre: String,
    published: String,
    browser_only: bool,
}

#[derive(Clone)]
struct TransferRecord {
    game_id: i64,
    url: String,
    game_url: String,
    file_name: Option<String>,
    archive_path: PathBuf,
    install_dir: PathBuf,
    run_after: bool,
}

fn lock_error() -> String {
    "A local application lock was poisoned. Restart Redline Library and try again.".into()
}

fn open_db(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Cannot create app data directory: {error}"))?;
    }
    let connection =
        Connection::open(path).map_err(|error| format!("Cannot open library database: {error}"))?;
    initialize_db(&connection)?;
    Ok(connection)
}

fn initialize_db(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "
            PRAGMA foreign_keys = ON;
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS games (
                id INTEGER PRIMARY KEY,
                slug TEXT NOT NULL UNIQUE,
                title TEXT NOT NULL,
                creator TEXT NOT NULL,
                description TEXT NOT NULL,
                cover_url TEXT NOT NULL,
                game_url TEXT NOT NULL,
                download_url TEXT,
                genre TEXT NOT NULL,
                published TEXT NOT NULL,
                browser_only INTEGER NOT NULL DEFAULT 0,
                browser_playable INTEGER NOT NULL DEFAULT 0,
                files_json TEXT NOT NULL DEFAULT '[]'
            );
            CREATE TABLE IF NOT EXISTS downloads (
                game_id INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
                url TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('downloading','paused','cancelled','failed','installed')),
                bytes_downloaded INTEGER NOT NULL DEFAULT 0,
                total_bytes INTEGER,
                archive_path TEXT NOT NULL,
                install_dir TEXT NOT NULL,
                launch_path TEXT,
                run_after INTEGER NOT NULL DEFAULT 0,
                selected_file_name TEXT,
                error TEXT,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            ",
        )
        .map_err(|error| format!("Cannot initialize library database: {error}"))?;
    let columns = {
        let mut statement = connection
            .prepare("PRAGMA table_info(games)")
            .map_err(|error| format!("Cannot inspect database schema: {error}"))?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| format!("Cannot inspect database schema: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Cannot inspect database schema: {error}"))?;
        columns
    };
    if !columns.iter().any(|name| name == "browser_only") {
        connection
            .execute(
                "ALTER TABLE games ADD COLUMN browser_only INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|error| format!("Cannot upgrade library database: {error}"))?;
    }
    if !columns.iter().any(|name| name == "files_json") {
        connection
            .execute(
                "ALTER TABLE games ADD COLUMN files_json TEXT NOT NULL DEFAULT '[]'",
                [],
            )
            .map_err(|error| format!("Cannot upgrade library database: {error}"))?;
    }
    if !columns.iter().any(|name| name == "browser_playable") {
        connection
            .execute(
                "ALTER TABLE games ADD COLUMN browser_playable INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|error| format!("Cannot upgrade library database: {error}"))?;
    }
    connection
        .execute("UPDATE games SET browser_only=0 WHERE slug='remember'", [])
        .map_err(|error| {
            format!("Cannot update Remember's current itch.io availability: {error}")
        })?;
    let download_columns = {
        let mut statement = connection
            .prepare("PRAGMA table_info(downloads)")
            .map_err(|error| format!("Cannot inspect database schema: {error}"))?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| format!("Cannot inspect database schema: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Cannot inspect database schema: {error}"))?;
        columns
    };
    if !download_columns.iter().any(|name| name == "upload_id") {
        connection
            .execute("ALTER TABLE downloads ADD COLUMN upload_id INTEGER", [])
            .map_err(|error| format!("Cannot upgrade library database: {error}"))?;
    }
    if !download_columns
        .iter()
        .any(|name| name == "selected_file_name")
    {
        connection
            .execute(
                "ALTER TABLE downloads ADD COLUMN selected_file_name TEXT",
                [],
            )
            .map_err(|error| format!("Cannot upgrade library database: {error}"))?;
    }
    let seeds: Vec<CatalogSeed> = serde_json::from_str(include_str!("catalog.json"))
        .map_err(|error| format!("Bundled game catalog is invalid: {error}"))?;
    for seed in seeds {
        connection
            .execute(
                    "INSERT OR IGNORE INTO games (slug,title,creator,description,cover_url,game_url,download_url,genre,published,browser_only)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                params![
                    seed.slug,
                    seed.title,
                    seed.creator,
                    seed.description,
                    seed.cover_url,
                    seed.game_url,
                    seed.download_url,
                    seed.genre,
                    seed.published,
                    if seed.browser_only { 1_i64 } else { 0_i64 }
                ],
            )
            .map_err(|error| format!("Cannot seed game catalog: {error}"))?;
    }
    Ok(())
}

fn query_games(connection: &Connection) -> Result<Vec<Game>, String> {
    let mut statement = connection
        .prepare(
            "SELECT g.id,g.slug,g.title,g.creator,g.description,g.cover_url,g.game_url,g.download_url,g.genre,g.published,d.status,g.browser_only,g.browser_playable,g.files_json
             FROM games g LEFT JOIN downloads d ON d.game_id=g.id ORDER BY g.id",
        )
        .map_err(|error| format!("Cannot query games: {error}"))?;
    let result = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, Option<String>>(10)?,
                row.get::<_, i64>(11)? != 0,
                row.get::<_, i64>(12)? != 0,
                row.get::<_, String>(13)?,
            ))
        })
        .map_err(|error| format!("Cannot query games: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Cannot read game catalog: {error}"))?;
    result
        .into_iter()
        .map(
            |(
                id,
                slug,
                title,
                creator,
                description,
                cover_url,
                game_url,
                download_url,
                genre,
                published,
                download_status,
                browser_only,
                browser_playable,
                files_json,
            )| {
                let files = serde_json::from_str(&files_json)
                    .map_err(|error| format!("Cannot read scraped game files: {error}"))?;
                Ok(Game {
                    id,
                    slug,
                    title,
                    creator,
                    description,
                    cover_url,
                    game_url,
                    download_url,
                    genre,
                    published,
                    download_status,
                    browser_only,
                    browser_playable,
                    files,
                })
            },
        )
        .collect()
}

#[tauri::command]
fn list_games(state: State<'_, AppState>) -> Result<Vec<Game>, String> {
    let db = state.db.lock().map_err(|_| lock_error())?;
    query_games(&db)
}

fn parse_itch_game_files(html: &str) -> Result<Vec<GameFile>, String> {
    let upload_blocks =
        Regex::new(r#"(?is)<div\s+class=["'][^"']*\bupload\b[^"']*["'][^>]*>(.*?)</div>\s*</div>"#)
            .map_err(|error| format!("Cannot prepare itch.io file parser: {error}"))?;
    let upload_id_pattern = Regex::new(r#"data-upload_id=["'](\d+)["']"#)
        .map_err(|error| format!("Cannot prepare itch.io file parser: {error}"))?;
    let name_pattern = Regex::new(
        r#"(?is)<strong\b[^>]*\bclass=["'][^"']*\bname\b[^"']*["'][^>]*>(.*?)</strong>"#,
    )
    .map_err(|error| format!("Cannot prepare itch.io file parser: {error}"))?;
    let size_pattern =
        Regex::new(r#"(?is)class=["'][^"']*\bfile_size\b[^"']*["'][^>]*>\s*<span[^>]*>\s*([^<]+)"#)
            .map_err(|error| format!("Cannot prepare itch.io file parser: {error}"))?;
    let platform_pattern = Regex::new(r#"(?is)title=["']Download for ([^"']+)["']"#)
        .map_err(|error| format!("Cannot prepare itch.io file parser: {error}"))?;
    let mut files = Vec::new();
    for upload in upload_blocks.captures_iter(html) {
        let block = upload
            .get(1)
            .map(|capture| capture.as_str())
            .unwrap_or_default();
        let upload_id = upload_id_pattern
            .captures(block)
            .and_then(|capture| capture.get(1))
            .and_then(|capture| capture.as_str().parse::<i64>().ok());
        let Some(file_name) = name_pattern
            .captures(block)
            .and_then(|capture| capture.get(1))
            .map(|capture| decode_html_text(capture.as_str()).trim().to_string())
            .filter(|name| !name.is_empty())
        else {
            continue;
        };
        let size = size_pattern
            .captures(block)
            .and_then(|capture| capture.get(1))
            .map(|capture| decode_html_text(capture.as_str()).trim().to_string())
            .filter(|value| !value.is_empty());
        let platforms: Vec<String> = platform_pattern
            .captures_iter(block)
            .filter_map(|capture| capture.get(1))
            .map(|capture| decode_html_text(capture.as_str()).trim().to_string())
            .collect();
        files.push(GameFile {
            upload_id,
            installable: is_installable_file(&file_name, &platforms),
            file_name,
            size,
            platforms,
        });
    }
    Ok(files)
}

fn is_installable_file(file_name: &str, platforms: &[String]) -> bool {
    if !file_name.to_ascii_lowercase().ends_with(".zip") {
        return false;
    }
    let platforms = platforms.join(" ").to_ascii_lowercase();
    #[cfg(target_os = "windows")]
    let supported =
        platforms.is_empty() || platforms.contains("windows") || platforms.contains("pc");
    #[cfg(target_os = "macos")]
    let supported = platforms.is_empty() || platforms.contains("mac") || platforms.contains("os x");
    #[cfg(target_os = "linux")]
    let supported = platforms.is_empty() || platforms.contains("linux");
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    let supported = false;
    supported
}

fn decode_html_text(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

#[tauri::command]
async fn refresh_game_files(
    game_id: i64,
    state: State<'_, AppState>,
) -> Result<Vec<GameFile>, String> {
    let (game_url, browser_only) = {
        let db = state.db.lock().map_err(|_| lock_error())?;
        db.query_row(
            "SELECT game_url,browser_only FROM games WHERE id=?1",
            [game_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? != 0)),
        )
        .optional()
        .map_err(|error| format!("Cannot load game details: {error}"))?
        .ok_or_else(|| "That game is no longer in the catalog.".to_string())?
    };
    if browser_only {
        return Ok(Vec::new());
    }
    let page_url = url::Url::parse(&game_url)
        .map_err(|error| format!("Invalid itch.io game page URL: {error}"))?;
    validate_itch_page_url(&page_url)?;
    let client = Client::builder()
        .user_agent(concat!("RedlineLibrary/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(45))
        .build()
        .map_err(|error| format!("Cannot initialize itch.io metadata client: {error}"))?;
    let response = client
        .get(page_url)
        .send()
        .await
        .map_err(|error| format!("Cannot read the itch.io game page: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "itch.io returned HTTP {} for this game page.",
            response.status()
        ));
    }
    let html = response
        .text()
        .await
        .map_err(|error| format!("Cannot read itch.io game metadata: {error}"))?;
    let files = parse_itch_game_files(&html)?;
    let files_json = serde_json::to_string(&files)
        .map_err(|error| format!("Cannot save itch.io file metadata: {error}"))?;
    let browser_playable = page_is_browser_playable(&html)?;
    state
        .db
        .lock()
        .map_err(|_| lock_error())?
        .execute(
            "UPDATE games SET files_json=?2,browser_playable=?3 WHERE id=?1",
            params![
                game_id,
                files_json,
                if browser_playable { 1_i64 } else { 0_i64 }
            ],
        )
        .map_err(|error| format!("Cannot save itch.io file metadata: {error}"))?;
    Ok(files)
}

fn page_is_browser_playable(html: &str) -> Result<bool, String> {
    let pattern = Regex::new(r#""type_name"\s*:\s*"html""#)
        .map_err(|error| format!("Cannot prepare itch.io game type parser: {error}"))?;
    Ok(pattern.is_match(html))
}

fn validate_itch_page_url(page_url: &url::Url) -> Result<(), String> {
    let host = page_url.host_str().unwrap_or_default().to_ascii_lowercase();
    if page_url.scheme() != "https" || !(host == "itch.io" || host.ends_with(".itch.io")) {
        return Err("Game pages must be HTTPS itch.io URLs.".into());
    }
    Ok(())
}

async fn resolve_itch_download(game_url: &str, file_name: &str) -> Result<String, String> {
    let page_url = url::Url::parse(game_url)
        .map_err(|error| format!("Invalid itch.io game page URL: {error}"))?;
    validate_itch_page_url(&page_url)?;
    let client = Client::builder()
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
        )
        .cookie_store(true)
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(45))
        .build()
        .map_err(|error| format!("Cannot initialize itch.io download client: {error}"))?;
    let game_page = client
        .get(page_url.clone())
        .send()
        .await
        .map_err(|error| format!("Cannot prepare the itch.io download: {error}"))?;
    if !game_page.status().is_success() {
        return Err(format!(
            "itch.io returned HTTP {} before download authorization.",
            game_page.status()
        ));
    }
    let html = game_page
        .text()
        .await
        .map_err(|error| format!("Cannot read itch.io game page: {error}"))?;
    let csrf = parse_csrf_token(&html)?.ok_or_else(|| {
        "itch.io did not provide a download authorization token; open the game page in your browser."
            .to_string()
    })?;
    let listed_file = parse_itch_game_files(&html)?
        .into_iter()
        .find(|file| file.file_name == file_name && file.installable)
        .ok_or_else(|| {
            "The selected file is no longer listed as an installable file on itch.io.".to_string()
        })?;
    let upload_id = listed_file.upload_id;
    let minimum_price = Regex::new(r#""min_price"\s*:\s*(\d+)"#)
        .map_err(|error| format!("Cannot prepare itch.io price check: {error}"))?
        .captures(&html)
        .and_then(|capture| capture.get(1))
        .and_then(|capture| capture.as_str().parse::<u64>().ok())
        .unwrap_or(0);
    if minimum_price > 0 {
        return Err(
            "This game requires purchase on itch.io. Open its page to complete the purchase."
                .into(),
        );
    }

    let mut download_url_endpoint = page_url.clone();
    download_url_endpoint.set_path(&format!(
        "{}/download_url",
        page_url.path().trim_end_matches('/')
    ));
    let mut form_data = vec![("csrf_token", csrf.clone())];
    if let Some(upload_id) = upload_id {
        form_data.push(("upload_id", upload_id.to_string()));
    }
    let request = client
        .post(download_url_endpoint)
        .header(header::REFERER, game_url)
        .header(header::ORIGIN, page_url.origin().ascii_serialization())
        .header("X-Requested-With", "XMLHttpRequest")
        .header(header::ACCEPT, "application/json")
        .form(&form_data);
    let authorization = request
        .send()
        .await
        .map_err(|error| format!("itch.io could not prepare this download: {error}"))?;
    if !authorization.status().is_success() {
        return Err(format!("itch.io refused to prepare this file (HTTP {}). Open the game page to complete any required access or purchase.", authorization.status()));
    }
    let result: serde_json::Value = authorization
        .json()
        .await
        .map_err(|error| format!("itch.io returned an invalid download page response: {error}"))?;
    if let Some(errors) = result.get("errors").and_then(serde_json::Value::as_array) {
        let details = errors
            .iter()
            .filter_map(serde_json::Value::as_str)
            .collect::<Vec<_>>()
            .join(" ");
        return Err(if details.is_empty() {
            "itch.io did not authorize this file. It may require an account, purchase, or browser interaction.".into()
        } else {
            format!("itch.io did not authorize this file: {details}")
        });
    }
    let download_page_value = result
        .get("url")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "itch.io did not provide a download page. The file may require browser interaction, an account, or purchase.".to_string())?;
    if validate_itch_signed_download_url(download_page_value).is_ok() {
        return Ok(download_page_value.to_string());
    }
    let download_page_url = url::Url::parse(download_page_value)
        .map_err(|error| format!("itch.io returned an invalid download page URL: {error}"))?;
    validate_itch_page_url(&download_page_url)?;
    let download_page = client
        .get(download_page_url.clone())
        .header(header::REFERER, game_url)
        .send()
        .await
        .map_err(|error| format!("Cannot open the itch.io download page: {error}"))?;
    if !download_page.status().is_success() {
        return Err(format!("itch.io returned HTTP {} for the download page. Open the game page to complete any required access.", download_page.status()));
    }
    let download_html = download_page
        .text()
        .await
        .map_err(|error| format!("Cannot read the itch.io download page: {error}"))?;
    let download_upload = parse_itch_game_files(&download_html)?
        .into_iter()
        .find(|file| file.file_name == file_name)
        .ok_or_else(|| {
            "itch.io did not list the selected file on its download page. Open the game page to complete any required access.".to_string()
        })?;
    let upload_id = download_upload
        .upload_id
        .ok_or_else(|| "itch.io did not expose an authorized upload for this file.".to_string())?;
    let download_csrf = parse_csrf_token(&download_html)?.unwrap_or(csrf);
    let mut file_endpoint = page_url.clone();
    file_endpoint.set_path(&format!(
        "{}/file/{upload_id}",
        page_url.path().trim_end_matches('/')
    ));
    file_endpoint.set_query(Some("source=view_game&as_props=1"));
    let file_response = client
        .post(file_endpoint)
        .header(header::REFERER, download_page_url.as_str())
        .header(
            header::ORIGIN,
            download_page_url.origin().ascii_serialization(),
        )
        .header("X-Requested-With", "XMLHttpRequest")
        .header(header::ACCEPT, "application/json")
        .form(&[("csrf_token", download_csrf)])
        .send()
        .await
        .map_err(|error| format!("itch.io could not authorize the selected file: {error}"))?;
    if !file_response.status().is_success() {
        return Err(format!("itch.io refused to authorize this file (HTTP {}). Open the game page to complete any required access or purchase.", file_response.status()));
    }
    let result: serde_json::Value = file_response
        .json()
        .await
        .map_err(|error| format!("itch.io returned an invalid file authorization: {error}"))?;
    if let Some(errors) = result.get("errors").and_then(serde_json::Value::as_array) {
        let details = errors
            .iter()
            .filter_map(serde_json::Value::as_str)
            .collect::<Vec<_>>()
            .join(" ");
        return Err(if details.is_empty() {
            "itch.io did not authorize this file. It may require an account, purchase, or browser interaction.".into()
        } else {
            format!("itch.io did not authorize this file: {details}")
        });
    }
    let signed_url = result
        .get("url")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "itch.io did not provide an archive URL. The file may require browser interaction, an account, or purchase.".to_string())?;
    validate_itch_signed_download_url(signed_url)?;
    Ok(signed_url.to_string())
}

fn parse_csrf_token(html: &str) -> Result<Option<String>, String> {
    let csrf_pattern = Regex::new(
        r#"(?is)<meta\b[^>]*name=["']csrf_token["'][^>]*(?:content|value)=["']([^"']+)["']|<input\b[^>]*name=["']csrf_token["'][^>]*value=["']([^"']+)["']"#,
    )
    .map_err(|error| format!("Cannot prepare itch.io authorization parser: {error}"))?;
    Ok(csrf_pattern.captures(html).and_then(|capture| {
        capture
            .get(1)
            .or_else(|| capture.get(2))
            .map(|token| token.as_str().to_string())
    }))
}

fn validate_itch_signed_download_url(raw: &str) -> Result<(), String> {
    let signed_url = url::Url::parse(raw)
        .map_err(|error| format!("Invalid itch.io signed download URL: {error}"))?;
    let host = signed_url
        .host_str()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if signed_url.scheme() != "https"
        || !host.starts_with("itchio-mirror.")
        || !host.ends_with(".r2.cloudflarestorage.com")
        || !signed_url.path().starts_with("/upload2/game/")
    {
        return Err("itch.io returned an unexpected download host or path.".into());
    }
    Ok(())
}

#[tauri::command]
fn list_downloads(state: State<'_, AppState>) -> Result<Vec<Download>, String> {
    let db = state.db.lock().map_err(|_| lock_error())?;
    let mut statement = db
        .prepare(
            "SELECT d.game_id,g.title,g.cover_url,d.status,d.bytes_downloaded,d.total_bytes,d.error,d.install_dir
             FROM downloads d JOIN games g ON g.id=d.game_id
             WHERE d.status != 'cancelled' ORDER BY d.updated_at DESC",
        )
        .map_err(|error| format!("Cannot query downloads: {error}"))?;
    let downloads = statement
        .query_map([], |row| {
            Ok(Download {
                game_id: row.get(0)?,
                title: row.get(1)?,
                cover_url: row.get(2)?,
                status: row.get(3)?,
                bytes_downloaded: row.get::<_, i64>(4)?.max(0) as u64,
                total_bytes: row
                    .get::<_, Option<i64>>(5)?
                    .map(|value| value.max(0) as u64),
                error: row.get(6)?,
                install_dir: row.get(7)?,
            })
        })
        .map_err(|error| format!("Cannot query downloads: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Cannot read download list: {error}"))?;
    Ok(downloads)
}

#[tauri::command]
fn list_library(state: State<'_, AppState>) -> Result<Vec<InstalledGame>, String> {
    let mut running = state.running.lock().map_err(|_| lock_error())?;
    let mut running_ids = Vec::new();
    for (game_id, child) in running.iter_mut() {
        if child
            .try_wait()
            .map_err(|error| format!("Cannot check game process: {error}"))?
            .is_some()
        {
            running_ids.push(*game_id);
        }
    }
    drop(running);
    if !running_ids.is_empty() {
        let mut running = state.running.lock().map_err(|_| lock_error())?;
        for game_id in running_ids {
            running.remove(&game_id);
        }
    }
    let running = state.running.lock().map_err(|_| lock_error())?;
    let db = state.db.lock().map_err(|_| lock_error())?;
    let mut statement = db
        .prepare(
            "SELECT g.id,g.title,g.creator,g.cover_url,d.install_dir
             FROM downloads d JOIN games g ON g.id=d.game_id
             WHERE d.status='installed' ORDER BY g.title COLLATE NOCASE",
        )
        .map_err(|error| format!("Cannot query installed games: {error}"))?;
    let games = statement
        .query_map([], |row| {
            let game_id: i64 = row.get(0)?;
            Ok(InstalledGame {
                game_id,
                title: row.get(1)?,
                creator: row.get(2)?,
                cover_url: row.get(3)?,
                install_dir: row.get(4)?,
                running: running.contains_key(&game_id),
            })
        })
        .map_err(|error| format!("Cannot query installed games: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Cannot read installed games: {error}"))?;
    Ok(games)
}

fn get_transfer_record(db: &Connection, game_id: i64) -> Result<TransferRecord, String> {
    db.query_row(
        "SELECT d.game_id,d.url,d.archive_path,d.install_dir,d.run_after,g.game_url,d.selected_file_name
         FROM downloads d JOIN games g ON g.id=d.game_id WHERE d.game_id=?1",
        [game_id],
        |row| {
            Ok(TransferRecord {
                game_id: row.get(0)?,
                url: row.get(1)?,
                archive_path: PathBuf::from(row.get::<_, String>(2)?),
                install_dir: PathBuf::from(row.get::<_, String>(3)?),
                run_after: row.get::<_, i64>(4)? != 0,
                game_url: row.get(5)?,
                file_name: row.get(6)?,
            })
        },
    )
    .optional()
    .map_err(|error| format!("Cannot read download record: {error}"))?
    .ok_or_else(|| "No download record exists for this game.".to_string())
}

fn make_control() -> Arc<TransferControl> {
    Arc::new(TransferControl {
        paused: AtomicBool::new(false),
        cancelled: AtomicBool::new(false),
    })
}

fn validate_download_url(raw: &str) -> Result<(), String> {
    let url = url::Url::parse(raw).map_err(|error| format!("Invalid download URL: {error}"))?;
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if url.scheme() != "https"
        || !(host == "itch.io"
            || host.ends_with(".itch.io")
            || host == "itch.zone"
            || host.ends_with(".itch.zone"))
    {
        return Err("Downloads are only allowed from HTTPS itch.io and itch.zone URLs.".into());
    }
    Ok(())
}

fn validate_download_response_url(
    raw: &str,
    selected_file_name: Option<&str>,
) -> Result<(), String> {
    if selected_file_name.is_some() {
        validate_itch_signed_download_url(raw)
    } else {
        validate_download_url(raw)
    }
}

fn is_safe_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

#[tauri::command]
async fn start_download(
    game_id: i64,
    destination: String,
    run_after: bool,
    upload_id: Option<i64>,
    file_name: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let destination = PathBuf::from(destination);
    if !destination.is_absolute() || !destination.is_dir() {
        return Err("Choose an existing destination folder.".into());
    }
    let destination = fs::canonicalize(&destination)
        .map_err(|error| format!("Cannot resolve destination folder: {error}"))?;
    let app_state = state.inner().clone();
    let (url, slug, game_url, browser_only, files_json) = {
        let db = app_state.db.lock().map_err(|_| lock_error())?;
        let (url, slug, game_url, browser_only, files_json): (
            Option<String>,
            String,
            String,
            bool,
            String,
        ) = db
            .query_row(
                "SELECT download_url,slug,game_url,browser_only,files_json FROM games WHERE id=?1",
                [game_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get::<_, i64>(3)? != 0,
                        row.get(4)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("Cannot load game details: {error}"))?
            .ok_or_else(|| "That game is no longer in the catalog.".to_string())?;
        (url, slug, game_url, browser_only, files_json)
    };
    if browser_only {
        return Err("This title is browser-only and cannot be installed as a desktop game.".into());
    }
    let file_name = file_name
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty());
    if upload_id.is_some() || file_name.is_some() {
        validate_itch_page_url(
            &url::Url::parse(&game_url)
                .map_err(|error| format!("Invalid itch.io game page URL: {error}"))?,
        )?;
        let files: Vec<GameFile> = serde_json::from_str(&files_json)
            .map_err(|error| format!("Cannot read available itch.io files: {error}"))?;
        let selected = files
            .iter()
            .find(|file| file.installable && file_name.as_deref() == Some(file.file_name.as_str()));
        if selected.is_none()
            || upload_id.is_some_and(|id| id <= 0)
            || upload_id.is_some_and(|id| selected.and_then(|file| file.upload_id) != Some(id))
        {
            return Err("Choose a file that was listed on this game's itch.io page.".into());
        }
        if file_name.is_none() {
            return Err("Choose an installable file from this game's itch.io page.".into());
        }
    } else {
        let direct_url = url.as_deref().ok_or_else(|| {
            "No verified public download is available for this game yet.".to_string()
        })?;
        validate_download_url(direct_url)?;
    }
    if !is_safe_slug(&slug) {
        return Err("This game's install folder name is invalid.".into());
    }
    let mut transfers = app_state.transfers.lock().map_err(|_| lock_error())?;
    if transfers.contains_key(&game_id) {
        return Err("A download for this game is already active.".into());
    }
    let install_dir = destination.join(&slug);
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Cannot locate download cache: {error}"))?
        .join("downloads");
    fs::create_dir_all(&cache_dir)
        .map_err(|error| format!("Cannot create download cache: {error}"))?;
    let archive_path = cache_dir.join(format!("{game_id}.zip.part"));
    if install_dir.exists() {
        return Err(format!(
            "The install folder already exists: {}",
            install_dir.display()
        ));
    }
    {
        let db = app_state.db.lock().map_err(|_| lock_error())?;
        db.execute(
            "INSERT INTO downloads (game_id,url,upload_id,selected_file_name,status,bytes_downloaded,total_bytes,archive_path,install_dir,launch_path,run_after,error,updated_at)
             VALUES (?1,?2,?3,?4,'downloading',0,NULL,?5,?6,NULL,?7,NULL,CURRENT_TIMESTAMP)
             ON CONFLICT(game_id) DO UPDATE SET url=excluded.url,upload_id=excluded.upload_id,selected_file_name=excluded.selected_file_name,status='downloading',bytes_downloaded=0,total_bytes=NULL,
                 archive_path=excluded.archive_path,install_dir=excluded.install_dir,launch_path=NULL,run_after=excluded.run_after,error=NULL,updated_at=CURRENT_TIMESTAMP",
            params![
                game_id,
                url.unwrap_or_default(),
                upload_id,
                file_name,
                archive_path.to_string_lossy(),
                install_dir.to_string_lossy(),
                if run_after { 1_i64 } else { 0_i64 }
            ],
        )
        .map_err(|error| format!("Cannot start download record: {error}"))?;
    }
    let record = {
        let db = app_state.db.lock().map_err(|_| lock_error())?;
        get_transfer_record(&db, game_id)?
    };
    transfers.insert(game_id, make_control());
    drop(transfers);
    spawn_transfer(app_state, app, record);
    Ok(())
}

#[tauri::command]
fn pause_download(game_id: i64, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    let control = state
        .transfers
        .lock()
        .map_err(|_| lock_error())?
        .get(&game_id)
        .cloned()
        .ok_or_else(|| "This download is not active.".to_string())?;
    control.paused.store(true, Ordering::SeqCst);
    state
        .db
        .lock()
        .map_err(|_| lock_error())?
        .execute(
            "UPDATE downloads SET status='paused',updated_at=CURRENT_TIMESTAMP WHERE game_id=?1 AND status='downloading'",
            [game_id],
        )
        .map_err(|error| format!("Cannot pause download: {error}"))?;
    emit_download(&app, game_id, "paused", None, None, None);
    Ok(())
}

#[tauri::command]
fn resume_download(game_id: i64, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    let app_state = state.inner().clone();
    let existing = app_state
        .transfers
        .lock()
        .map_err(|_| lock_error())?
        .get(&game_id)
        .cloned();
    if let Some(control) = existing {
        control.paused.store(false, Ordering::SeqCst);
        app_state
            .db
            .lock()
            .map_err(|_| lock_error())?
            .execute(
                "UPDATE downloads SET status='downloading',updated_at=CURRENT_TIMESTAMP WHERE game_id=?1 AND status='paused'",
                [game_id],
            )
            .map_err(|error| format!("Cannot resume download: {error}"))?;
        emit_download(&app, game_id, "downloading", None, None, None);
    } else {
        let record = {
            let db = app_state.db.lock().map_err(|_| lock_error())?;
            let record = get_transfer_record(&db, game_id)?;
            db.execute(
                "UPDATE downloads SET status='downloading',updated_at=CURRENT_TIMESTAMP WHERE game_id=?1 AND status='paused'",
                [game_id],
            )
            .map_err(|error| format!("Cannot resume download: {error}"))?;
            record
        };
        if record.archive_path.exists() && !record.archive_path.to_string_lossy().ends_with(".part")
        {
            return Err(
                "A completed archive is awaiting installation; restart the download to try again."
                    .into(),
            );
        }
        app_state
            .transfers
            .lock()
            .map_err(|_| lock_error())?
            .insert(game_id, make_control());
        spawn_transfer(app_state, app.clone(), record);
    }
    Ok(())
}

#[tauri::command]
fn cancel_download(game_id: i64, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    if let Some(control) = state
        .transfers
        .lock()
        .map_err(|_| lock_error())?
        .get(&game_id)
        .cloned()
    {
        control.cancelled.store(true, Ordering::SeqCst);
    } else {
        let record = {
            let db = state.db.lock().map_err(|_| lock_error())?;
            get_transfer_record(&db, game_id).ok()
        };
        if let Some(record) = record {
            let _ = fs::remove_file(&record.archive_path);
            let _ = fs::remove_file(record.archive_path.with_extension("zip"));
        }
    }
    state
        .db
        .lock()
        .map_err(|_| lock_error())?
        .execute(
            "UPDATE downloads SET status='cancelled',error=NULL,updated_at=CURRENT_TIMESTAMP WHERE game_id=?1 AND status!='installed'",
            [game_id],
        )
        .map_err(|error| format!("Cannot cancel download: {error}"))?;
    emit_download(&app, game_id, "cancelled", None, None, None);
    Ok(())
}

fn spawn_transfer(state: AppState, app: AppHandle, record: TransferRecord) {
    tauri::async_runtime::spawn(async move {
        let control = state
            .transfers
            .lock()
            .ok()
            .and_then(|controls| controls.get(&record.game_id).cloned())
            .unwrap_or_else(make_control);
        if let Err(error) = download_and_install(&state, &app, &record, &control).await {
            if !control.cancelled.load(Ordering::SeqCst) {
                if let Ok(db) = state.db.lock() {
                    let _ = db.execute(
                        "UPDATE downloads SET status='failed',error=?2,updated_at=CURRENT_TIMESTAMP WHERE game_id=?1",
                        params![record.game_id,error],
                    );
                }
                emit_download(&app, record.game_id, "failed", None, None, Some(error));
            }
        }
        if let Ok(mut controls) = state.transfers.lock() {
            controls.remove(&record.game_id);
        }
    });
}

async fn download_and_install(
    state: &AppState,
    app: &AppHandle,
    record: &TransferRecord,
    control: &TransferControl,
) -> Result<(), String> {
    let download_url = if let Some(file_name) = record.file_name.as_deref() {
        resolve_itch_download(&record.game_url, file_name).await?
    } else {
        validate_download_url(&record.url)?;
        record.url.clone()
    };
    let client = Client::builder()
        .user_agent(concat!("RedlineLibrary/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(90))
        .build()
        .map_err(|error| format!("Cannot initialize secure download client: {error}"))?;
    let mut existing = tokio::fs::metadata(&record.archive_path)
        .await
        .map(|meta| meta.len())
        .unwrap_or(0);
    let mut request = client.get(&download_url);
    if existing > 0 {
        request = request.header(header::RANGE, format!("bytes={existing}-"));
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("Download failed: {error}"))?;
    validate_download_response_url(response.url().as_str(), record.file_name.as_deref())?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Download server returned HTTP {status}."));
    }
    if existing > 0 && status != reqwest::StatusCode::PARTIAL_CONTENT {
        existing = 0;
    }
    let total_bytes = response
        .content_length()
        .and_then(|length| length.checked_add(existing));
    let open_mode = if existing == 0 {
        tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&record.archive_path)
            .await
    } else {
        tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&record.archive_path)
            .await
    };
    let mut file = open_mode.map_err(|error| format!("Cannot create download file: {error}"))?;
    let mut downloaded = existing;
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if control.cancelled.load(Ordering::SeqCst) {
            drop(file);
            let _ = tokio::fs::remove_file(&record.archive_path).await;
            emit_download(app, record.game_id, "cancelled", None, None, None);
            return Ok(());
        }
        while control.paused.load(Ordering::SeqCst) && !control.cancelled.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        if control.cancelled.load(Ordering::SeqCst) {
            drop(file);
            let _ = tokio::fs::remove_file(&record.archive_path).await;
            emit_download(app, record.game_id, "cancelled", None, None, None);
            return Ok(());
        }
        let chunk = chunk.map_err(|error| format!("Connection interrupted: {error}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|error| format!("Cannot save download: {error}"))?;
        downloaded += chunk.len() as u64;
        if last_emit.elapsed() >= Duration::from_millis(400) {
            if let Ok(db) = state.db.lock() {
                let _ = db.execute(
                    "UPDATE downloads SET bytes_downloaded=?2,total_bytes=?3,updated_at=CURRENT_TIMESTAMP WHERE game_id=?1",
                    params![record.game_id, downloaded as i64, total_bytes.map(|value| value as i64)],
                );
            }
            emit_download(
                app,
                record.game_id,
                "downloading",
                Some(downloaded),
                total_bytes,
                None,
            );
            last_emit = Instant::now();
        }
    }
    file.flush()
        .await
        .map_err(|error| format!("Cannot finish writing download: {error}"))?;
    drop(file);
    if control.cancelled.load(Ordering::SeqCst) {
        let _ = tokio::fs::remove_file(&record.archive_path).await;
        emit_download(app, record.game_id, "cancelled", None, None, None);
        return Ok(());
    }
    let archive_path = record.archive_path.clone();
    let final_path = record.archive_path.with_extension("zip");
    let final_path_for_install = final_path.clone();
    let install_dir = record.install_dir.clone();
    let launch_path = tokio::task::spawn_blocking(move || {
        fs::rename(&archive_path, &final_path_for_install)
            .map_err(|error| format!("Cannot finalize downloaded archive: {error}"))?;
        extract_archive(&final_path_for_install, &install_dir)
    })
    .await
    .map_err(|error| format!("Installer task failed: {error}"))??;
    if control.cancelled.load(Ordering::SeqCst) {
        let _ = fs::remove_dir_all(&record.install_dir);
        let _ = fs::remove_file(&final_path);
        emit_download(app, record.game_id, "cancelled", None, None, None);
        return Ok(());
    }
    let db = state.db.lock().map_err(|_| lock_error())?;
    db.execute(
        "UPDATE downloads SET status='installed',bytes_downloaded=?2,total_bytes=?2,archive_path=?3,launch_path=?4,error=NULL,updated_at=CURRENT_TIMESTAMP WHERE game_id=?1",
        params![
            record.game_id,
            downloaded as i64,
            final_path.to_string_lossy(),
            launch_path.to_string_lossy()
        ],
    )
    .map_err(|error| format!("Cannot save installed game: {error}"))?;
    drop(db);
    emit_download(
        app,
        record.game_id,
        "installed",
        Some(downloaded),
        Some(downloaded),
        None,
    );
    if record.run_after {
        if let Err(error) = launch_game_inner(state, record.game_id) {
            if let Ok(db) = state.db.lock() {
                let _ = db.execute(
                    "UPDATE downloads SET error=?2,updated_at=CURRENT_TIMESTAMP WHERE game_id=?1",
                    params![record.game_id, error],
                );
            }
            emit_download(
                app,
                record.game_id,
                "installed",
                Some(downloaded),
                Some(downloaded),
                Some(error),
            );
        }
    }
    Ok(())
}

fn emit_download(
    app: &AppHandle,
    game_id: i64,
    status: &str,
    bytes_downloaded: Option<u64>,
    total_bytes: Option<u64>,
    error: Option<String>,
) {
    let progress = DownloadProgress {
        game_id,
        status: status.to_string(),
        bytes_downloaded: bytes_downloaded.unwrap_or(0),
        total_bytes,
        error,
    };
    let _ = app.emit("download-progress", progress);
}

fn extract_archive(archive_path: &Path, install_dir: &Path) -> Result<PathBuf, String> {
    if install_dir.exists() {
        return Err(format!(
            "Install folder already exists: {}",
            install_dir.display()
        ));
    }
    fs::create_dir_all(install_dir)
        .map_err(|error| format!("Cannot create game folder: {error}"))?;
    let extraction_result = (|| {
        let file = File::open(archive_path)
            .map_err(|error| format!("Cannot open downloaded archive: {error}"))?;
        let mut archive = ZipArchive::new(file)
            .map_err(|error| format!("Unsupported or invalid ZIP archive: {error}"))?;
        fs::canonicalize(install_dir)
            .map_err(|error| format!("Cannot resolve game folder: {error}"))?;
        let mut launch_candidates = Vec::new();
        for index in 0..archive.len() {
            let mut entry = archive
                .by_index(index)
                .map_err(|error| format!("Cannot read archive entry: {error}"))?;
            let enclosed = entry
                .enclosed_name()
                .ok_or_else(|| format!("Archive contains an unsafe path: {}", entry.name()))?;
            if entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
            {
                return Err(format!(
                    "Archive contains a symbolic link: {}",
                    entry.name()
                ));
            }
            let target = install_dir.join(enclosed);
            if !target.starts_with(install_dir) {
                return Err(format!("Archive contains an unsafe path: {}", entry.name()));
            }
            if entry.is_dir() {
                fs::create_dir_all(&target)
                    .map_err(|error| format!("Cannot create extracted folder: {error}"))?;
                continue;
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("Cannot create extracted folder: {error}"))?;
            }
            let mut output = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&target)
                .map_err(|error| format!("Cannot write extracted file: {error}"))?;
            io::copy(&mut entry, &mut output)
                .map_err(|error| format!("Cannot extract archive file: {error}"))?;
            output
                .flush()
                .map_err(|error| format!("Cannot flush extracted file: {error}"))?;
            #[cfg(unix)]
            if let Some(mode) = entry.unix_mode().filter(|mode| mode & 0o111 != 0) {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&target, fs::Permissions::from_mode(mode & 0o755))
                    .map_err(|error| format!("Cannot set game file permissions: {error}"))?;
            }
            let relative = target
                .strip_prefix(install_dir)
                .map_err(|_| "Extracted file escaped the install folder.".to_string())?;
            if is_launch_candidate(relative, entry.unix_mode()) {
                launch_candidates.push(target);
            }
        }
        if launch_candidates.is_empty() {
            return Err(
                "Archive extracted, but it contains no launchable game for this operating system."
                    .into(),
            );
        }
        launch_candidates.sort_by_key(|path| {
            let value = path.to_string_lossy().to_lowercase();
            if value.ends_with(".exe") || value.ends_with(".sh") || value.ends_with(".app") {
                0
            } else {
                1
            }
        });
        Ok(launch_candidates.remove(0))
    })();
    if extraction_result.is_err() {
        let _ = fs::remove_dir_all(install_dir);
    }
    extraction_result
}

#[cfg(target_os = "windows")]
fn is_launch_candidate(path: &Path, _mode: Option<u32>) -> bool {
    path.extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
}

#[cfg(target_os = "macos")]
fn is_launch_candidate(path: &Path, mode: Option<u32>) -> bool {
    let text = path.to_string_lossy();
    (text.ends_with(".app/Contents/MacOS") || text.contains(".app/Contents/MacOS/"))
        && mode.is_some_and(|value| value & 0o111 != 0)
}

#[cfg(target_os = "linux")]
fn is_launch_candidate(path: &Path, mode: Option<u32>) -> bool {
    let executable = mode.is_some_and(|value| value & 0o111 != 0);
    executable
        && (path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("sh"))
            || path.extension().is_none())
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn is_launch_candidate(_path: &Path, _mode: Option<u32>) -> bool {
    false
}

fn launch_game_inner(state: &AppState, game_id: i64) -> Result<(), String> {
    let (install_dir, launch_path): (PathBuf, Option<PathBuf>) = {
        let db = state.db.lock().map_err(|_| lock_error())?;
        db.query_row(
            "SELECT install_dir,launch_path FROM downloads WHERE game_id=?1 AND status='installed'",
            [game_id],
            |row| {
                Ok((
                    PathBuf::from(row.get::<_, String>(0)?),
                    row.get::<_, Option<String>>(1)?.map(PathBuf::from),
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Cannot load installed game: {error}"))?
        .ok_or_else(|| "This game is not installed.".to_string())?
    };
    let launch_path =
        launch_path.ok_or_else(|| "No launchable file was recorded for this game.".to_string())?;
    let (install_root, launch_path) = validate_launch_path(&install_dir, &launch_path)?;
    let mut running = state.running.lock().map_err(|_| lock_error())?;
    if let Some(child) = running.get_mut(&game_id) {
        if child
            .try_wait()
            .map_err(|error| format!("Cannot check game process: {error}"))?
            .is_none()
        {
            return Err("This game is already running.".into());
        }
        running.remove(&game_id);
    }
    let mut command = Command::new(&launch_path);
    command
        .current_dir(&install_root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let child = command
        .spawn()
        .map_err(|error| format!("Cannot launch game: {error}"))?;
    running.insert(game_id, child);
    drop(running);
    state
        .db
        .lock()
        .map_err(|_| lock_error())?
        .execute(
            "UPDATE downloads SET error=NULL,updated_at=CURRENT_TIMESTAMP WHERE game_id=?1 AND status='installed'",
            [game_id],
        )
        .map_err(|error| {
            format!("Game launched, but its library status could not be updated: {error}")
        })?;
    Ok(())
}

fn validate_launch_path(
    install_dir: &Path,
    launch_path: &Path,
) -> Result<(PathBuf, PathBuf), String> {
    let install_root = fs::canonicalize(install_dir)
        .map_err(|error| format!("Game install folder is unavailable: {error}"))?;
    let launch_path = fs::canonicalize(launch_path)
        .map_err(|error| format!("Game launch file is unavailable: {error}"))?;
    if !launch_path.starts_with(&install_root) || !launch_path.is_file() {
        return Err(
            "The game launch file is outside its install folder or is not a regular file.".into(),
        );
    }
    Ok((install_root, launch_path))
}

#[tauri::command]
fn launch_game(game_id: i64, state: State<'_, AppState>) -> Result<(), String> {
    launch_game_inner(state.inner(), game_id)
}

#[tauri::command]
fn stop_game(game_id: i64, state: State<'_, AppState>) -> Result<(), String> {
    let mut running = state.running.lock().map_err(|_| lock_error())?;
    let mut child = running
        .remove(&game_id)
        .ok_or_else(|| "This game is not running.".to_string())?;
    if child
        .try_wait()
        .map_err(|error| format!("Cannot check game process: {error}"))?
        .is_none()
    {
        #[cfg(unix)]
        {
            let process_group = -(child.id() as i32);
            // The game was started in its own process group; stop it and its child processes together.
            let result = unsafe { libc::kill(process_group, libc::SIGTERM) };
            if result != 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::ESRCH) {
                    return Err(format!("Cannot stop game process group: {error}"));
                }
            }
        }
        #[cfg(windows)]
        child
            .kill()
            .map_err(|error| format!("Cannot stop game: {error}"))?;
        child
            .wait()
            .map_err(|error| format!("Cannot confirm game stopped: {error}"))?;
    }
    Ok(())
}

fn stop_orphaned_downloads(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            "UPDATE downloads SET status='paused',error=NULL,updated_at=CURRENT_TIMESTAMP WHERE status='downloading'",
            [],
        )
        .map_err(|error| format!("Cannot restore interrupted downloads: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_catalog_and_persist_download_state() {
        let connection = Connection::open_in_memory().expect("in-memory database");
        initialize_db(&connection).expect("schema and catalog");
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM games", [], |row| row.get(0))
            .unwrap();
        let seeds = serde_json::from_str::<Vec<CatalogSeed>>(include_str!("catalog.json")).unwrap();
        assert_eq!(count, 11);
        assert_eq!(count as usize, seeds.len());
        let browser_only: bool = connection
            .query_row(
                "SELECT browser_only FROM games WHERE slug='remember'",
                [],
                |row| Ok(row.get::<_, i64>(0)? != 0),
            )
            .unwrap();
        assert!(!browser_only);
        connection
            .execute(
                "INSERT INTO downloads (game_id,url,status,archive_path,install_dir) VALUES (1,'https://example.itch.zone/game.zip','downloading','/tmp/a.zip.part','/tmp/a')",
                [],
            )
            .unwrap();
        connection
            .execute("UPDATE downloads SET status='paused' WHERE game_id=1", [])
            .unwrap();
        let status: String = connection
            .query_row("SELECT status FROM downloads WHERE game_id=1", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(status, "paused");
        connection
            .execute(
                "UPDATE downloads SET status='cancelled' WHERE game_id=1",
                [],
            )
            .unwrap();
        let status: String = connection
            .query_row("SELECT status FROM downloads WHERE game_id=1", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(status, "cancelled");
    }

    #[test]
    fn adds_new_catalog_entries_to_an_existing_database() {
        let connection = Connection::open_in_memory().expect("in-memory database");
        initialize_db(&connection).expect("initial catalog");
        connection
            .execute("DELETE FROM games WHERE slug='stillwater'", [])
            .expect("simulate an older catalog");

        initialize_db(&connection).expect("catalog update");
        let game = query_games(&connection)
            .expect("updated catalog")
            .into_iter()
            .find(|game| game.slug == "stillwater")
            .expect("Stillwater is added to the existing catalog");
        assert_eq!(game.game_url, "https://studioclump.itch.io/stillwater");
    }

    #[test]
    fn upgrades_previous_database_schema() {
        let connection = Connection::open_in_memory().expect("in-memory database");
        connection
            .execute_batch(
                "
                CREATE TABLE games (
                    id INTEGER PRIMARY KEY,
                    slug TEXT NOT NULL UNIQUE,
                    title TEXT NOT NULL,
                    creator TEXT NOT NULL,
                    description TEXT NOT NULL,
                    cover_url TEXT NOT NULL,
                    game_url TEXT NOT NULL,
                    download_url TEXT,
                    genre TEXT NOT NULL,
                    published TEXT NOT NULL,
                    browser_only INTEGER NOT NULL DEFAULT 1
                );
                CREATE TABLE downloads (
                    game_id INTEGER PRIMARY KEY REFERENCES games(id),
                    url TEXT NOT NULL,
                    status TEXT NOT NULL,
                    bytes_downloaded INTEGER NOT NULL DEFAULT 0,
                    total_bytes INTEGER,
                    archive_path TEXT NOT NULL,
                    install_dir TEXT NOT NULL,
                    launch_path TEXT,
                    run_after INTEGER NOT NULL DEFAULT 0,
                    error TEXT,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                INSERT INTO games (slug,title,creator,description,cover_url,game_url,genre,published,browser_only)
                VALUES ('remember','Remember','Laucifer','','https://example.com/cover','https://xlaucifer.itch.io/remember','Visual novel','—',1);
                ",
            )
            .expect("previous schema");
        initialize_db(&connection).expect("database upgrades");
        let games = query_games(&connection).expect("upgraded game list");
        assert_eq!(games.len(), 1);
        assert!(!games[0].browser_only);
        assert!(!games[0].browser_playable);
        assert!(games[0].files.is_empty());
        let download_columns: Vec<String> = connection
            .prepare("PRAGMA table_info(downloads)")
            .unwrap()
            .query_map([], |row| row.get(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(download_columns.iter().any(|column| column == "upload_id"));
        assert!(download_columns
            .iter()
            .any(|column| column == "selected_file_name"));
    }

    #[test]
    fn downloader_accepts_only_https_itch_hosts() {
        assert!(validate_download_url("https://foo.itch.zone/download").is_ok());
        assert!(validate_download_url("https://itch.io/download").is_ok());
        assert!(validate_download_url("http://foo.itch.zone/download").is_err());
        assert!(validate_download_url("https://itch.io.attacker.example/download").is_err());
    }

    #[test]
    fn validates_signed_archive_for_selected_file_without_public_upload_id() {
        let archive_url = "https://itchio-mirror.abc123.r2.cloudflarestorage.com/upload2/game/1/2?X-Amz-Signature=ok";
        assert!(validate_download_response_url(archive_url, Some("Remember.zip")).is_ok());
        assert!(validate_download_response_url(archive_url, None).is_err());
    }

    #[test]
    fn parses_itch_upload_metadata_and_rejects_non_zip_installs() {
        let html = r#"
            <div class="upload">
              <a class="button download_btn" data-upload_id="15231115" href="javascript:void(0);">Download</a>
              <div class="info_column"><div class="upload_name">
                <strong title="Tactical Squad.zip" class="name">Tactical Squad.zip</strong>
                <span class="file_size"><span>119 MB</span></span>
                <span class="download_platforms"><span title="Download for Windows"></span><span title="Download for Linux"></span></span>
              </div></div>
            </div>
            <div class="upload">
              <div class="info_column"><div class="upload_name">
                <strong title="Android build.apk" class="name">Android build.apk</strong>
                <span class="file_size"><span>125 MB</span></span>
                <span class="download_platforms"><span title="Download for Android"></span></span>
              </div></div>
            </div>
            <div class="upload">
              <div class="info_column"><div class="upload_name">
                                <strong class="name">Windows build.zip</strong>
                <span class="file_size"><span>45 MB</span></span>
                <span class="download_platforms"><span title="Download for Windows"></span></span>
              </div></div>
            </div>
        "#;
        let files = parse_itch_game_files(html).expect("page HTML parses");
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].upload_id, Some(15231115));
        assert_eq!(files[0].size.as_deref(), Some("119 MB"));
        assert_eq!(files[0].platforms, ["Windows", "Linux"]);
        assert_eq!(files[1].upload_id, None);
        assert!(files[0].installable);
        assert!(!files[1].installable);
        assert!(files[2].installable);
    }

    #[test]
    fn accepts_only_itch_signed_archive_hosts() {
        assert!(validate_itch_signed_download_url(
            "https://itchio-mirror.abc123.r2.cloudflarestorage.com/upload2/game/1/2?X-Amz-Signature=ok"
        )
        .is_ok());
        assert!(
            validate_itch_signed_download_url("https://attacker.example/upload2/game/1/2").is_err()
        );
        assert!(validate_itch_signed_download_url(
            "https://itchio-mirror.abc123.r2.cloudflarestorage.com/unexpected/path"
        )
        .is_err());
    }

    #[test]
    fn detects_itch_browser_playable_pages() {
        assert!(page_is_browser_playable(r#"{"type_name": "html"}"#).unwrap());
        assert!(!page_is_browser_playable(r#"{"type_name": "default"}"#).unwrap());
    }

    #[test]
    fn only_safe_catalog_slugs_can_be_used_as_install_directories() {
        assert!(is_safe_slug("14-days-with-you-demo"));
        assert!(is_safe_slug("remember"));
        assert!(!is_safe_slug("../outside"));
        assert!(!is_safe_slug("C:\\games"));
        assert!(!is_safe_slug(""));
    }

    #[test]
    fn rejects_archive_path_traversal() {
        let dir = std::env::temp_dir().join(format!("redline-zip-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let zip_path = dir.join("unsafe.zip");
        {
            let file = File::create(&zip_path).unwrap();
            let mut writer = zip::ZipWriter::new(file);
            writer
                .start_file("../outside.exe", zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(b"not executable").unwrap();
            writer.finish().unwrap();
        }
        let result = extract_archive(&zip_path, &dir.join("install"));
        assert!(result.is_err());
        assert!(!dir.join("outside.exe").exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn extracts_a_valid_archive_and_finds_its_game_launcher() {
        let dir = std::env::temp_dir().join(format!("redline-valid-zip-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let zip_path = dir.join("game.zip");
        {
            let file = File::create(&zip_path).unwrap();
            let mut writer = zip::ZipWriter::new(file);
            #[cfg(target_os = "windows")]
            let name = "Game/game.exe";
            #[cfg(target_os = "macos")]
            let name = "Game.app/Contents/MacOS/Game";
            #[cfg(target_os = "linux")]
            let name = "game";
            writer
                .start_file(
                    name,
                    zip::write::SimpleFileOptions::default().unix_permissions(0o755),
                )
                .unwrap();
            writer.write_all(b"test launcher").unwrap();
            writer.finish().unwrap();
        }
        let launcher =
            extract_archive(&zip_path, &dir.join("installed")).expect("valid game archive");
        assert!(launcher.is_file());
        assert!(launcher.starts_with(dir.join("installed")));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_launch_files_outside_the_install_folder() {
        let dir = std::env::temp_dir().join(format!("redline-launch-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("game")).unwrap();
        fs::write(dir.join("game/inside.exe"), b"launcher").unwrap();
        fs::write(dir.join("outside.exe"), b"not a game").unwrap();
        assert!(validate_launch_path(&dir.join("game"), &dir.join("game/inside.exe")).is_ok());
        assert!(validate_launch_path(&dir.join("game"), &dir.join("outside.exe")).is_err());
        let _ = fs::remove_dir_all(dir);
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let db_path = data_dir.join("library.sqlite3");
            let connection = open_db(&db_path).map_err(std::io::Error::other)?;
            stop_orphaned_downloads(&connection).map_err(std::io::Error::other)?;
            app.manage(AppState {
                db: Arc::new(Mutex::new(connection)),
                transfers: Arc::new(Mutex::new(HashMap::new())),
                running: Arc::new(Mutex::new(HashMap::new())),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_games,
            refresh_game_files,
            list_downloads,
            list_library,
            start_download,
            pause_download,
            resume_download,
            cancel_download,
            launch_game,
            stop_game
        ])
        .run(tauri::generate_context!())
        .expect("error while running Redline Library");
}
