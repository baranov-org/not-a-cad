import { useConsole } from "./console";
import { cssHex } from "./scene";
import { useStore } from "./state";

// Tab icon status, like Claude's web app: a grey blinking dot while the agent works or parts build, a blue dot when
// something happened while the tab was in the background (cleared on return), red while an approval waits

type Status = "idle" | "working" | "update" | "attention";

const SIZE = 64;
const BLINK_MS = 600;

let base: HTMLImageElement | undefined;
const frames = new Map<string, string>();
let originals: [HTMLLinkElement, string][] = [];
let status: Status = "idle";
let unseen = false;
let blink: ReturnType<typeof setInterval> | undefined;

const token = (name: string, fallback: string) =>
  cssHex(getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback);
const color = (s: Status) =>
  s === "working" ? "#8a8f98" : s === "attention" ? token("--err", "#d93025") : token("--accent", "#2f6fde");

// Base icon with a dot at the bottom right (white ring keeps it visible on the dark icon)
function frame(dot?: string): string | undefined {
  if (!base?.complete) return;
  const key = dot ?? "none";
  let url = frames.get(key);
  if (url) return url;
  const c = document.createElement("canvas");
  c.width = c.height = SIZE;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(base, 0, 0, SIZE, SIZE);
  if (dot) {
    ctx.beginPath();
    ctx.arc(SIZE - 15, SIZE - 15, 13, 0, Math.PI * 2);
    ctx.fillStyle = dot;
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = "#fff";
    ctx.stroke();
  }
  url = c.toDataURL("image/png");
  frames.set(key, url);
  return url;
}

function setIcon(url?: string) {
  for (const [link, href] of originals) link.href = url ?? href;
}

function render() {
  clearInterval(blink);
  blink = undefined;
  if (status === "idle") return setIcon();
  const on = frame(color(status));
  if (!on) return;
  setIcon(on);
  if (status !== "working") return;
  // Blink between the plain icon and the dot
  let lit = true;
  blink = setInterval(() => {
    lit = !lit;
    setIcon(lit ? on : frame());
  }, BLINK_MS);
}

function update() {
  const s = useStore.getState();
  const working = Object.values(s.parts).some((p) => p.status === "building") || s.agents.some((a) => a.busy);
  const next: Status = s.authRequests.length ? "attention" : working ? "working" : unseen ? "update" : "idle";
  if (next === status) return;
  status = next;
  render();
}

let started = false;
export function startFavicon() {
  if (started) return;
  started = true;
  originals = [...document.querySelectorAll<HTMLLinkElement>("link[rel~=icon]")].map((l) => [l, l.href]);
  base = new Image();
  base.onload = () => {
    frames.clear();
    if (status !== "idle") render();
  };
  base.src = "/favicon.svg";
  const background = () => document.visibilityState === "hidden";
  useStore.subscribe((s, prev) => {
    // Work finished or the agent changed something while the tab was in the background
    const wasWorking = Object.values(prev.parts).some((p) => p.status === "building") || prev.agents.some((a) => a.busy);
    const working = Object.values(s.parts).some((p) => p.status === "building") || s.agents.some((a) => a.busy);
    if (background() && ((wasWorking && !working) || s.activityVersion !== prev.activityVersion)) unseen = true;
    update();
  });
  useConsole.subscribe((s, prev) => {
    if (background() && s.events.length !== prev.events.length) unseen = true;
    update();
  });
  document.addEventListener("visibilitychange", () => {
    if (!background()) unseen = false;
    update();
  });
}
