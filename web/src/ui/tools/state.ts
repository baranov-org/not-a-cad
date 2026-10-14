import { create } from "zustand";
import { useStore } from "../../state";
import { useMeasure } from "../Measure";

// Viewport tools (Section, Measure): which was used last decides which card stays open when only one fits
export type ToolId = "section" | "measure";

interface Tools {
  last: ToolId;
  sectionMin: boolean; // section card shown as a pill (cutting continues)
  tab: "offset" | "tilt"; // shared by all planes
}

export const useTools = create<Tools>(() => ({ last: "measure", sectionMin: false, tab: "offset" }));

// Opening a tool or expanding its pill counts as using it
useStore.subscribe((s, p) => {
  if (s.section.open && !p.section.open) useTools.setState({ last: "section", sectionMin: false });
});
useMeasure.subscribe((m, p) => {
  if ((m.on && !p.on) || (m.on && p.min && !m.min)) useTools.setState({ last: "measure" });
});

export const expandSection = () => useTools.setState({ last: "section", sectionMin: false });
export const minimiseSection = () => useTools.setState({ sectionMin: true });
