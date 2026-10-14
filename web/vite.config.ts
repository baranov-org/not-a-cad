import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

// Mesh cache keys include the kernel versions
const require = createRequire(import.meta.url);
const version = (pkg: string) => {
  const entry = require.resolve(pkg);
  const dir = entry.slice(0, entry.lastIndexOf(`/node_modules/${pkg}/`)) + `/node_modules/${pkg}`;
  return JSON.parse(readFileSync(`${dir}/package.json`, "utf8")).version;
};
const KERNEL_VERSION = `replicad@${version("replicad")}+oc@${version("replicad-opencascadejs")}`;

const server = "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  define: { __KERNEL_VERSION__: JSON.stringify(KERNEL_VERSION) },
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: server, ws: true },
      "/mcp": server,
      "/health": server,
    },
  },
  worker: { format: "es" },
});
