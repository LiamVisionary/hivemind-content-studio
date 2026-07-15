import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getLoraManagerUiUrl,
  openLoraManagerUiInNewTab,
} from "@/utils/loraManagerUi";

const OVERRIDE_KEY = "comfyui-mobile-lora-manager-ui-url";

function setCurrentUrl(path: string) {
  window.history.replaceState(null, "", path);
}

describe("loraManagerUi", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setCurrentUrl("/mobile/?token=secret-token&api=http%3A%2F%2F127.0.0.1%3A8787");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("opens the real model manager tab by default and preserves same-origin auth", () => {
    const url = new URL(getLoraManagerUiUrl());

    expect(url.origin).toBe(window.location.origin);
    expect(url.pathname).toBe("/");
    expect(url.searchParams.get("tab")).toBe("models");
    expect(url.searchParams.get("token")).toBe("secret-token");
    expect(url.searchParams.get("api")).toBeNull();
    expect(url.hash).toBe("#models");
  });

  it("keeps explicit same-origin overrides but still carries auth", () => {
    window.localStorage.setItem(OVERRIDE_KEY, "/?tab=models#models");

    const url = new URL(getLoraManagerUiUrl());

    expect(url.pathname).toBe("/");
    expect(url.searchParams.get("tab")).toBe("models");
    expect(url.searchParams.get("token")).toBe("secret-token");
    expect(url.searchParams.get("api")).toBeNull();
    expect(url.hash).toBe("#models");
  });

  it("does not copy auth params to cross-origin overrides", () => {
    window.localStorage.setItem(OVERRIDE_KEY, "https://models.example.test/?tab=models#models");

    const url = new URL(getLoraManagerUiUrl());

    expect(url.origin).toBe("https://models.example.test");
    expect(url.searchParams.get("token")).toBeNull();
    expect(url.searchParams.get("api")).toBeNull();
  });

  it("uses the computed URL when opening a new tab", () => {
    const open = vi.spyOn(window, "open").mockReturnValue({} as Window);

    expect(openLoraManagerUiInNewTab()).toBe(true);
    expect(open).toHaveBeenCalledWith(
      getLoraManagerUiUrl(),
      "_blank",
      "noopener,noreferrer",
    );
  });
});
