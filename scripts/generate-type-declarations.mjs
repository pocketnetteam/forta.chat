// Writes auto-imports.d.ts and components.d.ts (both gitignored) without a
// full build. unplugin-auto-import / unplugin-vue-components write them while
// the Vite server starts up and shuts down; vue-tsc needs them, so a fresh
// checkout (CI) runs this before the type check. `npm run build` gets them
// from `vite build`. Checked afterwards: a run that left them unwritten used
// to surface only as a wall of "Cannot find name 'ref'" from vue-tsc.
import { existsSync } from "node:fs";
import { createServer } from "vite";

const FILES = ["auto-imports.d.ts", "components.d.ts"];

const server = await createServer({ logLevel: "error", server: { middlewareMode: true } });
// The plugins write the files asynchronously after startup.
await new Promise((resolve) => setTimeout(resolve, 3000));
await server.close();

const missing = FILES.filter((f) => !existsSync(f));
if (missing.length > 0) {
  console.error(`[types] not written: ${missing.join(", ")} — vue-tsc would not see auto-imported names`);
  process.exit(1);
}
console.log("[types] auto-imports.d.ts and components.d.ts written");
