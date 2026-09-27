/// <reference types="vitest" />
import vue from "@vitejs/plugin-vue";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import AutoImport from "unplugin-auto-import/vite";
import Components from "unplugin-vue-components/vite";
import { defineConfig } from "vite";
import { downlevelForOldWebView } from "./scripts/lib/downlevel-public-js.mjs";

// public/js holds the Bastyon SDK, which Vite copies verbatim. Lower its syntax
// to the bundle's chrome60 target in every `vite build` (Android, iOS, Electron
// and web all build this way), or WebView < 80 fails on `?.` / `??` and the app
// has no SDK for login or registration (audit W2B-01).
function downlevelPublicJs() {
  let outDir = "";
  return {
    name: "downlevel-public-js",
    apply: "build" as const,
    configResolved(config: { root: string; build: { outDir: string } }) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle(this: { warn: (message: string) => void }) {
      const jsDir = path.join(outDir, "js");
      if (!existsSync(jsDir)) return;
      for (const rel of readdirSync(jsDir, { recursive: true }) as string[]) {
        if (!rel.endsWith(".js")) continue;
        const file = path.join(jsDir, rel);
        const code = readFileSync(file, "utf8");
        try {
          const lowered = downlevelForOldWebView(code);
          if (lowered !== code) writeFileSync(file, lowered);
        } catch (e) {
          this.warn(`js/${rel}: syntax not lowered (${String(e).split("\n")[0]})`);
        }
      }
    },
  };
}

export default defineConfig({
  base: "./",
  test: {
    globals: true,
    environment: "happy-dom",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    setupFiles: ["./src/test-setup.ts"],
    // Prevent cross-file mock/timer pollution (call-service, sync-engine races).
    fileParallelism: false,
    // entities/local-ai's tests construct a real `local-ai` LocalAiClient
    // against `local-ai/adapters/node-testing`'s NodeSqliteAdapter (node:sqlite),
    // which is still experimental on Node 22 — mirrors local-ai's own
    // `test:*` scripts (`NODE_OPTIONS=--experimental-sqlite`). Harmless for
    // every other test file, which never touches node:sqlite.
    execArgv: ["--experimental-sqlite"],
    // local-ai/adapters/node-testing imports node-llama-cpp at top level, but it
    // is only local-ai's devDependency and never installed here. Our tests use
    // the Fake*/Node* adapters, so point it at a stub; inlining local-ai makes
    // the alias apply inside the package too.
    alias: {
      "node-llama-cpp": path.resolve(__dirname, "./src/test-utils/node-llama-cpp-stub.ts"),
    },
    server: { deps: { inline: ["local-ai"] } },
  },
  plugins: [
    vue(),
    // Strip `crossorigin` from HTML — breaks Electron's file:// protocol
    {
      name: "strip-crossorigin",
      transformIndexHtml(html) {
        return html.replace(/ crossorigin/g, "");
      },
    },
    downlevelPublicJs(),
    Components({
      deep: true,
      dirs: ["src/shared/ui"],
      dts: true
    }),
    AutoImport({
      imports: [
        "vue",
        "vue-router",
        { "@/shared/lib/i18n": ["useI18n"] },
      ],
      include: [
        /\.[tj]sx?$/,
        /\.vue$/,
        /\.vue\?vue/
      ],
      dts: true
    })
  ],
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
  },
  define: {
    global: "globalThis",
    "process.env": {},
    "process.browser": true,
    "process.version": JSON.stringify(""),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@app": path.resolve(__dirname, "./src/app"),
      "@pages": path.resolve(__dirname, "./src/pages"),
      "@widgets": path.resolve(__dirname, "./src/widgets"),
      "@features": path.resolve(__dirname, "./src/features"),
      "@entities": path.resolve(__dirname, "./src/entities"),
      "@shared": path.resolve(__dirname, "./src/shared"),
      buffer: "buffer",
      stream: "stream-browserify",
    }
  },
  esbuild: {
    // Allow BigInt literals through — Chrome 60 lacks native BigInt but real
    // Android devices receive WebView updates via Play Store (Chrome 100+).
    // @noble/secp256k1 relies on BigInt; blocking it breaks the build.
    supported: { bigint: true },
  },
  build: {
    // Chrome 60 target matches Android minSdk 24 baseline WebView.
    // Downlevels optional chaining, nullish coalescing, logical assignment
    // so old WebView can parse the bundle without SyntaxError.
    target: "chrome60",
    minify: "terser",
    terserOptions: {
      compress: { drop_console: false, passes: 2 },
      format: { comments: false },
    },
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("matrix-js-sdk") || id.includes("@matrix-org")) return "matrix";
          if (id.includes("node_modules/vue") || id.includes("vue-router") || id.includes("pinia")) return "vue-core";
          if (id.includes("vue-virtual-scroller")) return "virtual-scroller";
          if (id.includes("node_modules/buffer") || id.includes("stream-browserify") || id.includes("pbkdf2") || id.includes("create-hash") || id.includes("bn.js")) return "crypto-polyfills";
        },
      },
    },
    chunkSizeWarningLimit: 800,
  },
  watch: {
    ignored: ['**/node_modules/**', '**/.git/**'],
  },
});
