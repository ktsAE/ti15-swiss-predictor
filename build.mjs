#!/usr/bin/env node
/*
  Wraps index.html into a standalone page in public/, which is what the host
  serves, and writes the _headers file next to it.

  index.html is written for the Artifact host, which supplies the doctype,
  <head> and a CSS reset itself — so the source starts at <title> and must
  stay that way. Served raw over HTTP that means quirks mode and no viewport
  meta, which on a phone renders the whole page zoomed out. This adds the
  skeleton the browser needs, and nothing else: same markup, same script,
  still a single file with no external requests.
*/

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "index.html");
const OUT = join(HERE, "public", "index.html");
const HEADERS = join(HERE, "public", "_headers");

// Cloudflare Pages and Netlify both read this file, so the security headers
// travel with the build rather than living in one host's config. public/ is
// generated and git-ignored, so it has to be written here to exist at all.
//
// One rule covers everything because the build is one file. That includes
// the cache policy: results change during the event, and a bracket sitting
// stale in somebody's cache is the failure that matters here.
const HEADER_RULES = `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'
  Cache-Control: public, max-age=0, must-revalidate
`;

const DESCRIPTION =
  "Pick the winners of The International 2026 group stage and watch every " +
  "later pairing re-derive under Valve's official Swiss rules.";

const body = await readFile(SRC, "utf8");

if (/<!doctype|<html[\s>]|<head[\s>]/i.test(body)) {
  console.error("index.html already has a document skeleton — it is meant to " +
                "start at <title>. Refusing to wrap it twice.");
  process.exit(1);
}

const title = (body.match(/<title>([^<]*)<\/title>/) || [])[1] || "TI15 Swiss Predictor";

// The title tag moves into <head>; everything else is the body as-is.
const inner = body.replace(/<title>[^<]*<\/title>\s*/, "");

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${DESCRIPTION}">
<meta name="color-scheme" content="light dark">
<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${DESCRIPTION}">
<meta name="twitter:card" content="summary">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='13' font-size='14'>%F0%9F%8F%86</text></svg>">
<style>
  /* The Artifact host ships these; a bare browser does not. */
  html { -webkit-text-size-adjust: 100%; }
  body { margin: 0; }
</style>
</head>
<body>
${inner}
</body>
</html>
`;

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, page);
await writeFile(HEADERS, HEADER_RULES);

const kb = n => (n / 1024).toFixed(1) + " KB";
console.log(`public/index.html  ${kb(page.length)}  (source ${kb(body.length)})`);
console.log(`public/_headers    ${HEADER_RULES.split("\n").length - 2} headers`);
