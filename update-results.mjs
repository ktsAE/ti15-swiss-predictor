#!/usr/bin/env node
/*
  Keeps index.html in step with the tournament. Two tables are written:

      PAIRINGS   who plays whom, straight from Valve's published bracket
      RESULTS    who won, from the games Valve and OpenDota recorded

      node update-results.mjs                 update index.html
      node update-results.mjs --dry           show the change, write nothing
      node update-results.mjs --from f.txt    read saved wikitext instead of
                                              calling the API (for testing)

  Reading the pairings rather than deriving them is the point of PAIRINGS.
  Valve's tiebreak chain ends in average game duration and a coin toss, so a
  bucket that reaches either is not reproducible from outside — round 2 of
  group B was settled on game duration. The page still derives any round
  Valve has not drawn yet, which is what makes it a predictor.

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

// Valve nests the group stage two deep: node_groups[] -> node_groups[] -> the
// one called "Swiss". Walked rather than indexed, because the shape of the
// playoff side of the tree is none of this tool's business.
function groups(j) {
  const out = [];
  const walk = g => { out.push(g); (g.node_groups || []).forEach(walk); };
  (j.node_groups || []).forEach(walk);
  return out;
}

// team_id -> short id. Valve is the authority on who is in the tournament,
// and matching on the number means a mid-event rename cannot lose a series.
function roster(j, unknown) {
  const map = {};
  for (const g of groups(j))
    for (const t of g.team_standings || []) {
      // Valve leaves blank rows for teams it has not seeded yet.
      if (!t.team_id) continue;
      // Valve pads some names — "Nigma Galaxy " arrives with a trailing space.
      const id = IDS[(t.team_name || "").trim().toLowerCase()];
      if (id) map[t.team_id] = id;
      else unknown.add(t.team_name);
    }
  return map;
}

// The pairings themselves, straight from Valve. Every Swiss node it has
// assigned two teams to is a matchup it has committed to, whether or not the
// series has been played — which is the whole point: a round that has been
// drawn but not started is exactly the one this tool used to have to guess,
// and guessing it means reproducing a tiebreak chain that ends in a coin toss.
//
// The round is counted the same lockstep way results are, rather than parsed
// out of the "Match 5.B" names: the letter is the initial group, and rounds 4
// and 5 are not played inside a group at all.
function bracket(j, byId) {
  const swiss = groups(j).find(g => g.name === "Swiss");
  const rounds = { r1: [], r2: [], r3: [], r4: [], r5: [] };
  if (!swiss) return { rounds, drawn: 0 };

  const nodes = (swiss.nodes || [])
    .filter(n => n.team_id_1 && n.team_id_2)
    .sort((a, b) => (a.scheduled_time - b.scheduled_time) || (a.node_id - b.node_id));

  const seen = {};
  let drawn = 0;
  for (const n of nodes) {
    const a = byId[n.team_id_1], b = byId[n.team_id_2];
    const r = Math.min(seen[n.team_id_1] || 0, seen[n.team_id_2] || 0);
    seen[n.team_id_1] = (seen[n.team_id_1] || 0) + 1;
    seen[n.team_id_2] = (seen[n.team_id_2] || 0) + 1;
    if (!a || !b || r > 4) continue;             // unknown team, or past round 5
    rounds["r" + (r + 1)].push([a, b]);
    drawn++;
  }
  return { rounds, drawn };
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
               win: byId[winner], lose: byId[loser],
               // Maps taken by each side, so the page can show 2-1 rather
               // than only who came out of it.
               score: [tally[winner] || 0, tally[loser] || 0] });
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
    rounds[n < 5 ? "r" + (n + 1) : "elim"].push(
      s.score ? [s.win, s.lose, s.score[0], s.score[1]] : [s.win, s.lose]);
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

function rewrite(html, name, keys, rounds) {
  const head = "  var " + name + " = {";
  const start = html.indexOf(head);
  if (start < 0) throw new Error(name + " table not found in index.html");
  const end = html.indexOf("};", start) + 2;

  const width = Math.max(...keys.map(k => k.length));
  const body = keys.map((k, i) => {
    const pairs = rounds[k].map(p => p.length > 3
      ? `["${p[0]}", "${p[1]}", ${p[2]}, ${p[3]}]`
      : `["${p[0]}", "${p[1]}"]`);
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

  return html.slice(0, start) + head + "\n" + body + "\n  };" + html.slice(end);
}

// Every entry in RESULTS starts with two quoted team ids, in both the plain
// and the scored form, so this counts series without caring which table or
// what shape. Used to check a new read against what index.html already has.
function countSeries(html, name) {
  const start = html.indexOf("  var " + name + " = {");
  if (start < 0) return 0;
  const end = html.indexOf("};", start) + 2;
  const block = html.slice(start, end);
  return (block.match(/\[\s*"[a-z0-9]+"\s*,\s*"[a-z0-9]+"/g) || []).length;
}

const RESULT_KEYS = ["r1", "r2", "r3", "r4", "r5", "elim"];
const PAIRING_KEYS = ["r1", "r2", "r3", "r4", "r5"];

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
let rounds = wiki.rounds, live = null, drawn = null;
if (!FROM) {
  try {
    const valve = await getJSON(VALVE);
    const byId = roster(valve, unknown);
    drawn = bracket(valve, byId);
    live = attribute(await decided(byId));
    rounds = live.rounds;
  } catch (e) {
    console.log("Valve/OpenDota unavailable (" + e.message + ")");
    console.log("Falling back to Liquipedia alone.\n");
  }
}

const file = join(HERE, "index.html");
const html = await readFile(file, "utf8");

const total = k => rounds[k].length;
const done = RESULT_KEYS.reduce((n, k) => n + total(k), 0);

// A series, once decided, does not become undecided again — so if this run
// knows about fewer of them than index.html already records, a source is
// lying rather than reporting, and writing that over real results would be
// worse than doing nothing. This has actually happened: Valve's API has
// answered 200 with a literal `null` body, and Liquipedia's editors have
// reset the page to empty {{Match}} stubs mid-tournament, more than once and
// occasionally both in the same run. Either looks like "nothing has been
// played" to the code above, which is indistinguishable from the truth on
// day one but never legitimate once real results exist.
const already = countSeries(html, "RESULTS");
if (done < already) {
  console.error(`This run found ${done} results; index.html already has ${already}. ` +
                "A series can't become undecided, so a source is degraded this cycle " +
                "— leaving index.html alone.");
  process.exit(1);
}

for (const k of RESULT_KEYS) {
  const drawnHere = drawn ? drawn.rounds[k] : null;
  console.log(`  ${k.padEnd(5) } ${total(k) ? total(k) + " played" : "nothing yet"}` +
              (drawnHere && drawnHere.length ? `, ${drawnHere.length} drawn` : ""));
}

console.log(`\n${done} series finished, ${44 - done} still to play`);
if (drawn) console.log(`${drawn.drawn} of 39 group-stage pairings drawn by Valve`);

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

let next = rewrite(html, "RESULTS", RESULT_KEYS, rounds);

// The pairings table is only ever rewritten from Valve, and only when Valve
// actually answered with a round-1 draw. Liquipedia does not feed it, so a
// Valve outage must leave the existing table alone rather than blank the
// bracket down to nothing.
if (drawn && drawn.rounds.r1.length)
  next = rewrite(next, "PAIRINGS", PAIRING_KEYS, drawn.rounds);
else
  console.log("\nNo draw from Valve this run — leaving PAIRINGS as they are.");

if (next === html) { console.log("\nindex.html is already up to date."); process.exit(0); }
if (DRY) {
  console.log("\n--dry: index.html not written. It would become:\n");
  for (const name of ["PAIRINGS", "RESULTS"]) {
    const at = next.indexOf("  var " + name + " = {");
    if (at >= 0) console.log(next.slice(at, next.indexOf("};", at) + 2) + "\n");
  }
  process.exit(0);
}

await writeFile(file, next);
console.log("\nindex.html updated. Redeploy to publish.");
