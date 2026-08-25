use std::sync::Arc;
use axum::{
    extract::{Path, Query, State},
    routing::{delete, get, post, put},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use tower_http::services::fs::ServeFile;
use tower_http::services::ServeDir;

use crate::error::ApiError;
use crate::models::*;
use crate::services::alist_client::{AlistClient, DirItem};
use crate::services::queue_manager::QueueManager;
use crate::services::upload_scheduler::UploadScheduler;
use crate::utils::storage::Storage;
use crate::utils::log::log;

#[derive(Clone)]
pub struct AppState {
    pub qm: Arc<QueueManager>,
}

impl AppState {
    pub fn new(qm: Arc<QueueManager>) -> Self {
        Self { qm }
    }
}

pub fn api_routes(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/queue", get(get_queue).post(add_to_queue))
        .route("/queue/{id}", delete(remove_from_queue))
        .route("/queue", delete(clear_queue))
        .route("/history", get(get_history).delete(clear_history))
        .route("/config", get(get_config).put(save_config))
        .route("/upload/start", post(start_upload))
        .route("/upload/pause", post(pause_upload))
        .route("/upload/state", get(upload_state))
        .route("/retry/{id}", post(retry_upload))
        .route("/alist/test", post(test_alist_connection))
        .route("/alist/login", post(alist_login))
        .route("/alist/list-dir", post(alist_list_dir))
        .route("/alist/health", post(alist_health))
        .route("/fs/roots", get(fs_roots))
        .route("/fs/list", get(fs_list_dir))
        .route("/blocked", get(get_blocked_files).delete(clear_blocked_files))
        .route("/blocked/{index}", delete(remove_blocked_file))
        .route("/shutdown", delete(cancel_shutdown))
        .with_state(state)
}

pub fn serve_frontend() -> ServeDir {
    let dist = std::path::Path::new("frontend/dist");
    if dist.exists() {
        let index = dist.join("index.html");
        ServeDir::new(dist).not_found_service(ServeFile::new(index))
    } else {
        ServeDir::new("frontend/public")
    }
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok", "version": "0.1.0" }))
}

async fn get_queue(State(state): State<AppState>) -> Json<Vec<UploadTask>> {
    let queue = state.qm.queue.read().await;
    Json(queue.tasks.clone())
}

#[derive(Deserialize)]
struct AddQueueReq {
    file_path: String,
    alist_path: String,
}

async fn add_to_queue(
    State(state): State<AppState>,
    Json(req): Json<AddQueueReq>,
) -> Result<Json<AddToQueueResult>, ApiError> {
    let result = state.qm.add_to_queue(req.file_path, req.alist_path).await?;
    Ok(Json(result))
}

async fn remove_from_queue(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
) -> Result<Json<()>, ApiError> {
    state.qm.remove_from_queue(task_id).await?;
    Ok(Json(()))
}

async fn clear_queue(State(state): State<AppState>) -> Result<Json<()>, ApiError> {
    state.qm.clear_queue().await?;
    Ok(Json(()))
}

async fn get_history(State(state): State<AppState>) -> Json<Vec<UploadTask>> {
    Json(state.qm.get_history().await)
}

async fn clear_history(State(state): State<AppState>) -> Result<Json<()>, ApiError> {
    state.qm.clear_history().await?;
    Ok(Json(()))
}

async fn get_config() -> Result<Json<AppConfig>, ApiError> {
    let config = Storage::load_config()?;
    Ok(Json(config))
}

async fn save_config(
    State(state): State<AppState>,
    Json(config): Json<AppConfig>,
) -> Result<Json<()>, ApiError> {
    state.qm.save_config(config).await?;
    Ok(Json(()))
}

async fn start_upload(State(state): State<AppState>) -> Result<Json<()>, ApiError> {
    let scheduler = UploadScheduler::new(state.qm.clone_inner());
    tokio::spawn(async move {
        scheduler.start_scheduler().await;
    });
    Ok(Json(()))
}

async fn pause_upload(State(state): State<AppState>) -> Json<()> {
    state.qm.set_stop_after_current(true);
    Json(())
}

async fn upload_state(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "is_uploading": state.qm.is_uploading(),
        "is_stopping": state.qm.stop_after_current(),
        "tasks_uploaded": state.qm.tasks_uploaded_in_run(),
        "tasks_failed": state.qm.tasks_failed_in_run(),
    }))
}

async fn retry_upload(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
) -> Result<Json<()>, ApiError> {
    let mut queue = state.qm.queue.write().await;
    if let Some(task) = queue.tasks.iter_mut().find(|t| t.id == task_id) {
        task.status = TaskStatus::Pending;
        task.retry_count = 0;
        task.error = None;
        task.progress = 0;
        task.updated_at = chrono::Utc::now();
    }
    Storage::save_queue(&*queue)?;
    Ok(Json(()))
}

#[derive(Deserialize)]
struct TestAlistReq {
    config: AppConfig,
}

async fn test_alist_connection(
    Json(req): Json<TestAlistReq>,
) -> Result<Json<bool>, ApiError> {
    let client = AlistClient::new(req.config.alist.base_url, req.config.alist.token);
    let ok = client.test_connection().await?;
    Ok(Json(ok))
}

#[derive(Deserialize)]
struct AlistLoginReq {
    base_url: String,
    username: String,
    password: String,
}

async fn alist_login(
    State(state): State<AppState>,
    Json(req): Json<AlistLoginReq>,
) -> Result<Json<String>, ApiError> {
    let normalized = req.base_url.trim_end_matches('/').to_string();
    let client = AlistClient::new(normalized.clone(), String::new());
    let token = client.login(&req.username, &req.password).await?;
    let mut config = Storage::load_config()?;
    config.alist.base_url = normalized;
    config.alist.token = token.clone();
    config.alist.username = req.username;
    config.alist.password = req.password;
    state.qm.save_config(config).await?;
    Ok(Json(token))
}

#[derive(Deserialize)]
struct AlistListDirReq {
    config: AppConfig,
    path: String,
}

async fn alist_list_dir(
    Json(req): Json<AlistListDirReq>,
) -> Result<Json<Vec<DirItem>>, ApiError> {
    let client = AlistClient::new(req.config.alist.base_url, req.config.alist.token);
    let items = client.list_directory(&req.path).await?;
    Ok(Json(items))
}

#[derive(Deserialize)]
struct AlistHealthReq {
    config: AppConfig,
}

async fn alist_health(
    Json(req): Json<AlistHealthReq>,
) -> Result<Json<bool>, ApiError> {
    let client = AlistClient::new(req.config.alist.base_url, req.config.alist.token);
    let ok = client.check_service_available().await?;
    Ok(Json(ok))
}

#[derive(Serialize)]
struct FsEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    modified: String,
}

async fn fs_roots() -> Json<Vec<FsEntry>> {
    let mut roots = Vec::new();
    for base in &["/mnt", "/media", "/run/media"] {
        if let Ok(mut entries) = std::fs::read_dir(base) {
            while let Ok(Some(entry)) = entries.next() {
                if let Ok(meta) = entry.metadata() {
                    if meta.is_dir() {
                        let name = entry.file_name().to_string_lossy().to_string();
                        let path = entry.path().to_string_lossy().to_string().replace('\\', "/");
                        roots.push(FsEntry {
                            name,
                            path,
                            is_dir: true,
                            size: 0,
                            modified: meta.modified().ok()
                                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                                .map(|d| d.as_secs().to_string())
                                .unwrap_or_default(),
                        });
                    }
                }
            }
        }
    }
    roots.push(FsEntry {
        name: "/ (根目录)".to_string(),
        path: "/".to_string(),
        is_dir: true,
        size: 0,
        modified: "".to_string(),
    });
    if let Some(home) = dirs::home_dir() {
        roots.push(FsEntry {
            name: format!("~ ({})", home.to_string_lossy()),
            path: home.to_string_lossy().to_string().replace('\\', "/"),
            is_dir: true,
            size: 0,
            modified: "".to_string(),
        });
    }
    Json(roots)
}

#[derive(Deserialize)]
struct FsListQuery {
    path: Option<String>,
}

async fn fs_list_dir(
    Query(query): Query<FsListQuery>,
) -> Result<Json<Vec<FsEntry>>, ApiError> {
    let path = query.path.unwrap_or_else(|| "/".to_string());
    let dir = std::path::Path::new(&path);
    if !dir.is_dir() {
        return Err(ApiError::NotFound(format!("目录不存在: {}", path)));
    }
    let mut entries = Vec::new();
    let mut read = std::fs::read_dir(dir).map_err(|e| ApiError::Internal(e.to_string()))?;
    while let Ok(Some(entry)) = read.next() {
        if let Ok(meta) = entry.metadata() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let entry_path = entry.path().to_string_lossy().to_string().replace('\\', "/");
            entries.push(FsEntry {
                name: name.clone(),
                path: entry_path,
                is_dir: meta.is_dir(),
                size: meta.len(),
                modified: meta.modified().ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| {
                        chrono::DateTime::from_timestamp(d.as_secs() as i64, 0)
                            .map(|dt| dt.to_rfc3339())
                            .unwrap_or_default()
                    })
                    .unwrap_or_default(),
            });
        }
    }
    entries.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            b.is_dir.cmp(&a.is_dir)
        } else {
            a.name.cmp(&b.name)
        }
    });
    Ok(Json(entries))
}

async fn get_blocked_files() -> Result<Json<Vec<BlockedFileRecord>>, ApiError> {
    let data = Storage::load_blocked_files()?;
    Ok(Json(data.records))
}

async fn remove_blocked_file(
    Path(index): Path<usize>,
) -> Result<Json<()>, ApiError> {
    let mut data = Storage::load_blocked_files()?;
    if index < data.records.len() {
        data.records.remove(index);
        Storage::save_blocked_files(&data)?;
    }
    Ok(Json(()))
}

async fn clear_blocked_files() -> Result<Json<()>, ApiError> {
    Storage::save_blocked_files(&BlockedFileData::default())?;
    Ok(Json(()))
}

async fn cancel_shutdown(State(state): State<AppState>) -> Json<()> {
    state.qm.clear_shutdown_deadline().await;
    Json(())
}
