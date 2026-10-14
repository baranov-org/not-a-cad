import { useCallback, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { CameraControls, GizmoHelper, GizmoViewport, Grid, type CameraControlsImpl } from "@react-three/drei";
import type { Direction, Instance } from "shared";
import { applyPlacement, cssHex, darken, DEFAULT_COLOR, edgeGeometries, geometries, viewer } from "../scene";
import { renderThumbnail } from "../thumbnail";
import { activePlanes, sectionAxes, sectionPlane } from "../section";
import { lineInsideMesh, planesLine, sliceMesh } from "../slice";
import { useStore } from "../state";
import { hitTest, MeasureOverlay, setPickPlanes, useMeasurePointer, visiblePoint } from "./Measure";
import { onPointerDown, onWheel, setupControls } from "./navigation";
// Resolved value of a CSS custom property (for the WebGL scene)
const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

const DIRS: Record<Direction, THREE.Vector3> = {
  iso: new THREE.Vector3(1, -1, 0.8).normalize(),
  front: new THREE.Vector3(0, -1, 0),
  right: new THREE.Vector3(1, 0, 0),
  top: new THREE.Vector3(0, -1e-4, 1).normalize(),
};

// Section cuts for one render: all active planes, and per plane the plane alone and the others
interface Cut {
  id: number;
  plane: THREE.Plane; // world space; keeps the side its normal points to
  only: THREE.Plane[];
  others: THREE.Plane[];
  pose: { spacing: number; position: THREE.Vector3; quaternion: THREE.Quaternion; size: number };
}
// Two cuts meet along a line; the other planes clip it like the model
interface Join {
  key: string;
  a: THREE.Plane;
  b: THREE.Plane;
  others: THREE.Plane[];
}
interface Cuts {
  all: THREE.Plane[];
  list: Cut[];
  joins: Join[];
}
const NO_CUTS: Cuts = { all: [], list: [], joins: [] };

// Active planes as three.js planes and cap poses (centred on the model, axes from the cut)
function useCuts(): Cuts {
  const section = useStore((s) => s.section);
  const capturing = useStore((s) => s.capturing);
  const frame = useStore((s) => s.sectionFrame);
  return useMemo(() => {
    const active = capturing ? [] : activePlanes(section);
    if (!active.length) return NO_CUTS;
    const center = new THREE.Vector3(...frame.center);
    const planes = active.map((p) => sectionPlane(p, center));
    const list = active.map((p, i) => {
      const { u, v, n } = sectionAxes(p);
      return {
        id: p.id,
        plane: planes[i],
        only: [planes[i]],
        others: planes.filter((_, k) => k !== i),
        pose: {
          spacing: Math.max((frame.radius * 2) / HATCH_LINES, 0.05),
          position: planes[i].projectPoint(center, new THREE.Vector3()),
          quaternion: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, v, n)),
          size: frame.radius * 4,
        },
      };
    });
    const joins: Join[] = [];
    for (let i = 0; i < planes.length; i++) {
      for (let j = i + 1; j < planes.length; j++) {
        joins.push({ key: `${active[i].id}-${active[j].id}`, a: planes[i], b: planes[j], others: planes.filter((_, k) => k !== i && k !== j) });
      }
    }
    return { all: planes, list, joins };
  }, [section, capturing, frame]);
}

// Stencil passes for section caps: back faces +1, front faces -1 inside closed solids
const stencilProps = (side: THREE.Side, op: THREE.StencilOp) => ({
  side, depthWrite: false, depthTest: false, colorWrite: false, stencilWrite: true,
  stencilFunc: THREE.AlwaysStencilFunc, stencilFail: op, stencilZFail: op, stencilZPass: op,
});

// Per (instance, plane): stencil passes, then that cap (which clears the stencil); all before the visible meshes
const stencilOrder = (slot: number, plane: number) => 10 + 2 * (slot * 3 + plane);
const MESH_ORDER = 1_000_000;

// Outline where a cut crosses this part's surface, in its local coordinates (like replicad's edges);
// the other planes clip it like the model
// Pickable for measuring: each segment knows its triangle, so its face
function SectionOutline({ geom, inst, color, cut, pick }: { geom: THREE.BufferGeometry; inst?: Instance; color: string; cut: Cut; pick: { part: string; key: string; cut: number } }) {
  const outline = useMemo(() => {
    const o = new THREE.Object3D();
    if (inst) applyPlacement(o, inst);
    o.updateMatrix();
    const local = cut.plane.clone().applyMatrix4(o.matrix.clone().invert());
    const g = new THREE.BufferGeometry();
    const tris: number[] = [];
    g.setAttribute("position", new THREE.BufferAttribute(sliceMesh(geom.getAttribute("position").array, geom.index!.array, local, tris), 3));
    g.userData.segTris = Uint32Array.from(tris);
    return g;
  }, [geom, inst, cut]);
  useEffect(() => () => outline.dispose(), [outline]);
  return (
    <lineSegments geometry={outline} renderOrder={MESH_ORDER + 1} userData={{ pick }}>
      <lineBasicMaterial color={darken(color)} clippingPlanes={cut.others} />
    </lineSegments>
  );
}


// Token colours for the WebGL scene
let sceneColors: { canvas: string; grid: string; grid2: string; ink: string; err: string } | undefined;
function useSceneColors() {
  sceneColors ??= {
    canvas: cssHex(cssVar("--canvas")), grid: cssHex(cssVar("--grid")), grid2: cssHex(cssVar("--grid-2")),
    ink: cssHex(cssVar("--ink")), err: cssHex(cssVar("--err")),
  };
  return sceneColors;
}

// WCAG contrast ratio of two colours
function contrast(a: string, b: string) {
  const lum = (h: string) => {
    const c = new THREE.Color(h);
    const f = (x: number) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
    // THREE.Color holds linear values; convert back to sRGB first
    const s = c.clone().convertLinearToSRGB();
    return 0.2126 * f(s.r) + 0.7152 * f(s.g) + 0.0722 * f(s.b);
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

// Edge where two cut faces meet inside a part: the planes' intersection line, kept where it runs inside the solid
function CutJoin({ geom, inst, color, join }: { geom: THREE.BufferGeometry; inst?: Instance; color: string; join: Join }) {
  const line = useMemo(() => {
    const o = new THREE.Object3D();
    if (inst) applyPlacement(o, inst);
    o.updateMatrix();
    const inv = o.matrix.clone().invert();
    const l = planesLine(join.a.clone().applyMatrix4(inv), join.b.clone().applyMatrix4(inv));
    const pts: number[] = [];
    if (l) {
      const ts = lineInsideMesh(geom.getAttribute("position").array, geom.index!.array, l.origin, l.dir);
      for (let k = 0; k + 1 < ts.length; k += 2) {
        pts.push(...l.origin.clone().addScaledVector(l.dir, ts[k]).toArray(), ...l.origin.clone().addScaledVector(l.dir, ts[k + 1]).toArray());
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, [geom, inst, join]);
  useEffect(() => () => line.dispose(), [line]);
  return (
    <lineSegments geometry={line} renderOrder={MESH_ORDER + 1}>
      <lineBasicMaterial color={darken(color)} clippingPlanes={join.others} />
    </lineSegments>
  );
}

function PartMesh({ name, pickKey, color = DEFAULT_COLOR, slot, inst, cuts }: { name: string; pickKey: string; color?: string; slot: number; inst?: Instance; cuts: Cuts }) {
  useStore((s) => s.meshVersion);
  const status = useStore((s) => s.parts[name]?.status);
  const capturing = useStore((s) => s.capturing);
  const colors = useSceneColors();
  const planes = cuts.all;
  const geom = geometries.get(name);
  const edges = edgeGeometries.get(name);
  if (!geom) return null;
  // Building: previous shape ghosted; failed: last good shape tinted (agent screenshots show the plain model)
  const ghost = status === "building" && !capturing;
  const failed = status === "error" && !capturing;
  const fill = failed ? colors.err : color;
  const opacity = ghost ? 0.35 : failed ? 0.6 : 1;
  const lowContrast = contrast(fill, colors.canvas) < 1.6;
  return (
    <group>
      {/* Per plane: count inside/outside with only that plane cutting */}
      {cuts.list.map((c, p) => (
        <group key={c.id}>
          <mesh geometry={geom} renderOrder={stencilOrder(slot, p)}>
            <meshBasicMaterial clippingPlanes={c.only} {...stencilProps(THREE.BackSide, THREE.IncrementWrapStencilOp)} />
          </mesh>
          <mesh geometry={geom} renderOrder={stencilOrder(slot, p)}>
            <meshBasicMaterial clippingPlanes={c.only} {...stencilProps(THREE.FrontSide, THREE.DecrementWrapStencilOp)} />
          </mesh>
        </group>
      ))}
      <mesh geometry={geom} renderOrder={MESH_ORDER} userData={{ pick: { part: name, key: pickKey } }}>
        <meshStandardMaterial color={fill} metalness={0.1} roughness={0.6} polygonOffset polygonOffsetFactor={1}
          transparent={opacity < 1} opacity={opacity} depthWrite={opacity === 1} clippingPlanes={planes} />
      </mesh>
      {planes.length > 0 && (
        // Inside faces seen through the cut: pushed further back, so they never fight the front faces at edges
        <mesh geometry={geom} renderOrder={MESH_ORDER} userData={{ pick: { part: name, key: pickKey } }}>
          <meshStandardMaterial color={fill} metalness={0.1} roughness={0.6} polygonOffset polygonOffsetFactor={4} polygonOffsetUnits={4}
            transparent={opacity < 1} opacity={opacity} depthWrite={opacity === 1} clippingPlanes={planes} side={THREE.BackSide} />
        </mesh>
      )}
      {edges && (
        // Low-contrast colours get ink lines at 40% so the part stays visible
        <lineSegments geometry={edges} renderOrder={MESH_ORDER} userData={{ pick: { part: name, key: pickKey } }}>
          <lineBasicMaterial color={lowContrast ? colors.ink : darken(fill)} clippingPlanes={planes}
            transparent={lowContrast || opacity < 1} opacity={lowContrast ? 0.4 * opacity : opacity} />
        </lineSegments>
      )}
      {geom.index && cuts.list.map((c, i) => <SectionOutline key={c.id} geom={geom} inst={inst} color={color} cut={c} pick={{ part: name, key: pickKey, cut: i }} />)}
      {geom.index && cuts.joins.map((j) => <CutJoin key={j.key} geom={geom} inst={inst} color={color} join={j} />)}
    </group>
  );
}


// Hatching: thin lines in the cut plane, drawn by the cap's shader (anchored in plane coordinates), 45° alternating
// with 135° between parts; faded out where they would be denser than a few pixels (grazing views)
const HATCH_ANGLES = [45, 135];
const HATCH_LINES = 80; // lines across the visible model

function hatchMaterial(color: string, line: string, spacing: number, angle: number, clip: THREE.Plane[]): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({
    color, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 1, clippingPlanes: clip, ...stencilTest,
  });
  const a = (angle * Math.PI) / 180;
  const uniforms = {
    hatchColor: { value: new THREE.Color(line) },
    hatchNormal: { value: new THREE.Vector2(-Math.sin(a), Math.cos(a)) },
    hatchSpacing: { value: spacing },
  };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vHatch;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvHatch = position.xy;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vHatch;\nuniform vec3 hatchColor;\nuniform vec2 hatchNormal;\nuniform float hatchSpacing;")
      .replace("#include <color_fragment>", `#include <color_fragment>
        float ht = dot(vHatch, hatchNormal) / hatchSpacing;
        float hw = fwidth(ht);
        float hl = 1.0 - clamp(abs(fract(ht + 0.5) - 0.5) / hw - 0.5, 0.0, 1.0);
        hl *= 1.0 - smoothstep(0.35, 0.6, hw);
        diffuseColor.rgb = mix(diffuseColor.rgb, hatchColor, hl);`);
  };
  m.customProgramCacheKey = () => "hatch";
  return m;
}

// Draw only where this instance's stencil count is non-zero; keep the stencil for the next pass
const stencilTest = {
  stencilWrite: true, stencilRef: 0, stencilFunc: THREE.NotEqualStencilFunc,
  stencilFail: THREE.KeepStencilOp, stencilZFail: THREE.KeepStencilOp, stencilZPass: THREE.KeepStencilOp,
} as const;

// Cap of one instance on one plane: fill in the part colour with hatching in its edge colour, clipped by the
// other planes; then reset the stencil
function SectionCap({ color = DEFAULT_COLOR, slot, variant, cut, index }: { color?: string; slot: number; variant: number; cut: Cut; index: number }) {
  const { pose } = cut;
  const angle = HATCH_ANGLES[variant % HATCH_ANGLES.length];
  const material = useMemo(() => hatchMaterial(color, darken(color), pose.spacing, angle, cut.others), [color, pose.spacing, angle, cut.others]);
  useEffect(() => () => material.dispose(), [material]);
  return (
    <group position={pose.position} quaternion={pose.quaternion} userData={{ sectionCap: true }}>
      <mesh renderOrder={stencilOrder(slot, index) + 0.5} material={material} onAfterRender={(gl) => gl.clearStencil()}>
        <planeGeometry args={[pose.size, pose.size]} />
      </mesh>
    </group>
  );
}

function Model({ group }: { group: React.RefObject<THREE.Group | null> }) {
  const view = useStore((s) => s.view);
  const assembly = useStore((s) => s.assembly);
  const hidden = useStore((s) => s.hidden);
  const capturing = useStore((s) => s.capturing);
  const cuts = useCuts();
  const items = view.kind === "part"
    ? [{ key: "part", part: view.name, color: undefined as string | undefined, inst: undefined as Instance | undefined }]
    : assembly.instances.flatMap((inst) => (!capturing && hidden.has(inst.key)) ? [] : [{ key: inst.key, part: inst.part, color: inst.color, inst }]);
  // Hatch pattern per part (instances of one part look alike)
  const partOrder = [...new Set(items.map((it) => it.part))];
  useEffect(() => { setPickPlanes(cuts.all); }, [cuts]);
  return (
    <>
      <group ref={group}>
        {items.map((it, slot) => it.inst ? (
          <group key={it.key} ref={(o) => o && applyPlacement(o, it.inst!)}>
            <PartMesh name={it.part} pickKey={it.key} color={it.color} slot={slot} inst={it.inst} cuts={cuts} />
          </group>
        ) : (
          <PartMesh key={it.key} name={it.part} pickKey={it.key} slot={slot} cuts={cuts} />
        ))}
      </group>
      <MeasureOverlay clip={cuts.all} />
      {/* Caps are in world space and outside the fit box */}
      {items.flatMap((it, slot) => cuts.list.map((c, p) => (
        <SectionCap key={`${it.key}:${c.id}`} color={it.color} slot={slot} variant={partOrder.indexOf(it.part)} cut={c} index={p} />
      )))}
    </>
  );
}

// Registers fit/capture and auto-fits on view change
function Controller({ group }: { group: React.RefObject<THREE.Group | null> }) {
  const { camera, gl, scene, controls } = useThree();
  const fitRequest = useStore((s) => s.fitRequest);
  const meshVersion = useStore((s) => s.meshVersion);
  const view = useStore((s) => s.view);
  const hidden = useStore((s) => s.hidden);
  // Instances can arrive after the meshes (assembly scripts, share bundles): frame and fit follow them too
  const assembly = useStore((s) => s.assembly);
  const pendingFit = useRef(true);

  // Face/edge/vertex under a client point; thresholds in pixels at the orbit target's depth
  const hitAt = useCallback((x: number, y: number) => {
    const rect = gl.domElement.getBoundingClientRect();
    if (!group.current || !rect.width) return;
    const ndc = new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
    const cam = camera as THREE.PerspectiveCamera;
    const distance = (controls as unknown as CameraControlsImpl | null)?.distance ?? cam.position.length();
    const pixel = (2 * distance * Math.tan((cam.fov * Math.PI) / 360)) / rect.height;
    return hitTest(ndc, camera, group.current, pixel, matchMedia("(pointer: coarse)").matches);
  }, [camera, gl, controls, group]);
  useMeasurePointer(gl.domElement, hitAt);

  // Navigation: the point under the cursor is where zoom, orbit and pan happen (else the model's centre)
  useEffect(() => {
    const ctl = controls as unknown as CameraControlsImpl | null;
    if (!ctl) return;
    setupControls(ctl);
    const el = gl.domElement;
    const ray = new THREE.Raycaster();
    const pickAt = (x: number, y: number) => {
      const rect = el.getBoundingClientRect();
      if (!group.current) return;
      ray.setFromCamera(new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1), camera);
      const meshes: THREE.Object3D[] = [];
      group.current.traverse((o) => (o as THREE.Mesh).isMesh && o.userData.pick && o.visible && meshes.push(o));
      return visiblePoint(ray, meshes);
    };
    const centre = () => new THREE.Vector3(...useStore.getState().sectionFrame.center);
    const down = (e: PointerEvent) => onPointerDown(ctl, e, pickAt, centre);
    const wheel = (e: WheelEvent) => {
      useStore.setState({ stdView: null });
      onWheel(ctl, e, el, pickAt, centre);
    };
    const start = () => useStore.setState({ stdView: null });
    el.addEventListener("pointerdown", down, { capture: true });
    el.addEventListener("wheel", wheel, { passive: false });
    ctl.addEventListener("controlstart", start);
    return () => {
      el.removeEventListener("pointerdown", down, { capture: true });
      el.removeEventListener("wheel", wheel);
      ctl.removeEventListener("controlstart", start);
    };
  }, [controls, gl, camera, group]);

  // Clipping planes follow the distance to the orbit point, so zooming in close never cuts the model away
  useFrame(() => {
    const ctl = controls as unknown as CameraControlsImpl | null;
    const cam = camera as THREE.PerspectiveCamera;
    if (!ctl) return;
    const d = Math.max(ctl.distance, 1e-3);
    const near = d / 100, far = Math.max(d * 200, d + useStore.getState().sectionFrame.radius * 10, 5000);
    if (Math.abs(cam.near - near) > near * 0.05 || Math.abs(cam.far - far) > far * 0.05) {
      cam.near = near;
      cam.far = far;
      cam.updateProjectionMatrix();
    }
  });

  // Section frame follows the visible model
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      if (!group.current) return;
      const box = new THREE.Box3().setFromObject(group.current);
      if (box.isEmpty()) return;
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      const r = (x: number) => Math.round(x * 1000) / 1000;
      const size = box.getSize(new THREE.Vector3());
      useStore.setState({
        sectionFrame: { center: [r(sphere.center.x), r(sphere.center.y), r(sphere.center.z)], radius: r(sphere.radius) },
        viewSize: [r(size.x), r(size.y), r(size.z)],
      });
    });
    return () => cancelAnimationFrame(id);
  }, [meshVersion, view, hidden, assembly, group]);

  useEffect(() => {
    viewer.fit = (dir) => {
      const ctl = controls as unknown as CameraControlsImpl | null;
      const box = new THREE.Box3();
      if (group.current) box.setFromObject(group.current);
      if (box.isEmpty()) box.set(new THREE.Vector3(-50, -50, 0), new THREE.Vector3(50, 50, 50));
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      const cam = camera as THREE.PerspectiveCamera;
      const dist = (sphere.radius / Math.sin((cam.fov * Math.PI) / 360)) * 1.15;
      const target = ctl ? ctl.getTarget(new THREE.Vector3()) : new THREE.Vector3();
      const d = dir ? DIRS[dir].clone() : cam.position.clone().sub(target).normalize();
      const pos = sphere.center.clone().addScaledVector(d, dist);
      cam.near = dist / 100;
      cam.far = dist * 100;
      cam.updateProjectionMatrix();
      if (ctl) {
        // Orbiting around a picked point leaves a focal offset; a fit starts clean
        void ctl.setFocalOffset(0, 0, 0, false);
        void ctl.setLookAt(pos.x, pos.y, pos.z, sphere.center.x, sphere.center.y, sphere.center.z, false);
        ctl.update(0);
      } else {
        cam.position.copy(pos);
        cam.lookAt(sphere.center);
      }
    };
    viewer.capture = () => {
      gl.render(scene, camera);
      const src = gl.domElement;
      const scale = Math.min(1, 1024 / Math.max(src.width, src.height));
      const c = document.createElement("canvas");
      c.width = Math.round(src.width * scale);
      c.height = Math.round(src.height * scale);
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = cssVar("--canvas");
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(src, 0, 0, c.width, c.height);
      return c.toDataURL("image/png");
    };
    viewer.thumbnail = renderThumbnail;
    viewer.cameraState = () => {
      const ctl = controls as unknown as CameraControlsImpl | null;
      return {
        distance: ctl?.distance ?? 0,
        target: (ctl ? ctl.getTarget(new THREE.Vector3()) : new THREE.Vector3()).toArray(),
        position: camera.position.toArray(),
        forward: camera.getWorldDirection(new THREE.Vector3()).toArray(),
        near: (camera as THREE.PerspectiveCamera).near,
      };
    };
    viewer.pick = (x, y) => hitAt(x, y);
  }, [camera, gl, scene, controls, group, hitAt]);

  useEffect(() => {
    pendingFit.current = true;
  }, [fitRequest]);

  // Fit once every part in view has its mesh (or failed), so the first framing covers the whole model
  useEffect(() => {
    if (!pendingFit.current) return;
    const id = requestAnimationFrame(() => {
      const { view, assembly, hidden, parts } = useStore.getState();
      const shown = view.kind === "part" ? [view.name] : assembly.instances.filter((i) => !hidden.has(i.key)).map((i) => i.part);
      const ready = shown.every((n) => geometries.has(n) || parts[n]?.status === "error" || !parts[n]);
      if (ready && group.current && !new THREE.Box3().setFromObject(group.current).isEmpty()) {
        viewer.fit?.();
        pendingFit.current = false;
      }
    });
    return () => cancelAnimationFrame(id);
  }, [fitRequest, meshVersion, assembly, group]);

  return null;
}

export function Viewport() {
  const group = useRef<THREE.Group>(null);
  const colors = useSceneColors();
  return (
    <Canvas
      camera={{ position: [150, -150, 120], fov: 40, near: 0.1, far: 10000 }}
      gl={{ preserveDrawingBuffer: true, antialias: true, stencil: true }}
      onCreated={({ gl }) => (gl.localClippingEnabled = true)}
      style={{ background: colors.canvas }}
    >
      <ambientLight intensity={0.6} />
      <directionalLight position={[100, -150, 200]} intensity={1.6} />
      <directionalLight position={[-120, 100, 60]} intensity={0.5} />
      <Model group={group} />
      <Grid
        rotation={[Math.PI / 2, 0, 0]}
        infiniteGrid
        cellSize={1}
        sectionSize={10}
        cellColor={colors.grid}
        sectionColor={colors.grid2}
        fadeDistance={1500}
      />
      {/* Leaving a standard view clears the toolbar highlight (see Controller) */}
      <CameraControls makeDefault />
      <Controller group={group} />
      <GizmoHelper alignment="bottom-right" margin={[60, 70]}>
        <GizmoViewport axisColors={["#e05252", "#4caf50", "#4a7fd6"]} labelColor="white" />
      </GizmoHelper>
    </Canvas>
  );
}
