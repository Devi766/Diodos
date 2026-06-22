use std::path::Path;

use serde::Serialize;

pub const CORE_PRODUCT_NAME: &str = "FlyClash Core";
pub const CORE_BINARY_FAMILY: &str = "flyclash-mihomo";
pub const LEGACY_CORE_BINARY_FAMILY: &str = "mihomo";

pub const CORE_TYPE_STABLE: &str = "mihomo";
pub const CORE_TYPE_ALPHA: &str = "mihomo-alpha";
pub const CORE_TYPE_SMART: &str = "mihomo-smart";
pub const CORE_TYPE_SPECIFIC: &str = "mihomo-specific";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CoreRepo {
    pub owner: &'static str,
    pub repo: &'static str,
    pub release_tag: Option<&'static str>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CoreProductIdentity {
    pub product_name: &'static str,
    pub binary_family: &'static str,
    pub legacy_binary_family: &'static str,
}

pub fn product_identity() -> CoreProductIdentity {
    CoreProductIdentity {
        product_name: CORE_PRODUCT_NAME,
        binary_family: CORE_BINARY_FAMILY,
        legacy_binary_family: LEGACY_CORE_BINARY_FAMILY,
    }
}

pub fn normalize_core_type(value: Option<&str>) -> &'static str {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        Some(CORE_TYPE_ALPHA) => CORE_TYPE_ALPHA,
        Some(CORE_TYPE_SMART) => CORE_TYPE_SMART,
        Some(CORE_TYPE_SPECIFIC) => CORE_TYPE_SPECIFIC,
        _ => CORE_TYPE_STABLE,
    }
}

pub fn normalize_core_version(value: &str) -> String {
    value.trim().trim_start_matches(['v', 'V']).to_string()
}

pub fn executable_ext() -> &'static str {
    if cfg!(windows) {
        ".exe"
    } else {
        ""
    }
}

pub fn managed_core_file_name(core_type: &str, specific_version: Option<&str>) -> String {
    let ext = executable_ext();
    match (normalize_core_type(Some(core_type)), specific_version) {
        (CORE_TYPE_ALPHA, _) => format!("{LEGACY_CORE_BINARY_FAMILY}-alpha{ext}"),
        (CORE_TYPE_SMART, _) => format!("{LEGACY_CORE_BINARY_FAMILY}-smart{ext}"),
        (CORE_TYPE_SPECIFIC, Some(version)) => {
            format!(
                "{LEGACY_CORE_BINARY_FAMILY}-{}{}",
                normalize_core_version(version),
                ext
            )
        }
        _ => format!("{LEGACY_CORE_BINARY_FAMILY}{ext}"),
    }
}

pub fn installed_core_identity(name: &str) -> Option<(&'static str, Option<String>)> {
    let lower = name.to_lowercase();
    let base = if cfg!(windows) {
        lower
            .ends_with(".exe")
            .then(|| name[..name.len().saturating_sub(4)].to_string())?
    } else {
        name.to_string()
    };

    let base_path = Path::new(&base);
    let base = base_path.file_name().and_then(|value| value.to_str())?;

    if !base.starts_with(LEGACY_CORE_BINARY_FAMILY) {
        return None;
    }

    match base {
        LEGACY_CORE_BINARY_FAMILY => Some((CORE_TYPE_STABLE, None)),
        "mihomo-alpha" => Some((CORE_TYPE_ALPHA, None)),
        "mihomo-smart" => Some((CORE_TYPE_SMART, None)),
        _ => base
            .strip_prefix("mihomo-")
            .map(str::trim)
            .filter(|version| !version.is_empty())
            .map(|version| (CORE_TYPE_SPECIFIC, Some(normalize_core_version(version)))),
    }
}

pub fn core_repo(core_type: &str) -> CoreRepo {
    match normalize_core_type(Some(core_type)) {
        CORE_TYPE_SMART => CoreRepo {
            owner: "vernesong",
            repo: "mihomo",
            release_tag: Some("Prerelease-Alpha"),
        },
        CORE_TYPE_ALPHA => CoreRepo {
            owner: "MetaCubeX",
            repo: "mihomo",
            release_tag: Some("Prerelease-Alpha"),
        },
        _ => CoreRepo {
            owner: "MetaCubeX",
            repo: "mihomo",
            release_tag: None,
        },
    }
}

pub fn is_stable_release_series(core_type: &str) -> bool {
    matches!(
        normalize_core_type(Some(core_type)),
        CORE_TYPE_STABLE | CORE_TYPE_SPECIFIC
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_file_names_preserve_current_mihomo_compatibility() {
        assert_eq!(
            managed_core_file_name(CORE_TYPE_STABLE, None),
            format!("mihomo{}", executable_ext())
        );
        assert_eq!(
            managed_core_file_name(CORE_TYPE_ALPHA, None),
            format!("mihomo-alpha{}", executable_ext())
        );
        assert_eq!(
            managed_core_file_name(CORE_TYPE_SMART, None),
            format!("mihomo-smart{}", executable_ext())
        );
        assert_eq!(
            managed_core_file_name(CORE_TYPE_SPECIFIC, Some("v1.2.3")),
            format!("mihomo-1.2.3{}", executable_ext())
        );
    }

    #[test]
    fn installed_core_identity_detects_managed_files() {
        assert_eq!(
            installed_core_identity(&format!("mihomo{}", executable_ext())),
            Some((CORE_TYPE_STABLE, None))
        );
        assert_eq!(
            installed_core_identity(&format!("mihomo-alpha{}", executable_ext())),
            Some((CORE_TYPE_ALPHA, None))
        );
        assert_eq!(
            installed_core_identity(&format!("mihomo-1.18.9{}", executable_ext())),
            Some((CORE_TYPE_SPECIFIC, Some("1.18.9".to_string())))
        );
    }

    #[test]
    fn repo_mapping_matches_current_sources() {
        assert_eq!(core_repo(CORE_TYPE_STABLE).owner, "MetaCubeX");
        assert_eq!(
            core_repo(CORE_TYPE_ALPHA).release_tag,
            Some("Prerelease-Alpha")
        );
        assert_eq!(core_repo(CORE_TYPE_SMART).owner, "vernesong");
    }

    #[test]
    fn product_identity_declares_flyclash_boundary_and_legacy_compatibility() {
        let identity = product_identity();

        assert_eq!(identity.product_name, "FlyClash Core");
        assert_eq!(identity.binary_family, "flyclash-mihomo");
        assert_eq!(identity.legacy_binary_family, "mihomo");
    }
}
