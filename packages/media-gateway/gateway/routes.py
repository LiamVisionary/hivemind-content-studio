"""The gateway's route table: (method, path pattern) -> Handler method.

This replaced a 1,100-line if-chain inside do_GET/do_POST/do_DELETE. The point
is not brevity - it is that the set of things this server answers is now data
one pass can read. A route-auth sweep, a doc generator or a test can walk
ROUTES; none of them could walk an if-chain.

Two rules the table keeps from the chain it replaced:

* Order is the contract. Matching runs top down, so `/api/restore/projects`
  stays above the `/api/restore/project/` prefix and keeps answering, and the
  broad `/comfy/` proxy stays below everything that claims a path under it.
* `auth` is per route, and only /health and /healthz are False. Everything
  else - including a path no route claims - is behind the token, so an
  unauthenticated caller cannot map the surface by reading 404s.

A handler returns whatever it sends. Returning NEXT means "not mine": matching
resumes at the following route, which is how /comfy/view serves a private
output when it has one and otherwise lets the ComfyUI proxy answer.
"""

# Handlers that decline. Anything else a handler returns ends the request.
NEXT = object()

# GET and POST fold in live lane attachments before dispatching; DELETE only
# ever reaches the ComfyUI proxy, which resolves its own lane.
REFRESHES_LANES = {"GET": True, "POST": True, "DELETE": False}


class Route:
    """One row of the table.

    `exact` is a tuple of whole paths; `prefixes` a tuple of path prefixes;
    `suffix`, when set, must also match (that is `/api/job/<id>/cancel`).
    """

    __slots__ = ("method", "exact", "prefixes", "suffix", "handler", "auth")

    def __init__(self, method, handler, *, exact=(), prefixes=(), suffix=None, auth=True):
        self.method = method
        self.handler = handler
        self.exact = tuple(exact)
        self.prefixes = tuple(prefixes)
        self.suffix = suffix
        self.auth = auth

    def matches(self, path):
        if self.suffix is not None and not path.endswith(self.suffix):
            return False
        if path in self.exact:
            return True
        return bool(self.prefixes) and path.startswith(self.prefixes)

    def __repr__(self):
        return f"<Route {self.method} {(self.exact + self.prefixes)[0]} -> {self.handler}>"


ROUTES = (
    # --- GET ---------------------------------------------------------------
    Route("GET", "get_health", exact=("/healthz", "/health"), auth=False),
    Route("GET", "get_workflow_key", exact=("/workflow-key",)),
    Route("GET", "get_api_e2e_vault_identity", exact=("/api/e2e/vault-identity",)),
    Route("GET", "get_workflow_for_output", exact=("/workflow-for-output",)),
    Route("GET", "get_ws", exact=("/ws",)),
    Route("GET", "get_frontend",
          exact=("/", "/history", "/models", "/workbench", "/favicon.ico"),
          prefixes=("/_next/",)),
    Route("GET", "get_api_models", exact=("/api/models",)),
    Route("GET", "get_api_library", exact=("/api/library",)),
    Route("GET", "get_api_model_preview", exact=("/api/model-preview",)),
    Route("GET", "get_api_loras_preview", exact=("/api/loras/preview",)),
    Route("GET", "get_api_loras", exact=("/api/loras",)),
    Route("GET", "get_api_civitai_lora_updates", exact=("/api/civitai/lora-updates",)),
    Route("GET", "get_api_civitai_base_models", exact=("/api/civitai/base-models",)),
    Route("GET", "get_api_civitai_images", exact=("/api/civitai/images",)),
    Route("GET", "get_api_civitai_search", exact=("/api/civitai/search",)),
    Route("GET", "get_api_civitai_download", prefixes=("/api/civitai/download/",)),
    Route("GET", "get_api_comfy_prompt_by_client", prefixes=("/api/comfy/prompt-by-client/",)),
    # Serves a private output when the name is one of ours, and otherwise
    # returns NEXT so the /comfy/ proxy four rows down answers instead.
    Route("GET", "get_comfy_view", exact=("/comfy/view", "/view")),
    Route("GET", "get_output", exact=("/output",)),
    Route("GET", "get_mobile_app", exact=("/mobile", "/mobile/"),
          prefixes=("/mobile/", "/assets/", "/comfy/")),
    Route("GET", "get_api_restore_projects", exact=("/api/restore/projects",)),
    Route("GET", "get_api_restore_capabilities", exact=("/api/restore/capabilities",)),
    Route("GET", "get_api_restore_project", prefixes=("/api/restore/project/",)),
    Route("GET", "get_api_restore_source", prefixes=("/api/restore/source/",)),
    Route("GET", "get_api_history", exact=("/api/history",)),
    Route("GET", "get_api_job", prefixes=("/api/job/",)),
    Route("GET", "get_job", prefixes=("/job/",)),
    Route("GET", "get_image", prefixes=("/image/",)),

    # --- POST --------------------------------------------------------------
    Route("POST", "post_job_cancel", prefixes=("/api/job/",), suffix="/cancel"),
    Route("POST", "post_api_cancel", prefixes=("/api/cancel/",)),
    Route("POST", "post_api_delete_output", exact=("/api/delete-output",)),
    Route("POST", "post_api_lanes_resolve", exact=("/api/lanes/resolve",)),
    Route("POST", "post_api_delete_input", exact=("/api/delete-input",)),
    Route("POST", "post_api_interpolate", exact=("/api/interpolate",)),
    Route("POST", "post_api_smart_mask", exact=("/api/smart-mask",)),
    Route("POST", "post_api_ltx_director", exact=("/api/ltx-director",)),
    Route("POST", "post_api_episode", exact=("/api/episode",)),
    Route("POST", "post_api_upscale", exact=("/api/upscale",)),
    Route("POST", "post_api_restore_upload", exact=("/api/restore/upload",)),
    Route("POST", "post_api_restore", exact=("/api/restore",)),
    Route("POST", "post_api_restore_plan", exact=("/api/restore/plan",)),
    Route("POST", "post_api_restore_finish", exact=("/api/restore/finish",)),
    Route("POST", "post_api_restore_cancel", prefixes=("/api/restore/cancel/",)),
    Route("POST", "post_api_restore_delete", prefixes=("/api/restore/delete/",)),
    Route("POST", "post_api_models_equip_or_unequip",
          exact=("/api/models/equip", "/api/models/unequip")),
    Route("POST", "post_api_loras_select", exact=("/api/loras/select",)),
    Route("POST", "post_api_civitai_download", exact=("/api/civitai/download",)),
    Route("POST", "post_api_civitai_cancel_download", prefixes=("/api/civitai/cancel-download/",)),
    Route("POST", "post_comfy", prefixes=("/comfy/", "/mobile/")),
    Route("POST", "post_generate", exact=("/generate", "/api/generate")),

    # --- DELETE ------------------------------------------------------------
    Route("DELETE", "delete_comfy", prefixes=("/comfy/", "/mobile/")),
)


def match(method, path, start=0):
    """(index, route) for the first row at or after `start` that claims `path`."""
    for index in range(start, len(ROUTES)):
        route = ROUTES[index]
        if route.method == method and route.matches(path):
            return index, route
    return len(ROUTES), None


def unauthorized(handler, method):
    if method == "GET":
        return handler.send_text(
            "Unauthorized. Add ?token=... or Authorization: Bearer ***", 401, "text/plain")
    return handler.send_json({"error": "unauthorized"}, 401)


def not_found(handler, method):
    if method == "GET":
        return handler.send_text("not found\n", 404, "text/plain")
    return handler.send_json({"error": "not found"}, 404)
