import { beforeEach, describe, expect, it } from "vitest";
import { fromActivity, log, olderServer, PAGE, refreshServer, matches, MAX_LOCAL, mergeLog, mergeServer, useConsole, type LogEvent } from "../src/console";

const entry = (id: number, at: number, who = "Claude", verb = "set script of part", object: string | null = "bracket", detail: string | null = null) =>
  ({ id, at, who, verb, object, detail });

beforeEach(() => useConsole.setState({ events: [], server: { entries: [], more: false }, filter: "all", project: undefined }));

describe("server activity", () => {
  it("maps who, kind, text, failures and part links", () => {
    expect(fromActivity(entry(3, 100))).toMatchObject({ id: "s3", at: 100, kind: "agent", level: "info", who: "Claude", text: "set script of part bracket", part: "bracket" });
    expect(fromActivity(entry(4, 100, "You", "changed parameter", "w", "30 → 35"))).toMatchObject({ kind: "you", detail: "30 → 35" });
    expect(fromActivity(entry(5, 100, "Claude", "asked for the workspace link", null))).toMatchObject({ text: "asked for the workspace link", part: undefined });
    expect(fromActivity(entry(6, 100, "Claude", "set script of part", "x", "failed")).level).toBe("error");
  });

  it("merges pages by id, newest first, keeping loaded pages", () => {
    const first = mergeServer([], [entry(5, 50), entry(4, 40)]);
    const older = mergeServer(first, [entry(3, 30), entry(2, 20)]);
    const pushed = mergeServer(older, [entry(6, 60), entry(5, 50)]);
    expect(pushed.map((e) => e.id)).toEqual([6, 5, 4, 3, 2]);
  });
});

describe("local events", () => {
  it("are tagged with the open project and capped", () => {
    useConsole.setState({ project: "p1" });
    const e = log({ kind: "build", text: "Built 1 part" });
    expect(e).toMatchObject({ project: "p1", level: "info" });
    for (let i = 0; i < MAX_LOCAL + 5; i++) log({ kind: "system", text: `e${i}` });
    const ev = useConsole.getState().events;
    expect(ev).toHaveLength(MAX_LOCAL);
    expect(ev.at(-1)!.text).toBe(`e${MAX_LOCAL + 4}`);
  });

  it("merge with server entries by time and hide other projects' events", () => {
    const local: LogEvent[] = [
      { id: "l1", at: 45, kind: "build", level: "error", text: "bracket failed", project: "p1" },
      { id: "l2", at: 70, kind: "system", level: "info", text: "other", project: "p2" },
      { id: "l3", at: 10, kind: "system", level: "warn", text: "Connection lost" },
    ];
    const merged = mergeLog(local, [entry(5, 50), entry(4, 40)], "p1");
    expect(merged.map((e) => e.id)).toEqual(["s5", "l1", "s4", "l3"]);
  });
});

describe("filters", () => {
  const ev = (kind: LogEvent["kind"], level: LogEvent["level"]): LogEvent => ({ id: "x", at: 0, kind, level, text: "" });
  it("pick by source; Problems takes errors and warnings of any source", () => {
    expect(matches(ev("agent", "info"), "agent")).toBe(true);
    expect(matches(ev("you", "info"), "agent")).toBe(false);
    expect(matches(ev("you", "info"), "you")).toBe(true);
    expect(matches(ev("build", "ok"), "build")).toBe(true);
    expect(matches(ev("agent", "error"), "problems")).toBe(true);
    expect(matches(ev("system", "warn"), "problems")).toBe(true);
    expect(matches(ev("build", "ok"), "problems")).toBe(false);
    expect(matches(ev("system", "info"), "all")).toBe(true);
  });
});

describe("server pages", () => {
  // 120 entries, ids 1..120; pages of 50 before an id
  let all = Array.from({ length: 120 }, (_, i) => entry(i + 1, (i + 1) * 10));
  const api = {
    activity: async (_pid: string, before?: number) => ({
      entries: all.filter((e) => before === undefined || e.id < before).sort((a, b) => b.id - a.id).slice(0, PAGE),
    }),
  };

  it("Older appends earlier entries; a push adds the new one without dropping loaded pages", async () => {
    await refreshServer(api, "p1");
    expect(useConsole.getState().server).toMatchObject({ pid: "p1", more: true });
    expect(useConsole.getState().server.entries).toHaveLength(50);
    await olderServer(api, "p1");
    await olderServer(api, "p1");
    let s = useConsole.getState().server;
    expect(s.entries).toHaveLength(120);
    expect(s.more).toBe(false);
    expect(s.entries.at(-1)!.id).toBe(1);
    all = [...all, entry(121, 1210)];
    await refreshServer(api, "p1");
    s = useConsole.getState().server;
    expect(s.entries).toHaveLength(121);
    expect(s.entries[0].id).toBe(121);
    // Another project starts over
    await refreshServer(api, "p2");
    expect(useConsole.getState().server).toMatchObject({ pid: "p2", more: true });
    expect(useConsole.getState().server.entries).toHaveLength(50);
  });
});
