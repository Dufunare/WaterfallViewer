mod ipc;
mod media_resource;

use ipc::{cancel_scan, request_thumbnail, start_scan, ScanRegistry};
use media_resource::{respond_to_media_request, MediaResourceRegistry, MEDIA_PROTOCOL};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let resources = MediaResourceRegistry::default();
    let protocol_resources = resources.clone();

    tauri::Builder::default()
        .manage(ScanRegistry::default())
        .manage(resources)
        .register_asynchronous_uri_scheme_protocol(
            MEDIA_PROTOCOL,
            move |_context, request, responder| {
                let registry = protocol_resources.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    responder.respond(respond_to_media_request(registry, request));
                });
            },
        )
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            start_scan,
            cancel_scan,
            request_thumbnail
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
