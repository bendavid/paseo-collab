#!/usr/bin/env node
// Builds the guest page as a static site in site/, published to GitHub Pages. The page holds no
// session data: each invitation link carries the relay, the host's key, and the secret in its
// fragment.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  metafile: true,
  logLevel: "warning",
});
const script = result.outputFiles[0]?.text;
if (!script) throw new Error("Guest bundle produced no output");

/**
 * License texts of every npm package bundled into the page, so the published site carries the
 * notices its MIT, Apache-2.0, and other licensed dependencies require.
 */
function thirdPartyLicenses(metafile) {
  const packageDirs = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
    if (match) packageDirs.add(path.resolve(root, match[1]));
  }
  const sections = [...packageDirs]
    .map((dir) => {
      const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
      const licenseFile = readdirSync(dir).find((name) =>
        /^(licen[cs]e|copying|notice)/i.test(name),
      );
      // Paseo's published packages carry no license file or field; the Paseo repository licenses
      // them under Apache-2.0 (third-party/paseo-LICENSE.txt is its LICENSE).
      const paseo = !licenseFile && manifest.name.startsWith("@getpaseo/");
      const license = manifest.license ?? (paseo ? "Apache-2.0" : "unknown");
      const text = licenseFile
        ? readFileSync(path.join(dir, licenseFile), "utf8").trim()
        : paseo
          ? readFileSync(path.join(root, "third-party", "paseo-LICENSE.txt"), "utf8").trim()
          : `License: ${license} (the package ships no license file)`;
      return {
        name: manifest.name,
        heading: `${manifest.name}@${manifest.version} (${license})`,
        text,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const rule = "=".repeat(78);
  return (
    "Third-party software bundled into the Paseo Collab guest page (guest.js).\n\n" +
    sections.map(({ heading, text }) => `${rule}\n${heading}\n${rule}\n\n${text}\n`).join("\n")
  );
}

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
writeFileSync(path.join(outDir, "third-party-licenses.txt"), thirdPartyLicenses(result.metafile));
// Serve files as they are; GitHub Pages would otherwise run Jekyll over the site.
writeFileSync(path.join(outDir, ".nojekyll"), "");
console.log(`Guest page: ${(script.length / 1024).toFixed(1)} KiB script in site/`);
