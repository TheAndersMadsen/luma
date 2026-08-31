use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::State;
use axum::Json;
use serde::Serialize;
use tokio::process::Command;
use tracing::error;

use super::ApiState;
const HUMANE_DISPLAY_VERSION_SETTING: &str = "penumbra.humane_display_version";

#[derive(Clone, Serialize)]
pub struct ComponentVersion {
    role: &'static str,
    label: &'static str,
    package_name: &'static str,
    version_name: Option<String>,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct OsVersionInfo {
    humane_display_version: Option<String>,
    android_release: Option<String>,
    android_sdk: Option<String>,
    security_patch: Option<String>,
}

impl OsVersionInfo {
    async fn collect() -> Self {
        OsVersionInfo {
            humane_display_version: get_global_setting(HUMANE_DISPLAY_VERSION_SETTING).await,
            android_release: getprop("ro.build.version.release").await,
            android_sdk: getprop("ro.build.version.sdk").await,
            security_patch: getprop("ro.build.version.security_patch").await,
        }
    }
}

impl DeviceVersionSnapshot {
    pub(crate) fn exact_runtime_release(&self) -> Option<&str> {
        const RUNTIME_ROLES: [&str; 3] = ["hook", "server", "injector"];
        let version = self.runtime_server_version;
        RUNTIME_ROLES.iter().all(|role| {
            self.components.iter().filter(|component| component.role == *role).count() == 1
                && self.components.iter().any(|component| {
                    component.role == *role
                        && component.error.is_none()
                        && component.version_name.as_deref() == Some(version)
                })
        }).then_some(version)
    }
}

#[derive(Clone, Serialize)]
pub struct DeviceVersionSnapshot {
    captured_at_ms: u128,
    runtime_server_version: &'static str,
    components: Vec<ComponentVersion>,
    os: OsVersionInfo,
}

#[derive(Clone, Copy)]
struct ManagedComponent {
    role: &'static str,
    label: &'static str,
    package_name: &'static str,
}

pub struct DeviceVersionCollector;

impl DeviceVersionCollector {
    const MANAGED_COMPONENTS: &'static [ManagedComponent] = &[
        ManagedComponent {
            role: "installer",
            label: "System Injector",
            package_name: "com.penumbraos.systeminjector",
        },
        ManagedComponent {
            role: "hook",
            label: "Hook",
            package_name: "com.penumbraos.hook",
        },
        ManagedComponent {
            role: "server",
            label: "Server",
            package_name: "com.penumbraos.server",
        },
        ManagedComponent {
            role: "injector",
            label: "Hook Injector",
            package_name: "com.penumbraos.hook.injector",
        },
    ];

    pub async fn collect() -> DeviceVersionSnapshot {
        let captured_at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or_default();

        let mut components = Vec::with_capacity(Self::MANAGED_COMPONENTS.len());
        for component in Self::MANAGED_COMPONENTS {
            if let Some(version) = Self::query_component_version(component).await {
                components.push(version);
            }
        }

        DeviceVersionSnapshot {
            captured_at_ms,
            runtime_server_version: env!("PENUMBRA_VERSION"),
            components,
            os: OsVersionInfo::collect().await,
        }
    }

    async fn query_component_version(component: &ManagedComponent) -> Option<ComponentVersion> {
        #[cfg(not(target_os = "android"))]
        {
            Some(ComponentVersion {
                role: component.role,
                label: component.label,
                package_name: component.package_name,
                version_name: None,
                error: Some("package metadata is only available on Android".to_string()),
            })
        }

        #[cfg(target_os = "android")]
        {
            let installed = run_command(
                "/system/bin/pm",
                &["list", "packages", component.package_name],
            )
            .await
            .map(|output| {
                output
                    .lines()
                    .any(|line| line.trim() == format!("package:{}", component.package_name))
            })
            .unwrap_or(false);

            if !installed {
                return None;
            }

            match run_command("/system/bin/dumpsys", &["package", component.package_name]).await {
                Ok(output) => Some(ComponentVersion {
                    role: component.role,
                    label: component.label,
                    package_name: component.package_name,
                    version_name: parse_dumpsys_field(&output, "versionName"),
                    error: None,
                }),
                Err(error) => Some(ComponentVersion {
                    role: component.role,
                    label: component.label,
                    package_name: component.package_name,
                    version_name: None,
                    error: Some(error),
                }),
            }
        }
    }
}

#[derive(Serialize)]
pub struct DeviceInfo {
    display_name: String,
    http_bind_addr: String,
    grpc_bind_addr: String,
    versions: DeviceVersionSnapshot,
}

pub struct DeviceApi;

impl DeviceApi {
    pub async fn get_device(State(state): State<ApiState>) -> Json<DeviceInfo> {
        let (display_name, http_bind_addr, grpc_bind_addr) = {
            let config = state.shared_config.read().await;
            (
                config
                    .server
                    .display_name
                    .clone()
                    .unwrap_or_else(|| "Ai Pin Revival".into()),
                config.server.http_bind_addr.clone(),
                config.server.grpc_bind_addr.clone(),
            )
        };

        let mut versions = state.device_versions.clone();
        versions.os.humane_display_version =
            get_global_setting(HUMANE_DISPLAY_VERSION_SETTING).await;

        Json(DeviceInfo {
            display_name,
            http_bind_addr,
            grpc_bind_addr,
            versions,
        })
    }
}

#[cfg(target_os = "android")]
fn parse_dumpsys_field(output: &str, field: &str) -> Option<String> {
    output.split_whitespace().find_map(|token| {
        token
            .strip_prefix(field)
            .and_then(|value| value.strip_prefix('='))
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

#[allow(unused_variables)]
pub(crate) async fn getprop(name: &str) -> Option<String> {
    #[cfg(not(target_os = "android"))]
    {
        return None;
    }

    #[allow(unused)]
    match run_command("/system/bin/getprop", &[name]).await {
        Ok(result) => non_empty_value(&result),
        Err(e) => {
            error!("getprop {name} failed: {e}");
            None
        }
    }
}

#[allow(unused_variables)]
pub(crate) async fn get_global_setting(name: &str) -> Option<String> {
    #[cfg(not(target_os = "android"))]
    {
        return None;
    }

    #[allow(unused)]
    match run_command("/system/bin/settings", &["get", "global", name]).await {
        Ok(result) => non_empty_value(&result),
        Err(e) => {
            error!("settings get global {name} failed: {e}");
            None
        }
    }
}

fn non_empty_value(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed == "null" {
        None
    } else {
        Some(trimmed.to_string())
    }
}

async fn run_command(command: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(command)
        .args(args)
        .output()
        .await
        .map_err(|error| format!("failed to run {command}: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let message = if stderr.is_empty() { stdout } else { stderr };
        return Err(format!(
            "{command} exited with {}: {message}",
            output.status
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(versions: &[(&'static str, Option<&str>)]) -> DeviceVersionSnapshot {
        DeviceVersionSnapshot {
            captured_at_ms: 1,
            runtime_server_version: "2026-08-31.6",
            components: versions
                .iter()
                .map(|(role, version)| ComponentVersion {
                    role: *role,
                    label: *role,
                    package_name: *role,
                    version_name: version.map(str::to_owned),
                    error: version.is_none().then(|| "unreadable".to_owned()),
                })
                .collect(),
            os: OsVersionInfo {
                humane_display_version: None,
                android_release: None,
                android_sdk: None,
                security_patch: None,
            },
        }
    }

    #[test]
    fn exact_runtime_release_requires_one_matching_copy_of_every_runtime_role() {
        let exact = snapshot(&[
            ("installer", Some("2026-08-27.1")),
            ("hook", Some("2026-08-31.6")),
            ("server", Some("2026-08-31.6")),
            ("injector", Some("2026-08-31.6")),
        ]);
        assert_eq!(exact.exact_runtime_release(), Some("2026-08-31.6"));

        assert_eq!(
            snapshot(&[
                ("hook", Some("2026-08-31.6")),
                ("server", Some("2026-08-31.6")),
            ])
            .exact_runtime_release(),
            None,
        );
        assert_eq!(
            snapshot(&[
                ("hook", Some("2026-08-31.6")),
                ("server", Some("2026-08-31.5")),
                ("injector", Some("2026-08-31.6")),
            ])
            .exact_runtime_release(),
            None,
        );
    }
}
