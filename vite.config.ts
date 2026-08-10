// Modified by Kroscloud, 2026 — see FORK-CHANGES.md
import fs from "node:fs";
import path from "node:path";
import MagicString from "magic-string";
import type { Plugin } from "vite";
import { defineConfig } from "vite";
import dts from "vite-plugin-dts";
import glsl from "vite-plugin-glsl";

/**
 * Vite plugin to fix WASM data URL compatibility with webpack/Next.js.
 *
 * wasm-pack generates code like: new URL("data:...", import.meta.url)
 * The import.meta.url argument is unnecessary for data: URLs and causes
 * webpack/Vite to incorrectly try to rewrite the URL as a file path.
 *
 * This plugin transforms:
 *   new URL("data:...", import.meta.url) → new URL("data:...")
 *
 * Uses magic-string to ensure proper source map generation.
 *
 * See: https://github.com/sparkjsdev/spark/issues/95
 */
function fixWasmDataUrl(): Plugin {
  return {
    name: "fix-wasm-data-url",
    renderChunk(code) {
      // Match: new URL("data:...", import.meta.url)
      // The data URL can contain any characters including quotes (escaped)
      const dataUrlPattern =
        /new\s+URL\(\s*("data:[^"]*")\s*,\s*import\.meta\.url\s*\)/g;

      const matches = [...code.matchAll(dataUrlPattern)];
      if (matches.length === 0) return null;

      const magicString = new MagicString(code);
      for (const match of matches) {
        if (match.index === undefined) continue;
        const start = match.index;
        const end = start + match[0].length;
        const replacement = `new URL(${match[1]})`;
        magicString.overwrite(start, end, replacement);
      }

      return {
        code: magicString.toString(),
        map: magicString.generateMap({ hires: true }),
      };
    },
  };
}

const assetsDirectory = "examples/assets";
const localAssetsDirectoryExist = fs.existsSync(assetsDirectory);
if (!localAssetsDirectoryExist) {
  console.log(
    "************************************************************************",
  );
  console.log(" Examples assets will be fetched from an external server.");
  console.log(
    " To work offline you can download them: npm run assets:download",
  );
  console.log(
    "************************************************************************",
  );
}

export default defineConfig(({ mode }) => {
  const isMinify = mode === "production";
  const isFirstPass = mode === "production";

  return {
    appType: "mpa",

    plugins: [
      glsl({
        include: ["**/*.glsl"],
      }),

      dts({ outDir: "dist/types" }),

      // Fix webpack/Next.js compatibility for WASM data URLs
      fixWasmDataUrl(),
      {
        name: "serve-node-modules-alias",
        configureServer(server) {
          const baseUrlPath = "/examples/js/vendor/";

          server.middlewares.use((req, res, next) => {
            if (!req.url.startsWith(baseUrlPath)) return next();

            const relModulePath = req.url.slice(baseUrlPath.length); // safe substring
            const absPath = path.resolve("node_modules", relModulePath);

            if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
              const ext = path.extname(absPath);
              const contentType =
                {
                  ".js": "application/javascript",
                  ".mjs": "application/javascript",
                  ".css": "text/css",
                  ".json": "application/json",
                }[ext] || "application/octet-stream";

              res.setHeader("Content-Type", contentType);
              fs.createReadStream(absPath).pipe(res);
            } else {
              res.statusCode = 404;
              res.end(`Not found: ${relModulePath}`);
            }
          });

          console.log(`📦 Dev alias active: ${baseUrlPath} → node_modules/*`);
        },
      },
    ],

    build: {
      minify: isMinify,
      lib: {
        // Kroscloud fork: the WebGPU module is a SEPARATE, self-contained
        // entry so WebGL2-only consumers never resolve three/webgpu.
        // [ssog-2]: the ssog module is likewise its own entry with the CORE
        // PACKAGE external — SsogSplats extends the consumer's single
        // PagedSplats instance (class identity), base bundles unchanged.
        entry: {
          spark: path.resolve(__dirname, "src/index.ts"),
          "spark-webgpu": path.resolve(__dirname, "src/webgpu/index.ts"),
          "spark-ssog": path.resolve(__dirname, "src/ssog/index.ts"),
        },
        name: "spark",
        formats: ["es", "cjs"],
        fileName: (format, entryName) => {
          const base =
            format === "es" ? `${entryName}.module` : `${entryName}.${format}`;
          return isMinify ? `${base}.min.js` : `${base}.js`;
        },
      },
      sourcemap: true,
      rollupOptions: {
        external: [
          "three",
          "three/tsl",
          "three/webgpu",
          /^three\/addons/,
          // [ssog-2]: the ssog entry imports the core by package name
          "@sparkjsdev/spark",
        ],
        output: {
          globals: {
            three: "THREE",
          },
        },
      },
      emptyOutDir: isFirstPass,
    },

    worker: {
      rollupOptions: {
        treeshake: "smallest",
      },
      plugins: () => [
        glsl({
          include: ["**/*.glsl"],
        }),
      ],
    },

    server: {
      watch: {
        usePolling: true,
      },
      port: 8080,
    },

    optimizeDeps: {
      force: true,
      exclude: ["three"], // prevent Vite pre-bundling
    },

    define: {
      sparkLocalAssets: localAssetsDirectoryExist,
    },
  };
});
