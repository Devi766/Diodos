use serde::Deserialize;
use serde_json::{Map, Value};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FetchOptions {
    #[serde(default = "default_method")]
    pub(crate) method: String,
    #[serde(default)]
    pub(crate) headers: Map<String, Value>,
    #[serde(default)]
    pub(crate) body: Option<Value>,
    #[serde(default)]
    pub(crate) timeout: Option<u64>,
    #[serde(default)]
    pub(crate) url: Option<String>,
    #[serde(default)]
    pub(crate) proxy: Option<Value>,
}

impl Default for FetchOptions {
    fn default() -> Self {
        Self {
            method: default_method(),
            headers: Map::new(),
            body: None,
            timeout: None,
            url: None,
            proxy: None,
        }
    }
}

fn default_method() -> String {
    "GET".to_string()
}
