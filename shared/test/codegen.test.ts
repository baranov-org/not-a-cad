import { describe, expect, it } from "vitest";
import { booleanSource, chamferSource, filletSource, partRefs, primitiveSource, transformSource } from "../src";

describe("codegen", () => {
  it("primitives", () => {
    expect(primitiveSource({ type: "box", width: 10, depth: 20, height: 5 })).toMatchSnapshot();
    expect(primitiveSource({ type: "cylinder", radius: 3, height: 7 })).toMatchSnapshot();
    expect(primitiveSource({ type: "sphere", radius: 4 })).toMatchSnapshot();
    expect(primitiveSource({ type: "cone", radius1: 5, radius2: 0, height: 9 })).toMatchSnapshot();
    expect(primitiveSource({ type: "cone", radius1: 0, radius2: 3, height: 9 })).toMatchSnapshot();
    expect(primitiveSource({ type: "torus", majorRadius: 10, minorRadius: 2 })).toMatchSnapshot();
  });
  it("boolean references inputs", () => {
    const s = booleanSource("cut", "plate", ["hole1", "hole2"]);
    expect(s).toMatchSnapshot();
    expect(partRefs(s).sort()).toEqual(["hole1", "hole2", "plate"]);
  });
  it("fillet/chamfer to new part", () => {
    expect(filletSource("box", 2, "all")).toMatchSnapshot();
    expect(chamferSource("box", 1, { parallelTo: "Z" })).toMatchSnapshot();
  });
  it("in-place wrapping keeps refs and nests", () => {
    const base = `const main = () => part("a").fuse(part("b"));`;
    const once = filletSource("c", 1, { inPlane: "XY", offset: 5 }, base);
    const twice = transformSource("c", [90, 0, 0], [1, 2, 3], once);
    expect(twice).toMatchSnapshot();
    expect(partRefs(twice).sort()).toEqual(["a", "b"]);
  });
  it("transform skips zero components", () => {
    expect(transformSource("a", [0, 0, 45], [0, 0, 0])).toBe(
      `// transform\nconst main = () => part("a").rotate(45, [0, 0, 0], [0, 0, 1]);`,
    );
  });
});
