import { readFileSync } from "node:fs";

// The main entry must stay universal: no node: imports, Buffer, or unguarded process.
let bad = 0;
for (const f of ["dist/index.js", "dist/index.cjs", "dist/client.js"]) {
  const src = readFileSync(f, "utf8");
  const checks = [
    [/\bnode:/, "node: import"],
    [/\bBuffer\b/, "Buffer"],
    [/\brequire\(["'](fs|path|http|https|crypto|os|stream)["']\)/, "Node builtin require"],
    [/(?<![.\w"'])process\.(?!env)/, "unguarded process"]
  ];
  for (const [re, name] of checks) {
    if (re.test(src)) {
      console.error(`FAIL ${f}: contains ${name}`);
      bad++;
    }
  }
}
if (bad) process.exit(1);
console.log("universal check OK (main + client entries)");
