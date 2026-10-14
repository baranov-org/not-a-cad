import { defineConfig } from "vitest/config";

// PGlite startup is slow when test files run in parallel
export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 30_000 } });
