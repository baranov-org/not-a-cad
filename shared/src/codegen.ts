import type { EdgeFilter, Primitive } from "./tools";
import type { Vec3 } from "./model";

const q = (s: string) => JSON.stringify(s);
const n = (x: number) => String(x);

export function primitiveSource(p: Primitive): string {
  switch (p.type) {
    case "box":
      return `// box ${p.width}x${p.depth}x${p.height}, centred in XY, base on Z=0
const main = () => makeBaseBox(${n(p.width)}, ${n(p.depth)}, ${n(p.height)});`;
    case "cylinder":
      return `// cylinder r=${p.radius} h=${p.height}, base on Z=0
const main = () => makeCylinder(${n(p.radius)}, ${n(p.height)});`;
    case "sphere":
      return `// sphere r=${p.radius}
const main = () => makeSphere(${n(p.radius)});`;
    case "cone": {
      // Profile in XZ from the axis; skip zero-length edges when a radius is 0
      const pts: [number, number][] = [];
      if (p.radius1) pts.push([p.radius1, 0]);
      pts.push([p.radius2, p.height]);
      if (p.radius2) pts.push([0, p.height]);
      const path = pts.map(([x, z]) => `.lineTo([${n(x)}, ${n(z)}])`).join("");
      return `// cone r1=${p.radius1} r2=${p.radius2} h=${p.height}, base on Z=0
const main = () =>
  draw([0, 0])${path}.close()
    .sketchOnPlane("XZ").revolve([0, 0, 1]);`;
    }
    case "torus":
      return `// torus R=${p.majorRadius} r=${p.minorRadius}, axis Z
const main = () =>
  drawCircle(${n(p.minorRadius)}).translate(${n(p.majorRadius)}, 0)
    .sketchOnPlane("XZ").revolve([0, 0, 1]);`;
  }
}

export function booleanSource(op: "union" | "cut" | "intersect", target: string, tools: string[]): string {
  const method = op === "union" ? "fuse" : op;
  const chain = tools.map((t) => `.${method}(part(${q(t)}))`).join("");
  return `// ${op} ${target} with ${tools.join(", ")}
const main = () => part(${q(target)})${chain};`;
}

function edgeFinder(f: EdgeFilter): string {
  if (f === "all") return "";
  if ("parallelTo" in f) return `, (e) => e.inDirection(${q(f.parallelTo)})`;
  return `, (e) => e.inPlane(${q(f.inPlane)}, ${n(f.offset)})`;
}

// Wraps an op applied to `input`; in place when result === input
function derived(input: string, prevSource: string | undefined, label: string, expr: (base: string) => string): string {
  if (prevSource === undefined) return `// ${label}\nconst main = () => ${expr(`part(${q(input)})`)};`;
  const body = prevSource.split("\n").map((l) => "  " + l).join("\n");
  return `// ${label}
const prev = (() => {
${body}
  return main;
})();
const main = () => ${expr("prev()")};`;
}

export function filletSource(input: string, radius: number, edges: EdgeFilter, prevSource?: string): string {
  return derived(input, prevSource, `fillet r=${radius}`, (b) => `${b}.fillet(${n(radius)}${edgeFinder(edges)})`);
}

export function chamferSource(input: string, distance: number, edges: EdgeFilter, prevSource?: string): string {
  return derived(input, prevSource, `chamfer d=${distance}`, (b) => `${b}.chamfer(${n(distance)}${edgeFinder(edges)})`);
}

export function transformSource(input: string, rotate: Vec3 | undefined, translate: Vec3 | undefined, prevSource?: string): string {
  return derived(input, prevSource, "transform", (b) => {
    let e = b;
    const axes: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    rotate?.forEach((deg, i) => {
      if (deg) e += `.rotate(${n(deg)}, [0, 0, 0], [${axes[i].join(", ")}])`;
    });
    if (translate && translate.some((v) => v)) e += `.translate([${translate.join(", ")}])`;
    return e;
  });
}
