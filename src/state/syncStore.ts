import { create } from "zustand";

export type SyncProvider =
  | "icloud"
  | "dropbox"
  | "gdrive"
  | "onedrive"
  | "syncthing"
  | "git"
  | "none";

interface SyncSettings {
  folder: string;
  provider: SyncProvider;
}

interface SyncState extends SyncSettings {
  setFolder: (f: string) => void;
  setProvider: (p: SyncProvider) => void;
}

const KEY = "aquarius.sync";

function load(): SyncSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* swallow */ }
  return { folder: "~/Aquarius", provider: "icloud" };
}

function persist(s: SyncSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch { /* swallow */ }
}

const initial = load();

export const useSync = create<SyncState>((set, get) => ({
  ...initial,
  setFolder(f) {
    set({ folder: f });
    persist({ folder: f, provider: get().provider });
  },
  setProvider(p) {
    set({ provider: p });
    persist({ folder: get().folder, provider: p });
  },
}));

export const PROVIDERS: { id: SyncProvider; name: string; hint: string }[] = [
  { id: "icloud", name: "iCloud Drive", hint: "Default on macOS; quiet and reliable for single-user vaults." },
  { id: "dropbox", name: "Dropbox", hint: "Fast cross-platform sync; conflict files surface as `(conflicted)`." },
  { id: "gdrive", name: "Google Drive", hint: "Works; locks files briefly during upload. Avoid huge images." },
  { id: "onedrive", name: "OneDrive", hint: "Best on Windows; Files-On-Demand mode plays nicely with Aquarius." },
  { id: "syncthing", name: "Syncthing", hint: "Peer-to-peer; no cloud account, no monthly fee. Power-user favorite." },
  { id: "git", name: "Git", hint: "Manual sync. Bring your own remote — full history is yours." },
  { id: "none", name: "Local only", hint: "Disable sync entirely. Files stay on this machine." },
];
