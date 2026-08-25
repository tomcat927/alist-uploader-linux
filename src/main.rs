mod models;
mod services;
mod utils;
mod routes;
mod error;

use std::sync::Arc;
use tracing_subscriber::EnvFilter;
use axum::Router;
use tower_http::{
    cors::CorsLayer,
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use crate::services::queue_manager::QueueManager;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "alist_uploader_linux=info,tower_http=info".into()))
        .init();

    let queue_manager = Arc::new(QueueManager::new().expect("初始化队列管理器失败"));
    let qm = queue_manager.clone();
    tokio::spawn(async move {
        let schedule_manager = services::schedule_manager::ScheduleManager::new(qm);
        schedule_manager.start_schedule_monitor().await;
    });

    let state = routes::AppState::new(queue_manager);

    let dist = std::path::Path::new("frontend/dist");
    let (dist_dir, index_html) = if dist.exists() {
        (
            std::path::PathBuf::from("frontend/dist"),
            std::path::PathBuf::from("frontend/dist/index.html"),
        )
    } else {
        (
            std::path::PathBuf::from("frontend/public"),
            std::path::PathBuf::from("frontend/public/index.html"),
        )
    };
    let serve_frontend = ServeDir::new(dist_dir).not_found_service(ServeFile::new(index_html));

    let app = Router::new()
        .nest("/api", routes::api_routes(state.clone()))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .fallback_service(serve_frontend);

    let addr = "0.0.0.0:8080";
    tracing::info!("服务启动于 http://{}", addr);
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
