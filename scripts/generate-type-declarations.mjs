// Writes auto-imports.d.ts and components.d.ts (both gitignored) without a
// full build. unplugin-auto-import / unplugin-vue-components emit them when
// the Vite server starts; vue-tsc needs them, so a fresh checkout (CI) runs
// this before the type check. `npm run build` gets them from `vite build`.
import { createServer } from "vite";

const server = await createServer({ logLevel: "error", server: { middlewareMode: true } });
// The plugins write the files asynchronously after startup.
await new Promise((resolve) => setTimeout(resolve, 3000));
await server.close();
console.log("[types] auto-imports.d.ts and components.d.ts written");
