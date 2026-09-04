fn main() {
    // Declaring an app manifest makes the shell's own commands ACL-gated, which
    // is what the boot screen needs: the window later navigates to
    // http://127.0.0.1:<port>, an origin Tauri treats as remote, and a remote
    // origin can only invoke a command a capability grants. The list must stay
    // in lockstep with `tauri::generate_handler![]` in src/lib.rs — a name
    // missing here breaks that command everywhere, not just remotely.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "boot_status",
                "retry_service",
                "skip_service",
                "reveal_logs",
            ]),
        ),
    )
    .expect("failed to run tauri-build");
}
