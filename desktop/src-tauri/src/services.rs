//! What the shell supervises, and the environment each child is handed.
//!
//! A desktop app launched from Finder inherits a bare environment — no shell
//! profile, no PATH the developer stack assumes — so nothing here is resolved
//! from PATH by accident and every child gets an explicit env block. The names
//! are the ones `scripts/hivemind-studio-stack` already passes, so the packaged
//! app and the developer stack describe the same process tree.
//!
//! ComfyUI is deliberately absent. Its lanes are the user's own checkout: the
//! shell probes them, reports what answered, and never spawns or kills one.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::ports::loopback_origin;

/// Documented ports. Preferred, never forced: a port already answering its own
/// health check is a process to attach to, not one to evict.
pub const GATEWAY_PORT: u16 = 8787;
/// The one Node child's own port. It mounts the Canvas surface, the local model
/// bridge and the agent MCP behind `/canvas`, `/bridge` and `/agent`, and
/// answers for all three on `/healthz` — so the shell waits on one thing.
pub const NODE_SERVICES_PORT: u16 = 8793;
/// The three numbers those surfaces used to have a process each on. The
/// collapsed service keeps them answering, because the frontend, the MCP client
/// config and any running instance all address them by number; retiring one is
/// a separate decision.
pub const CANVAS_PORT: u16 = 8788;
pub const BRIDGE_PORT: u16 = 8794;
pub const MCP_PORT: u16 = 8796;
/// Attach-only, never spawned, never signalled.
pub const COMFY_DEFAULT_LANE_PORT: u16 = 8188;
pub const COMFY_ANIMA_LANE_PORT: u16 = 8198;

/// Where the sidecar commands come from.
///
/// Every field is optional and every field has a development default that
/// points at this checkout's own interpreters. Bundling the runtimes and
/// writing this file into the app's resources is the packaging item's job; the
/// shell only has to read it.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ShellConfig {
    pub studio_root: Option<String>,
    pub python: Option<String>,
    pub node: Option<String>,
    pub frontend_dist: Option<String>,
    pub media_state_dir: Option<String>,
    pub comfy_lanes: Option<String>,
    /// Directories put in front of every child's `PATH`. The bundled static
    /// ffmpeg/ffprobe pair lives in one of them, and `doctor.py` and the engine
    /// reach for both with `shutil.which`.
    pub path_prepend: Vec<String>,
}

impl ShellConfig {
    /// Read `runtime.json` from the app's resource directory, then let the
    /// environment win over it — that is what makes `cargo tauri dev` against
    /// a checkout possible without a second config file.
    ///
    /// Paths in the file are relative to that resource directory, because the
    /// bundle does not know where it will be installed. Paths from the
    /// environment are taken exactly as given: those are a developer naming
    /// their own checkout.
    pub fn load(resource_dir: Option<&Path>) -> Self {
        let mut config = resource_dir
            .map(|dir| dir.join("runtime.json"))
            .filter(|path| path.is_file())
            .and_then(|path| std::fs::read_to_string(path).ok())
            .and_then(|raw| serde_json::from_str::<ShellConfig>(&raw).ok())
            .unwrap_or_default();
        if let Some(dir) = resource_dir {
            config.anchor_to(dir);
        }

        let take = |key: &str| std::env::var(key).ok().filter(|value| !value.trim().is_empty());
        if let Some(value) = take("HIVEMIND_STUDIO_ROOT") {
            config.studio_root = Some(value);
        }
        if let Some(value) = take("HIVEMIND_STUDIO_PYTHON") {
            config.python = Some(value);
        }
        if let Some(value) = take("HIVEMIND_STUDIO_NODE") {
            config.node = Some(value);
        }
        if let Some(value) = take("CONTENT_STUDIO_FRONTEND_DIST") {
            config.frontend_dist = Some(value);
        }
        if let Some(value) = take("HIVEMIND_MEDIA_STATE_DIR") {
            config.media_state_dir = Some(value);
        }
        if let Some(value) = take("COMFY_LANES") {
            config.comfy_lanes = Some(value);
        }
        config
    }

    /// Make every relative path in the file absolute, against the directory the
    /// file came from.
    ///
    /// `runtime.json` is written by `scripts/stage_desktop_resources.py` and
    /// says `desktop-python/venv/bin/python`, not an absolute path: the bundle
    /// is built on a runner and installed wherever the user drops it. A
    /// relative program would be resolved against the process's cwd, which for
    /// a Finder launch is `/`.
    fn anchor_to(&mut self, resource_dir: &Path) {
        let anchor = |value: &mut Option<String>| {
            if let Some(current) = value.as_ref() {
                let path = Path::new(current);
                if path.is_relative() {
                    *value = Some(resource_dir.join(path).display().to_string());
                }
            }
        };
        anchor(&mut self.studio_root);
        anchor(&mut self.python);
        anchor(&mut self.node);
        anchor(&mut self.frontend_dist);
        anchor(&mut self.media_state_dir);
        for entry in &mut self.path_prepend {
            let path = Path::new(entry.as_str());
            if path.is_relative() {
                *entry = resource_dir.join(path).display().to_string();
            }
        }
    }
}

/// Everything the env blocks are built from: the resolved runtimes, the app's
/// own directories, the reserved ports and the keychain-held private secret.
#[derive(Debug, Clone)]
pub struct Layout {
    pub studio_root: PathBuf,
    pub python: PathBuf,
    pub node: PathBuf,
    pub frontend_dist: PathBuf,
    pub data_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub log_dir: PathBuf,
    pub media_state_dir: PathBuf,
    pub private_secret: String,
    pub control_port: u16,
    pub gateway_port: u16,
    pub node_services_port: u16,
    pub canvas_port: u16,
    pub bridge_port: u16,
    pub mcp_port: u16,
    pub comfy_lanes: String,
    /// Directories placed in front of every child's `PATH`.
    pub path_prepend: Vec<PathBuf>,
}

impl Layout {
    #[allow(clippy::too_many_arguments)]
    pub fn resolve(
        config: &ShellConfig,
        data_dir: PathBuf,
        cache_dir: PathBuf,
        log_dir: PathBuf,
        private_secret: String,
        control_port: u16,
    ) -> Self {
        let studio_root = config
            .studio_root
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        let python = config
            .python
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| studio_root.join(".venv/bin/python"));
        let node = config
            .node
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("node"));
        let frontend_dist = config
            .frontend_dist
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| studio_root.join("packages/open-generative-ai/dist"));
        // The private state root is adopted where it already is. The app is not
        // its owner and never relocates it into a per-app container.
        let media_state_dir = config
            .media_state_dir
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                home_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join(".hivemindos/media-studio")
            });
        let comfy_lanes = config.comfy_lanes.clone().unwrap_or_else(|| {
            format!(
                "default={},anima={}",
                loopback_origin(COMFY_DEFAULT_LANE_PORT),
                loopback_origin(COMFY_ANIMA_LANE_PORT)
            )
        });
        Self {
            studio_root,
            python,
            node,
            frontend_dist,
            data_dir,
            cache_dir,
            log_dir,
            media_state_dir,
            private_secret,
            control_port,
            gateway_port: GATEWAY_PORT,
            node_services_port: NODE_SERVICES_PORT,
            canvas_port: CANVAS_PORT,
            bridge_port: BRIDGE_PORT,
            mcp_port: MCP_PORT,
            comfy_lanes,
            path_prepend: config.path_prepend.iter().map(PathBuf::from).collect(),
        }
    }

    /// The `PATH` every child gets: the bundled directories first, then whatever
    /// the OS handed this process.
    ///
    /// The static ffmpeg/ffprobe pair ships in `desktop-python/bin`, and the
    /// engine resolves both with `shutil.which`. Without this the packaged app
    /// would carry them and still use whichever pair the user happens to have,
    /// or none at all — a Finder launch has no PATH worth the name.
    pub fn child_path(&self) -> Option<String> {
        if self.path_prepend.is_empty() {
            return None;
        }
        let mut parts: Vec<String> = self
            .path_prepend
            .iter()
            .map(|dir| dir.display().to_string())
            .collect();
        let inherited = std::env::var("PATH").unwrap_or_default();
        if inherited.trim().is_empty() {
            parts.push("/usr/bin:/bin:/usr/sbin:/sbin".to_string());
        } else {
            parts.push(inherited);
        }
        Some(parts.join(":"))
    }

    pub fn studio_origin(&self) -> String {
        loopback_origin(self.control_port)
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// How a service reports that it is up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HealthCheck {
    pub port: u16,
    pub path: String,
    /// The MCP endpoint answers a GET with 405 on purpose, so for it any HTTP
    /// answer is the readiness signal.
    pub any_http_answer: bool,
}

/// One supervised child: what to run, where, with which environment, and what
/// the boot screen may offer when it will not start.
#[derive(Debug, Clone)]
pub struct ServicePlan {
    pub id: String,
    pub label: String,
    /// A required service has no honest "Continue without it": the window has
    /// nothing to load without the control API.
    pub required: bool,
    /// What the boot screen says the studio loses while this one is missing.
    pub without_it: String,
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
    pub health: HealthCheck,
}

impl ServicePlan {
    pub fn log_file(&self, log_dir: &Path) -> PathBuf {
        log_dir.join(format!("{}.log", self.id))
    }
}

/// The three supervised children, in boot order.
pub fn service_plans(layout: &Layout) -> Vec<ServicePlan> {
    let gateway_dir = layout.studio_root.join("packages/media-gateway");
    let open_gen_dir = layout.studio_root.join("packages/open-generative-ai");
    let token_file = layout.media_state_dir.join("secure/zimg-token");
    let comfy_default = loopback_origin(COMFY_DEFAULT_LANE_PORT);

    let mut shared: BTreeMap<String, String> = BTreeMap::new();
    shared.insert(
        "HIVEMIND_STUDIO_ROOT".into(),
        layout.studio_root.display().to_string(),
    );
    shared.insert(
        "HIVEMIND_MEDIA_STATE_DIR".into(),
        layout.media_state_dir.display().to_string(),
    );
    shared.insert("ZIMG_TOKEN_FILE".into(), token_file.display().to_string());
    shared.insert("COMFY_LANES".into(), layout.comfy_lanes.clone());
    shared.insert("COMFY_HTTP_DEFAULT".into(), comfy_default.clone());
    // What the proxy and MCP layers use to reach the control API. Always
    // passed, because the port it names is only sometimes 8765.
    shared.insert("HIVEMIND_STUDIO_TARGET".into(), layout.studio_origin());
    // The bundled ffmpeg pair, in front of whatever the user has. Absent in a
    // developer checkout, where the OS PATH is the whole answer.
    if let Some(path) = layout.child_path() {
        shared.insert("PATH".into(), path);
    }

    let with = |extra: &[(&str, String)]| -> BTreeMap<String, String> {
        let mut env = shared.clone();
        for (key, value) in extra {
            env.insert((*key).to_string(), value.clone());
        }
        env
    };

    let mut control_env = with(&[
        ("CONTENT_STUDIO_CONTROL_HOST", "127.0.0.1".to_string()),
        (
            "CONTENT_STUDIO_CONTROL_PORT".into(),
            layout.control_port.to_string(),
        ),
        (
            "CONTENT_STUDIO_FRONTEND_DIST".into(),
            layout.frontend_dist.display().to_string(),
        ),
        (
            "CONTENT_STUDIO_DATA_DIR".into(),
            layout.data_dir.display().to_string(),
        ),
        (
            "CONTENT_STUDIO_CACHE_DIR".into(),
            layout.cache_dir.display().to_string(),
        ),
        (
            "CONTENT_STUDIO_LOG_DIR".into(),
            layout.log_dir.display().to_string(),
        ),
        // The at-rest key comes from the OS keychain and is handed over here,
        // so no key file sits in the same folder as the data it protects.
        (
            "CONTENT_STUDIO_PRIVATE_SECRET".into(),
            layout.private_secret.clone(),
        ),
        (
            "PYTHONPATH".into(),
            layout.studio_root.join("src").display().to_string(),
        ),
    ]);
    // A fallback port changes the document's origin, and an enrolled passkey is
    // bound to an origin. Pinning the list here — in the same step that chose
    // the port — is the only way the two cannot drift apart. On the documented
    // port the vars stay unset, so the accounts layer keeps its existing
    // request-origin behaviour and a tailnet-proxied request still verifies.
    if layout.control_port != crate::ports::PREFERRED_CONTROL_PORT {
        control_env.insert(
            "CONTENT_STUDIO_WEBAUTHN_ORIGINS".into(),
            layout.studio_origin(),
        );
        control_env.insert("CONTENT_STUDIO_WEBAUTHN_RP_ID".into(), "127.0.0.1".into());
    }

    vec![
        ServicePlan {
            id: "control-api".into(),
            label: "Studio server".into(),
            required: true,
            without_it: "The studio window has nothing to open.".into(),
            program: layout.python.clone(),
            args: vec!["-m".into(), "hivemind_content_studio.control_api".into()],
            cwd: layout.studio_root.clone(),
            env: control_env,
            health: HealthCheck {
                port: layout.control_port,
                path: "/readyz".into(),
                any_http_answer: false,
            },
        },
        ServicePlan {
            id: "media-gateway".into(),
            label: "Media engine".into(),
            required: false,
            without_it: "Local image and video generation stays unavailable; hosted and rented lanes still work.".into(),
            program: layout.python.clone(),
            args: vec!["app.py".into()],
            cwd: gateway_dir.clone(),
            env: with(&[
                ("ZIMG_PORT", layout.gateway_port.to_string()),
                ("COMFY_HTTP", comfy_default.clone()),
            ]),
            health: HealthCheck {
                port: layout.gateway_port,
                path: "/health".into(),
                any_http_answer: false,
            },
        },
        // One Node child for the three Node surfaces. It serves them on its own
        // port behind `/canvas`, `/bridge` and `/agent`, and keeps 8788, 8794
        // and 8796 answering unprefixed so nothing that addresses them by
        // number has to change. `/healthz` on its own port speaks for all three,
        // which is why the shell waits on one thing here and not three.
        ServicePlan {
            id: "node-services".into(),
            label: "Canvas, model bridge and agent bridge".into(),
            required: false,
            without_it:
                "The Canvas panel stays empty, downloaded models cannot run locally, and agents cannot drive the studio. Every other studio tab works."
                    .into(),
            program: layout.node.clone(),
            args: vec!["node-services.mjs".into()],
            cwd: gateway_dir,
            env: with(&[
                (
                    "HIVEMIND_NODE_SERVICES_HOST".into(),
                    "127.0.0.1".to_string(),
                ),
                (
                    "HIVEMIND_NODE_SERVICES_PORT".into(),
                    layout.node_services_port.to_string(),
                ),
                ("NODE_ENV", "production".to_string()),
                ("HOST", "127.0.0.1".to_string()),
                ("PORT", layout.canvas_port.to_string()),
                ("COMFY_HTTP", comfy_default.clone()),
                (
                    "COMFY_MOBILE_DIST".into(),
                    layout
                        .studio_root
                        .join("packages/comfyui-mobile/dist")
                        .display()
                        .to_string(),
                ),
                ("OGA_HOST", "127.0.0.1".to_string()),
                ("OGA_PORT", layout.bridge_port.to_string()),
                ("ZIMAGE_TOKEN_FILE", token_file.display().to_string()),
                ("MEDIA_STUDIO_MCP_HOST", "127.0.0.1".to_string()),
                ("MEDIA_STUDIO_MCP_PORT", layout.mcp_port.to_string()),
                (
                    "MEDIA_STUDIO_MCP_BACKEND_URL".into(),
                    loopback_origin(layout.gateway_port),
                ),
                (
                    "MEDIA_STUDIO_MCP_STUDIO_URL".into(),
                    loopback_origin(layout.canvas_port),
                ),
                (
                    "MEDIA_STUDIO_TOKEN_FILE".into(),
                    token_file.display().to_string(),
                ),
            ]),
            health: HealthCheck {
                port: layout.node_services_port,
                // A real answer, not "anything HTTP": this endpoint is 200 only
                // when all three surfaces came up, and names the one that did
                // not when they did not.
                path: "/healthz".into(),
                any_http_answer: false,
            },
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout_with_port(control_port: u16) -> Layout {
        Layout::resolve(
            &ShellConfig {
                studio_root: Some("/opt/studio".into()),
                python: Some("/opt/studio/.venv/bin/python".into()),
                node: Some("/opt/studio/runtime/node".into()),
                frontend_dist: Some("/opt/studio/dist".into()),
                media_state_dir: Some("/home/person/.hivemindos/media-studio".into()),
                comfy_lanes: None,
                path_prepend: vec!["/opt/studio/runtime/bin".into()],
            },
            PathBuf::from("/data"),
            PathBuf::from("/cache"),
            PathBuf::from("/logs"),
            "a-secret".into(),
            control_port,
        )
    }

    fn plan<'a>(plans: &'a [ServicePlan], id: &str) -> &'a ServicePlan {
        plans.iter().find(|plan| plan.id == id).expect("plan")
    }

    #[test]
    fn comfyui_is_never_a_supervised_child() {
        let plans = service_plans(&layout_with_port(8765));
        assert!(plans.iter().all(|plan| !plan.id.contains("comfy")));
        // It is still described to the control API, which probes it.
        let control = plan(&plans, "control-api");
        assert!(control.env["COMFY_LANES"].contains("8188"));
    }

    #[test]
    fn the_control_api_is_the_only_service_without_an_honest_continue_without_it() {
        let plans = service_plans(&layout_with_port(8765));
        let required: Vec<&str> = plans
            .iter()
            .filter(|plan| plan.required)
            .map(|plan| plan.id.as_str())
            .collect();
        assert_eq!(required, vec!["control-api"]);
        assert!(plans.iter().all(|plan| !plan.without_it.is_empty()));
    }

    #[test]
    fn the_documented_port_leaves_the_passkey_origin_alone() {
        let plans = service_plans(&layout_with_port(8765));
        let control = plan(&plans, "control-api");
        assert!(!control.env.contains_key("CONTENT_STUDIO_WEBAUTHN_ORIGINS"));
        assert_eq!(control.env["HIVEMIND_STUDIO_TARGET"], "http://127.0.0.1:8765");
    }

    #[test]
    fn a_fallback_port_rewrites_the_passkey_origin_in_the_same_step() {
        let plans = service_plans(&layout_with_port(8771));
        let control = plan(&plans, "control-api");
        assert_eq!(
            control.env["CONTENT_STUDIO_WEBAUTHN_ORIGINS"],
            "http://127.0.0.1:8771"
        );
        assert_eq!(control.env["CONTENT_STUDIO_WEBAUTHN_RP_ID"], "127.0.0.1");
        assert_eq!(control.env["HIVEMIND_STUDIO_TARGET"], "http://127.0.0.1:8771");
        assert_eq!(control.env["CONTENT_STUDIO_CONTROL_PORT"], "8771");
    }

    #[test]
    fn the_private_secret_reaches_the_control_api_and_nothing_else() {
        let plans = service_plans(&layout_with_port(8765));
        let carrying: Vec<&str> = plans
            .iter()
            .filter(|plan| plan.env.contains_key("CONTENT_STUDIO_PRIVATE_SECRET"))
            .map(|plan| plan.id.as_str())
            .collect();
        assert_eq!(carrying, vec!["control-api"]);
    }

    #[test]
    fn every_child_is_handed_the_apps_own_directories() {
        let plans = service_plans(&layout_with_port(8765));
        let control = plan(&plans, "control-api");
        assert_eq!(control.env["CONTENT_STUDIO_DATA_DIR"], "/data");
        assert_eq!(control.env["CONTENT_STUDIO_CACHE_DIR"], "/cache");
        assert_eq!(control.env["CONTENT_STUDIO_LOG_DIR"], "/logs");
        for plan in &plans {
            assert_eq!(
                plan.env["HIVEMIND_MEDIA_STATE_DIR"],
                "/home/person/.hivemindos/media-studio",
                "{} must adopt the private state root in place",
                plan.id
            );
        }
    }

    #[test]
    fn no_child_is_resolved_from_path_by_accident() {
        let plans = service_plans(&layout_with_port(8765));
        for plan in &plans {
            assert!(
                plan.program.is_absolute(),
                "{} would be looked up on PATH, which a Finder launch does not have",
                plan.id
            );
        }
    }

    #[test]
    fn every_child_reports_readiness_with_a_real_health_answer() {
        // The agent MCP used to be probed with "any HTTP answer" because it
        // refuses a GET on purpose. Folded into the collapsed Node service, it
        // is covered by that service's own /healthz, so nothing is waiting on a
        // 405 any more.
        let plans = service_plans(&layout_with_port(8765));
        assert!(plans.iter().all(|plan| !plan.health.any_http_answer));
    }

    #[test]
    fn the_three_node_surfaces_are_one_child_that_keeps_the_old_ports() {
        let plans = service_plans(&layout_with_port(8765));
        let node_ids: Vec<&str> = plans
            .iter()
            .filter(|plan| plan.args.iter().any(|arg| arg.ends_with(".js") || arg.ends_with(".mjs")))
            .map(|plan| plan.id.as_str())
            .collect();
        assert_eq!(node_ids, vec!["node-services"]);

        let node = plan(&plans, "node-services");
        assert_eq!(node.health.port, NODE_SERVICES_PORT);
        assert_eq!(node.health.path, "/healthz");
        // The old numbers still reach the collapsed service, so the frontend,
        // the MCP client config and a running instance keep working.
        assert_eq!(node.env["PORT"], CANVAS_PORT.to_string());
        assert_eq!(node.env["OGA_PORT"], BRIDGE_PORT.to_string());
        assert_eq!(node.env["MEDIA_STUDIO_MCP_PORT"], MCP_PORT.to_string());
    }

    #[test]
    fn config_defaults_point_at_the_checkouts_own_interpreters() {
        let layout = Layout::resolve(
            &ShellConfig {
                studio_root: Some("/checkout".into()),
                ..ShellConfig::default()
            },
            PathBuf::from("/data"),
            PathBuf::from("/cache"),
            PathBuf::from("/logs"),
            "secret".into(),
            8765,
        );
        assert_eq!(layout.python, PathBuf::from("/checkout/.venv/bin/python"));
        assert_eq!(
            layout.frontend_dist,
            PathBuf::from("/checkout/packages/open-generative-ai/dist")
        );
    }

    /// The packaged app's `runtime.json` names its runtimes relative to the
    /// resource directory, because the bundle does not know where it will be
    /// installed. A relative program is resolved against the process cwd, which
    /// for a Finder launch is `/` — the exact way the bundled interpreter would
    /// be missed while sitting inside the .app.
    #[test]
    fn a_bundled_runtime_json_is_read_relative_to_the_resources_it_ships_with() {
        let resources = std::env::temp_dir().join(format!(
            "studio-runtime-{}-{}",
            std::process::id(),
            line!()
        ));
        std::fs::create_dir_all(&resources).expect("temp resources");
        std::fs::write(
            resources.join("runtime.json"),
            r#"{
              "staged": true,
              "studioRoot": "studio",
              "python": "desktop-python/venv/bin/python",
              "node": "node/node",
              "frontendDist": "studio/packages/open-generative-ai/dist",
              "pathPrepend": ["desktop-python/bin"]
            }"#,
        )
        .expect("write runtime.json");

        let config = ShellConfig::load(Some(&resources));
        std::fs::remove_dir_all(&resources).ok();

        for value in [&config.studio_root, &config.python, &config.node, &config.frontend_dist] {
            let path = PathBuf::from(value.as_ref().expect("named in runtime.json"));
            assert!(path.is_absolute(), "{} was left relative", path.display());
            assert!(path.starts_with(&resources), "{} left the bundle", path.display());
        }
        assert_eq!(
            config.python,
            Some(
                resources
                    .join("desktop-python/venv/bin/python")
                    .display()
                    .to_string()
            )
        );
        assert!(config.path_prepend[0].starts_with(resources.to_string_lossy().as_ref()));
        // Nothing in the file says where the user's private state root is, so
        // the shell keeps adopting it wherever they already have it.
        assert!(config.media_state_dir.is_none());
    }

    /// The bundle carries a static ffmpeg/ffprobe pair and the engine reaches
    /// for both with `shutil.which`. Carrying them and not putting them on the
    /// children's PATH would use whatever the user happens to have, or nothing.
    #[test]
    fn the_bundled_binaries_go_in_front_of_every_childs_path() {
        let plans = service_plans(&layout_with_port(8765));
        for plan in &plans {
            let path = plan.env.get("PATH").unwrap_or_else(|| {
                panic!("{} was not handed the bundled binaries", plan.id);
            });
            assert!(
                path.starts_with("/opt/studio/runtime/bin:"),
                "{} resolves ffmpeg from somewhere else first: {path}",
                plan.id
            );
            assert!(path.len() > "/opt/studio/runtime/bin:".len());
        }
    }

    /// A developer checkout stages nothing, so the OS PATH is the whole answer
    /// and the children must not be handed a truncated one.
    #[test]
    fn a_checkout_with_nothing_staged_leaves_the_path_alone() {
        let layout = Layout::resolve(
            &ShellConfig {
                studio_root: Some("/checkout".into()),
                ..ShellConfig::default()
            },
            PathBuf::from("/data"),
            PathBuf::from("/cache"),
            PathBuf::from("/logs"),
            "secret".into(),
            8765,
        );
        assert!(layout.child_path().is_none());
        assert!(service_plans(&layout)
            .iter()
            .all(|plan| !plan.env.contains_key("PATH")));
    }

    #[test]
    fn a_log_file_is_named_for_its_service() {
        let plans = service_plans(&layout_with_port(8765));
        assert_eq!(
            plan(&plans, "control-api").log_file(Path::new("/logs")),
            PathBuf::from("/logs/control-api.log")
        );
    }
}
