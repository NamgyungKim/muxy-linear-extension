import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildSync } from "esbuild";

mkdirSync("dist/scripts", { recursive: true });
copyFileSync("package.json", "dist/package.json");
copyFileSync("scripts/quick-open.js", "dist/scripts/quick-open.js");
copyPdfjsAssets();
rewriteDistManifest();

buildSync({
  entryPoints: ["scripts/find-in-files.js"],
  outfile: "dist/scripts/find-in-files.js",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
});

function copyPdfjsAssets() {
  const pdfAssets = resolve("dist", "assets", "pdfjs");
  for (const directory of ["cmaps", "iccs", "standard_fonts", "wasm"]) {
    cpSync(
      resolve("node_modules", "pdfjs-dist", directory),
      resolve(pdfAssets, directory),
      { recursive: true },
    );
  }
}

function rewriteDistManifest() {
  const manifest = JSON.parse(readFileSync("dist/package.json", "utf8"));
  const command = manifest.muxy?.commands?.find((item) => item.id === "files-find-in-files");
  if (command) {
    command.action = { kind: "runScript", script: "scripts/find-in-files.js" };
  }
  writeFileSync("dist/package.json", `${JSON.stringify(manifest, null, 2)}\n`);
}
