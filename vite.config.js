import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Echte (unkomprimierte) Groesse des Platinen-Modells fuer die Ladeanzeige.
// Server wie GitHub Pages liefern das GLB gzip-komprimiert aus - dann nennt
// Content-Length nur die komprimierte Groesse und der Fortschritt laege > 100 %.
const PLATINE_BYTES = statSync(
  fileURLToPath(new URL("./src/assets/XENSIV_Mouse_with_wheel.glb", import.meta.url))
).size;

export default defineConfig({
  define: {
    __PLATINE_BYTES__: JSON.stringify(PLATINE_BYTES),
  },

  // Relative Asset-Pfade: damit laeuft derselbe Build sowohl unter
  // https://<user>.github.io/<repo>/ als auch unter jeder anderen URL,
  // ohne dass der Repository-Name fest im Code steht.
  base: "./",

  // Verhindert, dass der Kern von Three.js und die Addons (GLTFLoader) je eine
  // eigene Kopie von "three" bekommen - sonst warnt Three beim Start.
  resolve: {
    dedupe: ["three"],
  },
  optimizeDeps: {
    include: [
      "three",
      "three/addons/loaders/GLTFLoader.js",
      "three/addons/utils/BufferGeometryUtils.js",
    ],
  },
  // Das GLB ist mehrere MB gross - nicht inlinen.
  build: {
    assetsInlineLimit: 0,
  },
});
