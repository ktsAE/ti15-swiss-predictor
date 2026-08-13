#!/usr/bin/env node
/*
  Reads the finished series off Liquipedia's TI 2026 group-stage page and
  writes them into the RESULTS table in index.html.

      node update-results.mjs                 update index.html
      node update-results.mjs --dry           show the change, write nothing
      node update-results.mjs --from f.txt    read saved wikitext instead of
                                              calling the API (for testing)

  This runs on your machine, not in the page. The page is a single static
  file with no network access at all: the Artifact host blocks outbound
  requests outright, and Liquipedia's API terms ask for a descriptive
  User-Agent and a low request rate, neither of which a visitor's browser
  can honour. So results are baked in here and the page stays offline.

  Liquipedia asks for at most one parse request every 30 seconds. This makes
  exactly one per run, so anything from a manual run to a cron every few
  minutes is well inside that.
*/

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = "The_International/2026/Group_Stage";
const API = "https://liquipedia.net/dota2/api.php";

// Two independent sources, because on day one Liquipedia's editors blanked
// four finished round-1 matches back to empty {{Match}} stubs while
// restructuring the page. Read on its own it reported nothing had been
// played, which was wrong and would have quietly stalled the bracket.
//
// Valve names the sixteen teams and gives their numeric ids; OpenDota
// reports the games those ids actually played. Neither depends on anyone
// editing a wiki, so together they carry the tournament even when the page
// is mid-rewrite. Both are keyless.
const LEAGUE = 19719;
const VALVE = "https://www.dota2.com/webapi/IDOTA2League/GetLeagueData/v001/?league_id=" + LEAGUE;
const OPENDOTA = "https://api.opendota.com/api/leagues/" + LEAGUE + "/matches";

// Liquipedia's API terms require a descriptive agent with a way to reach the
// operator. Swap in your own address if you would rather they mail you.
const AGENT = "TI15SwissPredictor/1.0 (static bracket tool; " +
              "contact: https://github.com/ktsAE/ti15-swiss-predictor)";

// Liquipedia writes the full team name; the page keys off short ids.
const IDS = {
  "team falcons": "flcn", "lgd gaming": "lgd", "iron wing": "1w", "1win": "1w",
  "nigma galaxy": "ngx", "boomboys": "bb", "betboom team": "bb", "og": "og",
  "team vision": "pari", "parivision": "pari", "team resilience": "tr",
  "team spirit": "ts", "xtreme gaming": "xg", "team liquid": "liq",
  "vici gaming": "vg", "aurora": "aur", "aurora gaming": "aur",
  "gamerlegion": "gl", "team yandex": "yndx", "huligani": "l1ga",
  "l1ga team": "l1ga"
};

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");
const fromAt = argv.indexOf("--from");
const FROM = fromAt >= 0 ? argv[fromAt + 1] : null;

/* ---------------- wikitext ---------------- */

// Returns the body of the {{...}} that starts at `open`, brace-balanced.
function template(text, open) {
  let depth = 0;
  for (let i = open; i < text.length - 1; i++) {
    if (text[i] === "{" && text[i + 1] === "{") { depth++; i++; continue; }
    if (text[i] === "}" && text[i + 1] === "}") {
      depth--; i++;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}

function opponent(body, n) {
  const m = body.match(new RegExp("opponent" + n + "\\s*=\\s*\\{\\{\\w*Opponent\\|([^|}\\n]*)"));
  return m ? m[1].trim() : "";
}

// Bo3: whoever takes two maps. A match-level winner= wins outright if present.
function seriesWinner(body) {
  const direct = body.match(/^\|winner\s*=\s*([12])\s*$/m);
  if (direct) return +direct[1];

  let a = 0, b = 0;
  for (const map of body.matchAll(/\{\{Map[\s\S]*?\n\}\}/g)) {
    const w = map[0].match(/\|winner\s*=\s*([12])/);
    if (!w) continue;
    if (w[1] === "1") a++; else b++;
  }
  if (a >= 2) return 1;
  if (b >= 2) return 2;
  return 0;
}

/* ---------------- collect ---------------- */

function collect(wikitext) {
  const rounds = { r1: [], r2: [], r3: [], r4: [], r5: [], elim: [] };
  const unknown = new Set();
  let pending = 0, done = 0, skipped = 0;

  // Walk every {{Match}}, attributing it to the most recent section heading.
  let bucket = null;
  const marks = [];
  for (const m of wikitext.matchAll(/title=Round (\d)|\{\{Bracket\|[^|]*\|id=TI2026Elim|\{\{Match\b/g)) {
    marks.push({ at: m.index, text: m[0] });
  }

  for (const mark of marks) {
    if (mark.text.startsWith("title=Round")) { bucket = "r" + mark.text.slice(-1); continue; }
    if (mark.text.startsWith("{{Bracket")) { bucket = "elim"; continue; }
    if (!bucket) continue;

    const body = template(wikitext, mark.at);
    const one = opponent(body, 1), two = opponent(body, 2);
    if (!one || !two) { pending++; continue; }

    const w = seriesWinner(body);
    if (!w) { pending++; continue; }

    const win = w === 1 ? one : two;
    const lose = w === 1 ? two : one;
    const wid = IDS[win.toLowerCase()], lid = IDS[lose.toLowerCase()];
    if (!wid) unknown.add(win);
    if (!lid) unknown.add(lose);
    if (!wid || !lid) { skipped++; continue; }

    rounds[bucket].push([wid, lid]);
    done++;
  }

  return { rounds, pending, done, skipped, unknown: [...unknown] };
}

/* ---------------- Valve + OpenDota ---------------- */

async function getJSON(url) {
  const res = await fetch(url, { headers: { "User-Agent": AGENT, "Accept-Encoding": "gzip" } });
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${res.statusText}`);
  return res.json();
}

// team_id -> short id. Valve is the authority on who is in the tournament,
// and matching on the number means a mid-event rename cannot lose a series.
async function roster(unknown) {
  const j = await getJSON(VALVE);
  const map = {};
  for (const g of j.node_groups || [])
    for (const t of g.team_standings || []) {
      // Valve pads some names — "Nigma Galaxy " arrives with a trailing space.
      const id = IDS[(t.team_name || "").trim().toLowerCase()];
      if (id) map[t.team_id] = id;
      else unknown.add(t.team_name);
    }
  return map;
}

// Games grouped into series. series_type gives the length, so Bo1 and Bo5
// are handled rather than assuming every series is a Bo3.
async function decided(byId) {
  const series = new Map();
  for (const g of await getJSON(OPENDOTA)) {
    const k = g.series_id || "solo-" + g.match_id;
    if (!series.has(k)) series.set(k, []);
    series.get(k).push(g);
  }

  const need = { 0: 1, 1: 2, 2: 3 };
  const out = [];
  for (const games of series.values()) {
    const tally = {};
    for (const g of games) {
      const w = g.radiant_win ? g.radiant_team_id : g.dire_team_id;
      tally[w] = (tally[w] || 0) + 1;
    }
    const winner = Object.keys(tally).find(t => tally[t] >= (need[games[0].series_type] ?? 1));
    if (!winner) continue;                       // still being played
    const teams = [...new Set(games.flatMap(g => [g.radiant_team_id, g.dire_team_id]))];
    const loser = teams.find(t => String(t) !== String(winner));
    if (!byId[winner] || !byId[loser]) continue; // not a group-stage team
    out.push({ at: Math.min(...games.map(g => g.start_time)),
               win: byId[winner], lose: byId[loser] });
  }
  return out.sort((a, b) => a.at - b.at);
}

// Swiss is lockstep — every surviving team plays exactly once per round — so
// a series belongs to round (series its two teams have already played) + 1.
// That holds for this format's 8,8,8,8,7 rounds plus the elimination round;
// it is not a general rule, and TI2025's different shape would break it.
function attribute(list) {
  const rounds = { r1: [], r2: [], r3: [], r4: [], r5: [], elim: [] };
  const seen = {};
  let beyond = 0;
  for (const s of list) {
    const n = Math.min(seen[s.win] || 0, seen[s.lose] || 0);
    if (n > 5) { beyond++; continue; }           // playoffs, not our concern
    rounds[n < 5 ? "r" + (n + 1) : "elim"].push([s.win, s.lose]);
    seen[s.win] = (seen[s.win] || 0) + 1;
    seen[s.lose] = (seen[s.lose] || 0) + 1;
  }
  return { rounds, beyond };
}

// Anything the wiki asserts that the game data contradicts is worth saying
// out loud rather than silently preferring one side.
function disagreements(wiki, live) {
  const key = p => [p[0], p[1]].sort().join("|");
  const out = [];
  for (const r of ["r1", "r2", "r3", "r4", "r5", "elim"]) {
    const byPair = new Map(live[r].map(p => [key(p), p[0]]));
    for (const p of wiki[r]) {
      const winner = byPair.get(key(p));
      if (winner === undefined)
        out.push(`${r}: Liquipedia has ${p[0]} over ${p[1]}, game data has no such series`);
      else if (winner !== p[0])
        out.push(`${r}: Liquipedia says ${p[0]} won, game data says ${winner} did`);
    }
  }
  return out;
}

/* ---------------- write ---------------- */

function rewrite(html, rounds) {
  const start = html.indexOf("  var RESULTS = {");
  if (start < 0) throw new Error("RESULTS table not found in index.html");
  const end = html.indexOf("};", start) + 2;

  const keys = ["r1", "r2", "r3", "r4", "r5", "elim"];
  const width = Math.max(...keys.map(k => k.length));
  const body = keys.map((k, i) => {
    const pairs = rounds[k].map(p => `["${p[0]}", "${p[1]}"]`);
    const pad = " ".repeat(width - k.length + 1);
    const comma = i === keys.length - 1 ? "" : ",";
    if (!pairs.length) return `    ${k}:${pad}[]${comma}`;

    // Wrap so a full round stays readable.
    const lines = [];
    let line = "";
    for (const p of pairs) {
      if (line && (line + ", " + p).length > 68) { lines.push(line); line = ""; }
      line = line ? line + ", " + p : p;
    }
    if (line) lines.push(line);
    const indent = " ".repeat(`    ${k}:${pad}[`.length);
    return `    ${k}:${pad}[` + lines.join(",\n" + indent) + `]${comma}`;
  }).join("\n");

  return html.slice(0, start) + "  var RESULTS = {\n" + body + "\n  };" + html.slice(end);
}

/* ---------------- run ---------------- */

// Neither source is allowed to take the run down on its own. Either one can
// time out, and this job runs unattended every ten minutes — a blip should
// cost one cycle, not stall the bracket until someone notices a red build.
let wikitext = "";
if (FROM) {
  wikitext = await readFile(FROM, "utf8");
  console.log(`reading ${FROM} instead of calling Liquipedia\n`);
} else {
  const url = `${API}?action=parse&page=${encodeURIComponent(PAGE)}&prop=wikitext&format=json`;
  try {
    // Accept-Encoding: gzip is required, not polite — Liquipedia answers an
    // uncompressed request with 406 and an HTML error page, which parses as
    // neither wikitext nor JSON.
    const json = await getJSON(url);
    if (json.error) throw new Error(json.error.info);
    wikitext = json.parse.wikitext["*"];
  } catch (e) {
    console.log("Liquipedia unavailable (" + e.message + ")\n");
  }
}

const wiki = collect(wikitext);
const unknown = new Set(wiki.unknown);

// Game data wins. It is derived from the matches Valve actually recorded,
// so it cannot be blanked by a wiki edit; Liquipedia is kept as a second
// opinion and its disagreements are reported rather than applied.
let rounds = wiki.rounds, live = null;
if (!FROM) {
  try {
    live = attribute(await decided(await roster(unknown)));
    rounds = live.rounds;
  } catch (e) {
    console.log("Valve/OpenDota unavailable (" + e.message + ")");
    console.log("Falling back to Liquipedia alone.\n");
  }
}

// Writing an empty table because both sources were unreachable would erase
// results the page already has. Nothing known means nothing to say.
if (!live && !wikitext) {
  console.error("Both sources unreachable — leaving index.html alone.");
  process.exit(1);
}

const total = k => rounds[k].length;
for (const k of ["r1", "r2", "r3", "r4", "r5", "elim"])
  console.log(`  ${k.padEnd(5)} ${total(k) ? total(k) + " played" : "nothing yet"}`);

const done = ["r1", "r2", "r3", "r4", "r5", "elim"].reduce((n, k) => n + total(k), 0);
console.log(`\n${done} series finished, ${44 - done} still to play`);

if (live) {
  const off = disagreements(wiki.rounds, live.rounds);
  console.log(`source: Valve + OpenDota (Liquipedia lists ${wiki.done})`);
  if (off.length) {
    console.log("\nSources disagree — game data was used:");
    off.forEach(m => console.log("  " + m));
  }
  if (live.beyond) console.log(`${live.beyond} series past the group stage ignored`);
}

if (unknown.size) {
  console.log("\nNot in the team list, so skipped: " + [...unknown].join(", "));
  console.log("Add them to IDS in this script.");
}

const file = join(HERE, "index.html");
const html = await readFile(file, "utf8");
const next = rewrite(html, rounds);

if (next === html) { console.log("\nindex.html already matches Liquipedia."); process.exit(0); }
if (DRY) {
  console.log("\n--dry: index.html not written. It would become:\n");
  console.log(next.slice(next.indexOf("  var RESULTS = {"), next.indexOf("};", next.indexOf("  var RESULTS = {")) + 2));
  process.exit(0);
}

await writeFile(file, next);
console.log("\nindex.html updated. Redeploy to publish.");
