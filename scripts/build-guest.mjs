#!/usr/bin/env node
// Builds the guest page as a static site in site/, published to GitHub Pages. The page holds no
// session data: each invitation link carries the relay, the host's key, and the secret in its
// fragment.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { darkHighlightColors, lightHighlightColors } from "@getpaseo/highlight";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "site");

/** The commit the page was built from, shown to guests so they can tell which code runs. */
function buildCommit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 12);
  try {
    const sha = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: root })
      .toString()
      .trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root }).toString().trim();
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return "unversioned";
  }
}

const result = await build({
  entryPoints: [path.join(root, "guest", "main.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  jsx: "automatic",
  minify: true,
  legalComments: "none",
  define: {
    "process.env.NODE_ENV": '"production"',
    __GUEST_BUILD__: JSON.stringify(buildCommit()),
  },
  write: false,
  logLevel: "warning",
});
const script = result.outputFiles[0]?.text;
if (!script) throw new Error("Guest bundle produced no output");

/** Syntax colors from Paseo's own palette, as classes the page's spans use. */
function highlightCss() {
  const rules = (colors) =>
    Object.entries(colors)
      .map(([style, color]) => `.hl-${style} { color: ${color}; }`)
      .join("\n");
  return `\n/* Syntax colors from @getpaseo/highlight */\n${rules(lightHighlightColors)}\n@media (prefers-color-scheme: dark) {\n${rules(darkHighlightColors)}\n}\n`;
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
writeFileSync(
  path.join(outDir, "index.html"),
  readFileSync(path.join(root, "guest", "index.html")),
);
writeFileSync(path.join(outDir, "guest.js"), script);
writeFileSync(
  path.join(outDir, "guest.css"),
  readFileSync(path.join(root, "guest", "styles.css"), "utf8") + highlightCss(),
);
// Serve files as they are; GitHub Pages would otherwise run Jekyll over the site.
writeFileSync(path.join(outDir, ".nojekyll"), "");
console.log(`Guest page: ${(script.length / 1024).toFixed(1)} KiB script in site/`);
