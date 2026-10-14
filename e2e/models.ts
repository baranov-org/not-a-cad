import type { mcpClient } from "./fixtures";

// Small wall-shelf model with params, groups and a coloured assembly
export async function bracket(cad: Awaited<ReturnType<typeof mcpClient>>) {
  await cad.call("set_model_info", { name: "Wall shelf bracket", description: "Two L-brackets and a board for a wall shelf. Screws go through the wall plate." });
  await cad.call("set_params_form", {
    groups: [{ id: "dims", label: "Dimensions" }, { id: "mount", label: "Mounting" }],
    params: [
      { name: "depth", label: "Shelf depth", type: "number", default: 200, min: 120, max: 300, unit: "mm", group: "dims", description: "Arm length, from the wall to the front edge." },
      { name: "height", label: "Plate height", type: "slider", default: 140, min: 80, max: 200, unit: "mm", group: "dims" },
      { name: "t", label: "Thickness", type: "slider", default: 6, min: 3, max: 12, step: 0.5, unit: "mm", group: "dims" },
      { name: "screw", label: "Screw size", type: "radio", default: "M5", group: "mount", options: [{ value: "M4", label: "M4" }, { value: "M5", label: "M5" }, { value: "M6", label: "M6" }] },
      { name: "gusset", label: "Gusset", type: "checkbox", default: true, group: "mount" },
    ],
  });
  await cad.call("set_part_script", { name: "board", source: `const main = () => makeBaseBox(300, param("depth"), 18);` });
  await cad.call("set_part_script", { name: "plate", source: `const main = () => makeBaseBox(40, param("t"), param("height"));` });
  await cad.call("set_part_script", { name: "arm", source: `const main = () => makeBaseBox(40, param("depth") - 20, param("t"));` });
  await cad.call("set_part_groups", { groups: [{ id: "bracket", label: "Bracket" }], assign: { plate: "bracket", arm: "bracket" } });
  await cad.call("set_assembly", { instances: [
    { part: "board", position: [0, 100, 140], color: "#e8d3a6" },
    { part: "plate", position: [-110, 0, 0], color: "#7f8fa6" },
    { part: "plate", position: [110, 0, 0], color: "#7f8fa6" },
    { part: "arm", position: [-110, 90, 134], color: "#c46a3a" },
    { part: "arm", position: [110, 90, 134], color: "#c46a3a" },
  ] });
}
