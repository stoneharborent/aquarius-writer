import { create } from "zustand";
import { logToShell } from "@/lib/logging";

/**
 * The app's one way of saying "that didn't work".
 *
 * Before v0.1.1 there wasn't one. `vaultStore` caught every backend failure and
 * put the message in `error`, which nothing rendered — so a workflow that
 * refused to open looked exactly like a button that wasn't wired up, which is
 * exactly the confusion the first Linux boot produced. Anything that fails in
 * response to a click now lands here, on screen and in the log.
 */

export type NoticeTone = "error" | "info";

export interface Notice {
  id: number;
  tone: NoticeTone;
  /** One line, sentence case, no trailing period. */
  title: string;
  /** The backend's own words, when there are any. */
  detail?: string;
}

interface NoticeState {
  notices: Notice[];
  /** Show a failure. Also prints it to stderr, so field logs catch it. */
  fail: (title: string, err?: unknown) => void;
  /** Show a neutral confirmation. */
  say: (title: string, detail?: string) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

function messageOf(err: unknown): string | undefined {
  if (err == null) return undefined;
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Errors clear themselves eventually; nothing here is worth blocking on. */
const LIFETIME_MS: Record<NoticeTone, number> = { error: 12_000, info: 5_000 };

export const useNotices = create<NoticeState>((set, get) => {
  function push(tone: NoticeTone, title: string, detail?: string) {
    const id = nextId++;
    set({ notices: [...get().notices, { id, tone, title, detail }] });
    window.setTimeout(() => get().dismiss(id), LIFETIME_MS[tone]);
  }

  return {
    notices: [],

    fail(title, err) {
      const detail = messageOf(err);
      // Always to the terminal as well: the toast is gone in twelve seconds and
      // a bug report written the next morning still needs the reason.
      logToShell("error", `${title}${detail ? ` — ${detail}` : ""}`);
      console.error(title, err ?? "");
      push("error", title, detail);
    },

    say(title, detail) {
      push("info", title, detail);
    },

    dismiss(id) {
      set({ notices: get().notices.filter((n) => n.id !== id) });
    },
  };
});

/** Non-hook access, for stores and plain functions. */
export const notices = {
  fail: (title: string, err?: unknown) => useNotices.getState().fail(title, err),
  say: (title: string, detail?: string) => useNotices.getState().say(title, detail),
};
