import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    client: "src/client.ts",
    express: "src/express.ts",
    fetch: "src/fetch.ts",
    mongoose: "src/mongoose.ts",
    cli: "src/cli.ts"
  },
  format: ["esm", "cjs"],
  dts: { entry: { index: "src/index.ts", client: "src/client.ts", express: "src/express.ts", fetch: "src/fetch.ts", mongoose: "src/mongoose.ts" } },
  target: "es2022",
  platform: "neutral",
  clean: true,
  minify: false,
  treeshake: true,
  splitting: false,
  outExtension: ({ format }) => ({ js: format === "cjs" ? ".cjs" : ".js" })
});
