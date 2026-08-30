import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauriShell } from "@/lib/platform";
import { notices } from "@/state/noticeStore";

/**
 * Updating the app, on AquariusOS only.
 *
 * There the app is part of the operating system's image, which is read-only, so
 * it cannot replace itself. Instead it downloads a newer copy into a folder in
 * the home directory and the OS launcher starts whichever copy is newer. All of
 * that lives in Rust (`src-tauri/src/updater/`) — this store only mirrors what
 * Rust says and forwards the four things a person can press.
 *
 * **Nothing here decides anything.** The phase always comes from the backend, so
 * the panel can never claim an update is ready when it is not. Every change
 * arrives on the `updater://state` event, including download percentages, so
 * there is no polling.
 *
 * Off AquariusOS — on a Mac, in the browser preview, or on a Linux machine where
 * the app was started by hand — `osManaged` is false and the Settings panel
 * renders nothing at all.
 */

export type UpdatePhase =
  | "unsupported"
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "installing"
  | "ready"
  | "error";

/** Mirrors `UpdateState` in `src-tauri/src/updater/mod.rs`. */
export interface UpdateStatus {
  phase: UpdatePhase;
  osManaged: boolean;
  currentVersion: string;
  latestVersion?: string;
  percent?: number;
  message?: string;
  /** Which operation failed, so "try again" retries the right one. */
  failedOperation?: "check" | "install";
}

/** The event Rust emits on every change. */
const STATE_EVENT = "updater://state";

interface UpdateState {
  /** Null until the backend has answered once — the panel draws nothing. */
  status: UpdateStatus | null;
  /** Subscribe to the backend and, on AquariusOS, check once. Safe to call twice. */
  start: () => Promise<void>;
  /** The "Check for updates" button. */
  check: () => Promise<void>;
  /** The "Download and install" button. */
  install: () => Promise<void>;
  /** The "Restart to update" button. Does not return when it works. */
  restart: () => Promise<void>;
}

/**
 * `?updates=available` — draw the panel in one chosen phase, without a shell.
 *
 * The Updates section only ever appears on AquariusOS, which means it can never
 * be seen on the Mac where it is written. This is the same trick `?theme=` and
 * `?platform=linux` use for the window chrome: it is a review aid, it is never
 * written anywhere, and unlike those two it is stripped out of production
 * builds entirely — an app that could be talked into claiming an update is
 * ready would be lying to the person reading it.
 *
 * Use it with `npm run dev`:
 * `http://localhost:1420/?updates=downloading`
 */
function previewStatus(): UpdateStatus | null {
  const phases: UpdatePhase[] = [
    "idle", "checking", "current", "available", "downloading", "installing", "ready", "error",
  ];
  let asked: string | null = null;
  try {
    asked = new URLSearchParams(window.location.search).get("updates");
  } catch {
    return null;
  }
  if (!asked || !(phases as string[]).includes(asked)) return null;
  const phase = asked as UpdatePhase;
  return {
    phase,
    osManaged: true,
    currentVersion: __APP_VERSION__,
    latestVersion: phase === "idle" || phase === "checking" ? undefined : "0.3.0",
    percent: phase === "downloading" ? 62 : undefined,
    message:
      phase === "error"
        ? "Could not reach GitHub. Check your internet connection and try again."
        : undefined,
    failedOperation: phase === "error" ? "install" : undefined,
  };
}

let starting = false;

export const useUpdates = create<UpdateState>((set) => ({
  status: null,

  async start() {
    if (starting) return;
    if (import.meta.env.DEV) {
      const preview = previewStatus();
      if (preview) {
        starting = true;
        set({ status: preview });
        return;
      }
    }
    if (!isTauriShell()) return;
    starting = true;
    try {
      // Listen before asking, so a state published while we wait is not missed.
      void listen<UpdateStatus>(STATE_EVENT, (event) => set({ status: event.payload }));
      const status = await invoke<UpdateStatus>("updater_status");
      set({ status });
      // One quiet check at launch. `silent` tells Rust to fall back to "idle"
      // rather than an error, so a machine with no internet opens in silence
      // instead of opening with a complaint.
      if (status.osManaged) await invoke<UpdateStatus>("updater_check", { silent: true });
    } catch {
      // An updater that cannot start is not a reason to fail the app's launch.
      // The manual button still works, and reports properly when it doesn't.
    }
  },

  async check() {
    if (!isTauriShell()) return;
    try {
      set({ status: await invoke<UpdateStatus>("updater_check", { silent: false }) });
    } catch (e) {
      notices.fail("Could not check for updates", e);
    }
  },

  async install() {
    if (!isTauriShell()) return;
    try {
      set({ status: await invoke<UpdateStatus>("updater_install") });
    } catch (e) {
      notices.fail("Could not install the update", e);
    }
  },

  async restart() {
    if (!isTauriShell()) return;
    try {
      await invoke("updater_restart");
    } catch (e) {
      notices.fail("Could not restart", e);
    }
  },
}));
