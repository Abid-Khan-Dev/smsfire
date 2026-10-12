import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

// Minify the main entry with esbuild, then gzip, to measure the size users would ship.
const out = await build({ entryPoints: ["dist/index.js"], bundle: true, minify: true, format: "esm", write: false, platform: "neutral" });
const gz = gzipSync(out.outputFiles[0].contents).length;
const kb = (gz / 1024).toFixed(2);
console.log(`main entry min+gzip: ${kb} kB (goal <= 8, hard limit 12)`);
if (gz > 12 * 1024) {
  console.error("FAIL: main entry exceeds 12 kB");
  process.exit(1);
}
