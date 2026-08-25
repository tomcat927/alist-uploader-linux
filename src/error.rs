use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use crate::services::alist_client::AlistError;

#[derive(Debug)]
pub enum ApiError {
    BadRequest(String),
    NotFound(String),
    Internal(String),
    Alist(String),
}

impl From<Box<dyn std::error::Error>> for ApiError {
    fn from(e: Box<dyn std::error::Error>) -> Self {
        ApiError::Internal(e.to_string())
    }
}

impl From<AlistError> for ApiError {
    fn from(e: AlistError) -> Self {
        ApiError::Alist(e.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            ApiError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg),
            ApiError::NotFound(msg) => (StatusCode::NOT_FOUND, msg),
            ApiError::Internal(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg),
            ApiError::Alist(msg) => (StatusCode::BAD_GATEWAY, msg),
        };
        (status, Json(serde_json::json!({ "error": message }))).into_response()
    }
}
