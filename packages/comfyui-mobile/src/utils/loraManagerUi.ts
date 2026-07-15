const DEFAULT_LORA_MANAGER_UI_PATH = "/?tab=models#models";
const INHERITED_QUERY_PARAMS = ["token"];
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

function toAllowedAbsoluteUrl(value: string): URL | null {
  try {
    const nextUrl = new URL(
      value,
      typeof window === "undefined" ? undefined : window.location.origin,
    );
    if (!ALLOWED_PROTOCOLS.has(nextUrl.protocol)) return null;
    return nextUrl;
  } catch {
    return null;
  }
}

function inheritSameOriginQueryParams(url: URL): URL {
  if (typeof window === "undefined" || url.origin !== window.location.origin) {
    return url;
  }
  const currentParams = new URLSearchParams(window.location.search);
  INHERITED_QUERY_PARAMS.forEach((key) => {
    const value = currentParams.get(key);
    if (value && !url.searchParams.has(key)) {
      url.searchParams.set(key, value);
    }
  });
  return url;
}

function resolveLoraManagerUiUrl(value: string): string | null {
  const resolved = toAllowedAbsoluteUrl(value);
  return resolved ? inheritSameOriginQueryParams(resolved).toString() : null;
}

export function getLoraManagerUiUrl(): string {
  const envUrl =
    typeof import.meta !== "undefined" &&
    import.meta.env &&
    typeof import.meta.env.VITE_LORA_MANAGER_UI_URL === "string"
      ? import.meta.env.VITE_LORA_MANAGER_UI_URL.trim()
      : "";
  if (envUrl) {
    const resolved = resolveLoraManagerUiUrl(envUrl);
    if (resolved) return resolved;
  }

  const localOverride =
    typeof window !== "undefined"
      ? window.localStorage.getItem("comfyui-mobile-lora-manager-ui-url")?.trim() ?? ""
      : "";
  if (localOverride) {
    const resolved = resolveLoraManagerUiUrl(localOverride);
    if (resolved) return resolved;
  }

  const fallback = resolveLoraManagerUiUrl(DEFAULT_LORA_MANAGER_UI_PATH);
  return fallback ?? DEFAULT_LORA_MANAGER_UI_PATH;
}

export function openLoraManagerUiInNewTab(): boolean {
  if (typeof window === "undefined") return false;
  const nextWindow = window.open(
    getLoraManagerUiUrl(),
    "_blank",
    "noopener,noreferrer",
  );
  return nextWindow !== null;
}
