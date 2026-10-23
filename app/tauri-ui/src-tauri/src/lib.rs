//! FatFish desktop shell (Tauri 2). Key never logged or returned in full.
use serde::Serialize;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Serialize)]
struct AppStatus {
    key_saved: bool,
    settings_reachable: bool,
    login_reachable: bool,
    settings_port: u16,
    login_port: u16,
    appdata: String,
}

#[derive(Serialize)]
struct SaveKeyResult {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'static str>,
}

#[derive(Serialize)]
struct Ports {
    settings_port: u16,
    login_port: u16,
    login_url: String,
}

fn resolve_app_data_root() -> PathBuf {
    if let Ok(p) = std::env::var("FATFISH_APPDATA") {
        return PathBuf::from(p);
    }
    if let Ok(p) = std::env::var("APPDATA") {
        return PathBuf::from(p).join("FatFish");
    }
    // Linux / box: mimic Windows AppData layout under XDG or home
    if let Ok(p) = std::env::var("XDG_DATA_HOME") {
        return PathBuf::from(p).join("FatFish");
    }
    dirs_next_home()
        .map(|h| h.join(".local").join("share").join("FatFish"))
        .unwrap_or_else(|| PathBuf::from(".fatfish"))
}

fn dirs_next_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn key_path(root: &Path) -> PathBuf {
    root.join("secrets").join("deepseek_api_key")
}

fn config_path(root: &Path) -> PathBuf {
    root.join("config.json")
}

fn read_ports(root: &Path) -> (u16, u16) {
    let mut settings = 8787u16;
    let mut login = 6099u16;
    let cp = config_path(root);
    if let Ok(raw) = fs::read_to_string(&cp) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(n) = v.get("settings_port").and_then(|x| x.as_u64()) {
                settings = n as u16;
            }
            if let Some(n) = v.get("login_ui_port").and_then(|x| x.as_u64()) {
                login = n as u16;
            }
        }
    }
    if let Ok(p) = std::env::var("FATFISH_SETTINGS_PORT") {
        if let Ok(n) = p.parse::<u16>() {
            settings = n;
        }
    }
    if let Ok(p) = std::env::var("FATFISH_LOGIN_PORT") {
        if let Ok(n) = p.parse::<u16>() {
            login = n;
        }
    }
    (settings, login)
}

fn key_is_saved(root: &Path) -> bool {
    let p = key_path(root);
    fs::read_to_string(&p)
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
}

/// Minimal HTTP GET to 127.0.0.1 — returns true if status line starts with HTTP/ and connection works.
fn http_get_ok(port: u16, path: &str) -> bool {
    let addr = format!("127.0.0.1:{port}");
    let Ok(mut stream) = TcpStream::connect_timeout(
        &addr.parse().unwrap_or_else(|_| "127.0.0.1:1".parse().unwrap()),
        Duration::from_millis(800),
    ) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(800)));
    let req = format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 256];
    match stream.read(&mut buf) {
        Ok(n) if n > 0 => {
            let s = String::from_utf8_lossy(&buf[..n]);
            s.starts_with("HTTP/1.") && (s.contains(" 200 ") || s.contains(" 204 ") || s.contains(" 301 ") || s.contains(" 302 ") || s.contains(" 304 ") || s.contains(" 404 "))
        }
        _ => false,
    }
}

fn tcp_reachable(port: u16) -> bool {
    let addr = format!("127.0.0.1:{port}");
    TcpStream::connect_timeout(
        &addr.parse().unwrap_or_else(|_| "127.0.0.1:1".parse().unwrap()),
        Duration::from_millis(600),
    )
    .is_ok()
}

#[tauri::command]
fn get_status() -> AppStatus {
    let root = resolve_app_data_root();
    let (settings_port, login_port) = read_ports(&root);
    let settings_reachable =
        http_get_ok(settings_port, "/api/status") || tcp_reachable(settings_port);
    let login_reachable = http_get_ok(login_port, "/") || tcp_reachable(login_port);
    AppStatus {
        key_saved: key_is_saved(&root),
        settings_reachable,
        login_reachable,
        settings_port,
        login_port,
        appdata: root.display().to_string(),
    }
}

#[tauri::command]
fn get_ports() -> Ports {
    let root = resolve_app_data_root();
    let (settings_port, login_port) = read_ports(&root);
    Ports {
        settings_port,
        login_port,
        login_url: format!("http://127.0.0.1:{login_port}/webui/"),
    }
}

#[tauri::command]
fn save_api_key(key: String) -> SaveKeyResult {
    let key = key.trim().to_string();
    if key.is_empty() {
        return SaveKeyResult {
            ok: false,
            error: Some("empty_key"),
        };
    }
    let root = resolve_app_data_root();
    let secrets = root.join("secrets");
    if let Err(_) = fs::create_dir_all(&secrets) {
        return SaveKeyResult {
            ok: false,
            error: Some("mkdir_failed"),
        };
    }
    let path = key_path(&root);
    // Never log the key value.
    match fs::write(&path, format!("{key}\n")) {
        Ok(()) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
            }
            // Also try local-server API (best-effort); ignore failures.
            let (settings_port, _) = read_ports(&root);
            let _ = post_save_key_http(settings_port, &key);
            SaveKeyResult {
                ok: true,
                error: None,
            }
        }
        Err(_) => SaveKeyResult {
            ok: false,
            error: Some("save_failed"),
        },
    }
}

fn post_save_key_http(port: u16, key: &str) -> bool {
    let addr = format!("127.0.0.1:{port}");
    let Ok(mut stream) = TcpStream::connect_timeout(
        &addr.parse().unwrap_or_else(|_| "127.0.0.1:1".parse().unwrap()),
        Duration::from_millis(800),
    ) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    let body = serde_json::json!({ "key": key }).to_string();
    let req = format!(
        "POST /api/save-key HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(req.as_bytes()).is_ok()
}

#[tauri::command]
fn risk_accepted_path() -> String {
    resolve_app_data_root()
        .join("runtime")
        .join("risk_ok")
        .display()
        .to_string()
}

#[tauri::command]
fn is_risk_accepted() -> bool {
    let p = resolve_app_data_root().join("runtime").join("risk_ok");
    fs::read_to_string(&p).map(|s| s.trim() == "1").unwrap_or(false)
}

#[tauri::command]
fn accept_risk() -> bool {
    let root = resolve_app_data_root();
    let runtime = root.join("runtime");
    if fs::create_dir_all(&runtime).is_err() {
        return false;
    }
    fs::write(runtime.join("risk_ok"), "1\n").is_ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_status,
            get_ports,
            save_api_key,
            is_risk_accepted,
            accept_risk,
            risk_accepted_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
