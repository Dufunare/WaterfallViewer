#[tauri::command]
fn hello_from_rust() -> String {
    "Hello from Rust! 前后端链路已经打通。".to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![hello_from_rust])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
