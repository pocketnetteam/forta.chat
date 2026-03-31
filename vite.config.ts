/// <reference types="vitest" />
import vue from "@vitejs/plugin-vue";
import path from "path";
import AutoImport from "unplugin-auto-import/vite";
import Components from "unplugin-vue-components/vite";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  test: {
    globals: true,
    environment: "happy-dom",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/test-setup.ts"],
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
  build: {
    target: "es2020",
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
