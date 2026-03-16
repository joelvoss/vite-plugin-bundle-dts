import { builtinModules } from "node:module";

import { defineConfig } from "vite";

import dtsPlugin from "./src";

const externalPackages = [
  "@microsoft/api-extractor",
  "magic-string",
  "typescript",
  "vite",
];

const external = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
  ...externalPackages,
]);

export default defineConfig({
  build: {
    emptyOutDir: true,
    lib: {
      entry: "src/index.ts",
      fileName: (format) => (format === "es" ? "index.js" : "index.cjs"),
      formats: ["es", "cjs"],
      name: "VitePluginBundleDts",
    },
    rollupOptions: {
      external: (id) => {
        if (id.startsWith("node:")) {
          return true;
        }

        return external.has(id);
      },
      output: {
        exports: "named",
      },
    },
    sourcemap: true,
  },
  plugins: [
    dtsPlugin({
      insertTypesEntry: true,
      rollupTypes: true,
    }),
  ],
});