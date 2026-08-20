//! Tauri shell.
//!
//! The Rust side is deliberately thin: it owns the window and the lifecycle of
//! the Node core process, and nothing else. All domain logic, persistence and
//! MCP work lives in the TypeScript core so there is one implementation of the
//! rules rather than two.
//!
//! The core runs as a child process on 127.0.0.1 and the webview talks to it
//! over HTTP, which keeps the browser dev workflow and the packaged app on
//! identical code paths.

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::{Manager, RunEvent};

/// Handle to the sidecar so it can be killed when the window closes.
struct CoreProcess(Mutex<Option<Child>>);

/// Where the API listens. Kept in sync with `apps/server/src/index.ts`.
const API_PORT: u16 = 8787;

#[tauri::command]
fn api_base_url() -> String {
    format!("http://127.0.0.1:{API_PORT}")
}

/// Report whether the core answered, so the UI can show a real error instead of
/// a blank screen if the sidecar failed to start.
#[tauri::command]
async fn core_ready() -> bool {
    let url = format!("http://127.0.0.1:{API_PORT}/api/status");
    // A plain TCP connect is enough to know something is listening, and avoids
    // pulling an HTTP client into the shell.
    std::net::TcpStream::connect(("127.0.0.1", API_PORT)).is_ok() && !url.is_empty()
}

/// Launch the Node core. In dev the repo copy is used directly; in a bundled
/// app the compiled server ships in the resource directory.
fn spawn_core(app: &tauri::AppHandle) -> Option<Child> {
    let entry = resolve_core_entry(app)?;

    let mut child = Command::new("node")
        .arg(&entry)
        .env("WH_PORT", API_PORT.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| eprintln!("[core] failed to spawn node: {e}"))
        .ok()?;

    // Forward the core's logs to this process's console rather than dropping
    // them; a silent sidecar is very hard to debug.
    if let Some(out) = child.stdout.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                println!("[core] {line}");
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                eprintln!("[core] {line}");
            }
        });
    }

    Some(child)
}

fn resolve_core_entry(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    // Dev first. Tauri also copies the resource into target/debug during a dev
    // run, but that copy has no node_modules beside it, so the workspace tree
    // is the only one whose imports actually resolve while developing.
    let mut dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for _ in 0..4 {
        let candidate = dir.join("apps").join("server").join("dist").join("index.js");
        if candidate.exists() {
            return Some(candidate);
        }
        if !dir.pop() {
            break;
        }
    }

    // Packaged: a self-contained bundle shipped in the app's resources.
    if let Ok(dir) = app.path().resource_dir() {
        let bundled = dir.join("server").join("index.js");
        if bundled.exists() {
            return Some(bundled);
        }
    }

    eprintln!("[core] could not locate the server bundle — run `pnpm build` first");
    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(CoreProcess(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![api_base_url, core_ready])
        .setup(|app| {
            // Don't start a second core on an occupied port. A server may
            // already be running from `pnpm dev:server`, or left over from a
            // previous run; either way the existing one is the right one to
            // talk to, and spawning a rival just crashes on EADDRINUSE.
            let already_serving =
                std::net::TcpStream::connect(("127.0.0.1", API_PORT)).is_ok();

            if already_serving {
                println!("[core] reusing the server already on port {API_PORT}");
            } else if std::env::var("WH_EXTERNAL_CORE").is_err() {
                let handle = app.handle().clone();
                if let Some(child) = spawn_core(&handle) {
                    let state = app.state::<CoreProcess>();
                    *state.0.lock().unwrap() = Some(child);
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the application")
        .run(|app, event| {
            // Kill the sidecar on exit; an orphaned core would hold the port
            // and the SQLite WAL lock.
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                if let Some(mut child) = app.state::<CoreProcess>().0.lock().unwrap().take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}
