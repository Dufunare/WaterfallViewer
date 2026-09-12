mod ipc;

use ipc::{cancel_scan, start_scan, ScanRegistry};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ScanRegistry::default())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![start_scan, cancel_scan])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
