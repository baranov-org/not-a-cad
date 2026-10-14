import { describe, expect, it } from "vitest";
import { ParamsForm } from "shared";
import { decodeParams, encodeParams } from "../src/paramsUrl";

const form = ParamsForm.parse({
  params: [
    { name: "depth", label: "Depth", type: "number", default: 200, min: 120, max: 300 },
    { name: "t", label: "Thickness", type: "slider", default: 6, min: 2, max: 12, step: 0.5 },
    { name: "gusset", label: "Gusset", type: "checkbox", default: true },
    { name: "screw", label: "Screw", type: "radio", default: "M5", options: [{ value: "M4", label: "M4" }, { value: "M5", label: "M5" }, { value: "M6", label: "M6" }] },
    { name: "n", label: "Count", type: "select", default: 2, options: [{ value: 2, label: "2" }, { value: 4, label: "4" }] },
    { name: "tag", label: "Tag", type: "text", default: "" },
  ],
});
const published = { depth: 250, t: 6, gusset: true, screw: "M5", n: 2, tag: "" };

describe("params in the share URL", () => {
  it("encodes only values that differ from the published ones", () => {
    expect(encodeParams(form, published, published)).toBe("");
    expect(encodeParams(form, published, { ...published, depth: 200, gusset: false, screw: "M6", t: 7.5 }))
      .toBe("depth=200&t=7.5&gusset=0&screw=M6");
    expect(encodeParams(form, published, { ...published, tag: "Bob & Co #1", n: 4 })).toBe("n=4&tag=Bob%20%26%20Co%20%231");
  });

  it("round-trips, keeping option and number types", () => {
    const values = { ...published, depth: 180, gusset: false, n: 4, tag: "a=b&c" };
    const hash = `#${encodeParams(form, published, values)}`;
    expect({ ...published, ...decodeParams(form, hash) }).toEqual(values);
    expect(decodeParams(form, "#n=4").n).toBe(4);
  });

  it("ignores unknown names and invalid values", () => {
    expect(decodeParams(form, "#depth=999&gusset=maybe&screw=M8&x=1&t=&tag=%E0%A4%A&n=3")).toEqual({});
    expect(decodeParams(form, "")).toEqual({});
    expect(decodeParams(form, "#depth=150&=x&junk")).toEqual({ depth: 150 });
  });
});
