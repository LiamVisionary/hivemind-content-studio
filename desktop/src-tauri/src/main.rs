#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    hivemind_content_studio_desktop_lib::run(tauri::generate_context!())
}
