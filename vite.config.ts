/// <reference types="vitest" />
import vue from "@vitejs/plugin-vue";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import AutoImport from "unplugin-auto-import/vite";
import Components from "unplugin-vue-components/vite";
import { defineConfig } from "vite";
import { downlevelForOldWebView } from "./scripts/lib/downlevel-public-js.mjs";
import { manualChunks } from "./scripts/lib/vite-manual-chunks.mjs";

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
    // Building a happy-dom window costs ~0.7 s per file, so files run in plain
    // Node by default. A file that needs browser APIs (document, window,
    // localStorage, location, @vue/test-utils mount) opts in with a first line
    // `// @vitest-environment happy-dom`.
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    setupFiles: ["./src/test-setup.ts"],
    // Files run in parallel, each in its own forked process (isolate is on),
    // so mocks and fake timers cannot leak between files.
    // Many tests `await import()` a heavy module graph (chat-store, call-service,
    // .vue components) inside the test or hook. A cold import under parallel
    // load can take several seconds, so the defaults (5 s / 10 s) flake.
    testTimeout: 15_000,
    hookTimeout: 30_000,
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
    // Tests import Node CLI scripts (scripts/*.mjs) that start with
    // `#!/usr/bin/env node`. Vitest's transform puts its import-interop lines
    // above the shebang, and the module no longer parses ("Invalid character
    // `!`"). Turn the shebang into a comment — same line count, so stack
    // traces keep their line numbers. Test runs only; builds never see it.
    {
      name: "test-strip-shebang",
      enforce: "pre",
      apply: () => !!process.env.VITEST,
      transform(code, id) {
        if (!code.startsWith("#!") || !/\.[cm]?js$/.test(id.split("?")[0])) return null;
        return { code: `//${code.slice(2)}`, map: null };
      },
    },
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
        manualChunks,
      },
    },
    chunkSizeWarningLimit: 800,
  },
  watch: {
    ignored: ['**/node_modules/**', '**/.git/**'],
  },
});
