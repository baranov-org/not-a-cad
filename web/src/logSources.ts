import { log, useConsole, type Level, type LogAction } from "./console";
import { setView, toast, useStore } from "./state";
import { dur, useLayout } from "./ui/shell/Shell";

// Message for the user: the console when one is shown, else a toast (library page)
export function notify(text: string, level: Level = "info", action?: LogAction) {
  if (useConsole.getState().mounted) log({ kind: "system", level, text, action });
  else toast(text, action);
}
export const notifyError = (e: unknown) => notify(e instanceof Error ? e.message : String(e), "error");

// Selects a failed part and opens its error card
export function showPartError(name: string) {
  useLayout.setState({ leftCollapsed: false });
  useStore.setState({ openError: name, sheetTab: "parts" });
  setView({ kind: "part", name });
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

let started = false;
// Build, connection and approval events from store changes
export function startLogSources() {
  if (started) return;
  started = true;
  let lost = false;
  useStore.subscribe((s, prev) => {
    // A part that just failed (was not failed before this build)
    if (s.parts !== prev.parts) {
      for (const p of Object.values(s.parts)) {
        if (p.status !== "error" || prev.parts[p.name]?.status === "error") continue;
        const name = p.name;
        log({
          kind: "build", level: "error", text: `${name} failed`, detail: p.error?.split("\n")[0], part: name,
          action: { label: "Details", run: () => showPartError(name), until: () => useStore.getState().parts[name]?.status === "error" },
        });
      }
    }
    if (s.lastRound && s.lastRound !== prev.lastRound && s.lastRound.built > 0) {
      const r = s.lastRound;
      log({ kind: "build", level: "ok", text: `Built ${plural(r.built, "part")} in ${dur(r.ms)}${r.cached ? `, ${r.cached} cached` : ""}` });
    }
    if (s.conn !== prev.conn) {
      if (s.conn === "disconnected" && !lost) {
        lost = true;
        log({ kind: "system", level: "error", project: undefined, text: "Connection lost. Reconnecting… Your project is safe in this browser. Tool calls resume when the agent is back." });
      } else if (s.conn === "connected" && lost) {
        lost = false;
        log({ kind: "system", level: "ok", project: undefined, text: "Reconnected" });
      }
    }
    if (s.authRequests !== prev.authRequests) {
      const known = new Set(prev.authRequests.map((r) => r.id));
      for (const r of s.authRequests) {
        if (known.has(r.id)) continue;
        const id = r.id;
        log({
          kind: "agent", level: "warn", project: undefined, who: r.client.name ?? "An agent", text: "asks for approval",
          action: {
            label: "Review",
            run: () => useStore.setState({ approvalOpen: true }),
            until: () => useStore.getState().authRequests.some((x) => x.id === id),
          },
        });
      }
    }
  });
}
