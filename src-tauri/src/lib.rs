mod ipc;
mod local_source;
mod media_resource;
mod thumbnail_cache;

use ipc::{
    cancel_scan, pick_source_directory, release_representation, request_thumbnail, start_scan,
    ScanRegistry,
};
use local_source::LocalSourceRegistry;
use media_resource::{respond_to_media_request, MediaResourceRegistry, MEDIA_PROTOCOL};
use tauri::Manager;
use thumbnail_cache::ThumbnailCacheManager;
use waterfall_infra::SqliteVisualMetadataCache;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let resources = MediaResourceRegistry::default();
    let protocol_resources = resources.clone();

    tauri::Builder::default()
        .setup(|app| {
            let registry = match app.path().app_cache_dir() {
                Ok(cache_dir) => {
                    let database_path = cache_dir.join("visual-metadata-cache.sqlite3");
                    match SqliteVisualMetadataCache::open(database_path) {
                        Ok(cache) => ScanRegistry::with_visual_metadata_cache(cache),
                        Err(error) => {
                            eprintln!(
                                "failed to initialize persistent visual metadata cache; using memory cache: {error}"
                            );
                            ScanRegistry::default()
                        }
                    }
                }
                Err(error) => {
                    eprintln!(
                        "failed to resolve application cache directory; using memory cache: {error}"
                    );
                    ScanRegistry::default()
                }
            };
            app.manage(registry);
            Ok(())
        })
        .manage(LocalSourceRegistry::default())
        .manage(resources)
        .manage(ThumbnailCacheManager::default())
        .register_asynchronous_uri_scheme_protocol(
            MEDIA_PROTOCOL,
            move |_context, request, responder| {
                let registry = protocol_resources.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    responder.respond(respond_to_media_request(registry, request));
                });
            },
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            start_scan,
            cancel_scan,
            request_thumbnail,
            release_representation,
            pick_source_directory
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
