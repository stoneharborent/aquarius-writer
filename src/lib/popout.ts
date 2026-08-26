/** True when the current window was opened as a popout. */
export function getPopoutPath(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  return params.get("popout");
}

export function isPopoutWindow(): boolean {
  return getPopoutPath() !== null;
}
