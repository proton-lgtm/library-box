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
    download_status: Option<String>,
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
                browser_only INTEGER NOT NULL DEFAULT 0
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
                error TEXT,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            ",
        )
        .map_err(|error| format!("Cannot initialize library database: {error}"))?;
    let has_browser_only = {
        let mut statement = connection
            .prepare("PRAGMA table_info(games)")
            .map_err(|error| format!("Cannot inspect database schema: {error}"))?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| format!("Cannot inspect database schema: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Cannot inspect database schema: {error}"))?;
        columns.iter().any(|name| name == "browser_only")
    };
    if !has_browser_only {
        connection
            .execute(
                "ALTER TABLE games ADD COLUMN browser_only INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|error| format!("Cannot upgrade library database: {error}"))?;
    }
    let count: i64 = connection
        .query_row("SELECT COUNT(*) FROM games", [], |row| row.get(0))
        .map_err(|error| format!("Cannot read game catalog: {error}"))?;
    if count == 0 {
        let seeds: Vec<CatalogSeed> = serde_json::from_str(include_str!("catalog.json"))
            .map_err(|error| format!("Bundled game catalog is invalid: {error}"))?;
        for seed in seeds {
            connection
                .execute(
                    "INSERT INTO games (slug,title,creator,description,cover_url,game_url,download_url,genre,published,browser_only)
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
    }
    Ok(())
}

fn query_games(connection: &Connection) -> Result<Vec<Game>, String> {
    let mut statement = connection
        .prepare(
            "SELECT g.id,g.slug,g.title,g.creator,g.description,g.cover_url,g.game_url,g.download_url,g.genre,g.published,d.status,g.browser_only
             FROM games g LEFT JOIN downloads d ON d.game_id=g.id ORDER BY g.id",
        )
        .map_err(|error| format!("Cannot query games: {error}"))?;
    let result = statement
        .query_map([], |row| {
            Ok(Game {
                id: row.get(0)?,
                slug: row.get(1)?,
                title: row.get(2)?,
                creator: row.get(3)?,
                description: row.get(4)?,
                cover_url: row.get(5)?,
                game_url: row.get(6)?,
                download_url: row.get(7)?,
                genre: row.get(8)?,
                published: row.get(9)?,
                download_status: row.get(10)?,
                browser_only: row.get::<_, i64>(11)? != 0,
            })
        })
        .map_err(|error| format!("Cannot query games: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Cannot read game catalog: {error}"))?;
    Ok(result)
}

#[tauri::command]
fn list_games(state: State<'_, AppState>) -> Result<Vec<Game>, String> {
    let db = state.db.lock().map_err(|_| lock_error())?;
    query_games(&db)
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
        "SELECT game_id,url,archive_path,install_dir,run_after FROM downloads WHERE game_id=?1",
        [game_id],
        |row| {
            Ok(TransferRecord {
                game_id: row.get(0)?,
                url: row.get(1)?,
                archive_path: PathBuf::from(row.get::<_, String>(2)?),
                install_dir: PathBuf::from(row.get::<_, String>(3)?),
                run_after: row.get::<_, i64>(4)? != 0,
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

fn is_safe_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

#[tauri::command]
fn start_download(
    game_id: i64,
    destination: String,
    run_after: bool,
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
    let (url, slug, browser_only) = {
        let db = app_state.db.lock().map_err(|_| lock_error())?;
        let (url, slug, browser_only): (Option<String>, String, bool) = db
            .query_row(
                "SELECT download_url,slug,browser_only FROM games WHERE id=?1",
                [game_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get::<_, i64>(2)? != 0)),
            )
            .optional()
            .map_err(|error| format!("Cannot load game details: {error}"))?
            .ok_or_else(|| "That game is no longer in the catalog.".to_string())?;
        (
            url.ok_or_else(|| {
                "No verified public download is available for this game yet.".to_string()
            })?,
            slug,
            browser_only,
        )
    };
    if browser_only {
        return Err("This title is browser-only and cannot be installed as a desktop game.".into());
    }
    validate_download_url(&url)?;
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
            "INSERT INTO downloads (game_id,url,status,bytes_downloaded,total_bytes,archive_path,install_dir,launch_path,run_after,error,updated_at)
             VALUES (?1,?2,'downloading',0,NULL,?3,?4,NULL,?5,NULL,CURRENT_TIMESTAMP)
             ON CONFLICT(game_id) DO UPDATE SET url=excluded.url,status='downloading',bytes_downloaded=0,total_bytes=NULL,
                 archive_path=excluded.archive_path,install_dir=excluded.install_dir,launch_path=NULL,run_after=excluded.run_after,error=NULL,updated_at=CURRENT_TIMESTAMP",
            params![game_id,url,archive_path.to_string_lossy(),install_dir.to_string_lossy(),if run_after { 1_i64 } else { 0_i64 }],
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
    validate_download_url(&record.url)?;
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
    let mut request = client.get(&record.url);
    if existing > 0 {
        request = request.header(header::RANGE, format!("bytes={existing}-"));
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("Download failed: {error}"))?;
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
        assert_eq!(count, 10);
        assert_eq!(count as usize, seeds.len());
        let browser_only: bool = connection
            .query_row(
                "SELECT browser_only FROM games WHERE slug='remember'",
                [],
                |row| Ok(row.get::<_, i64>(0)? != 0),
            )
            .unwrap();
        assert!(browser_only);
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
    fn downloader_accepts_only_https_itch_hosts() {
        assert!(validate_download_url("https://foo.itch.zone/download").is_ok());
        assert!(validate_download_url("https://itch.io/download").is_ok());
        assert!(validate_download_url("http://foo.itch.zone/download").is_err());
        assert!(validate_download_url("https://itch.io.attacker.example/download").is_err());
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
