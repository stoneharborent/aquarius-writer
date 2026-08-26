import type { VaultService } from "./service";
import { createBrowserVaultService } from "./browser-service";
import { createTauriVaultService } from "./tauri-service";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

let _service: VaultService | null = null;

export function vault(): VaultService {
  if (_service) return _service;
  const inTauri = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
  _service = inTauri ? createTauriVaultService() : createBrowserVaultService();
  return _service;
}

export type { VaultService } from "./service";
