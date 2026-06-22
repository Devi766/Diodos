use crate::core::manager::CoreManager;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{mpsc, Mutex},
    thread,
};

#[derive(Default)]
pub(crate) struct RuntimeState {
    pub(crate) core: CoreManager,
    pub(crate) current_node: Option<String>,
    pub(crate) last_traffic: Option<TrafficSnapshot>,
    pub(crate) converter_server: Option<ConverterServerHandle>,
    pub(crate) version_cache: HashMap<String, VersionCacheEntry>,
    pub(crate) ai_streams: HashMap<String, tokio::sync::oneshot::Sender<()>>,
    pub(crate) subscription_update_attempts: HashMap<String, u128>,
}

#[derive(Default)]
pub(crate) struct AppState {
    pub(crate) runtime: Mutex<RuntimeState>,
}

#[derive(Clone)]
pub(crate) struct VersionCacheEntry {
    pub(crate) versions: Vec<Value>,
    pub(crate) timestamp: u128,
}

pub(crate) struct ConverterServerHandle {
    pub(crate) port: u16,
    pub(crate) stop: mpsc::Sender<()>,
    pub(crate) thread: Option<thread::JoinHandle<()>>,
}

#[derive(Debug, Clone)]
pub(crate) struct TrafficSnapshot {
    pub(crate) up: u64,
    pub(crate) down: u64,
    pub(crate) timestamp: u128,
}
