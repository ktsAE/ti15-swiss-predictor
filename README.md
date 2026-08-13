# TI15 Swiss Predictor

An interactive bracket for the group stage of The International 2026. Pick the
winner of any series and every later pairing re-derives itself under Valve's
actual rules — including the two-group draw, the pick-your-opponent
elimination round, and the round-5 rule that pairs teams as far apart in the
standings as possible when the loser goes home.

No dependencies, no build tooling, no network access at runtime. One HTML file.

## The pieces

| file | what it is |
| --- | --- |
| `index.html` | the whole app: markup, styles and the pairing engine |
| `build.mjs` | wraps `index.html` into a standalone page under `public/` |
| `update-results.mjs` | pulls Valve's draw and the finished series into `index.html` |
| `netlify.toml` | Netlify's copy of the same build and header settings |
| `.node-version` | pins Node 20 for the host's build image |

`index.html` is written for Claude's Artifact host, which supplies the doctype
and `<head>` itself — so the source starts at `<title>`. `build.mjs` adds that
skeleton for anywhere else. Edit `index.html`; never edit `public/`.

## Running it

Open `index.html` in a browser. That is the whole development loop.

## Where the pairings come from

Two tables near the top of the script drive everything.

`PAIRINGS` is Valve's published draw, a round at a time:

```js
r2: [["pari", "flcn"], ["bb", "1w"], ["lgd", "tr"], ["ngx", "og"], ...]
```

A round in there is used exactly as written. Only a round Valve has not drawn
yet is worked out from the rules — which matters, because Valve's tiebreak
chain ends in average game duration and a coin toss, and a bucket that gets
that far cannot be reproduced from outside. Round 2 of group B was decided on
game duration.

A published round is trusted only while everything before it came from real
results. Once you pick a winner yourself the bracket is yours, not Valve's,
and every round after that is derived. A draw that does not pair exactly the
teams still playing, each once, is rejected and derived instead: half a round,
or one left over from results that have since changed, would otherwise show a
team playing twice.

## Filling in results as the tournament runs

Series that have actually been played live in the `RESULTS` table, winner
first, in the round they belong to:

```js
r1: [["flcn", "lgd", 2, 1], ["1w", "ngx", 2, 0]]   // Falcons beat LGD 2-1, Iron Wing beat Nigma 2-0
```

The two numbers are the map score, and they matter beyond display: percentage
of games won is Valve's third ranking criterion, ahead of opponents' wins.
Everyone in a pairing bucket has the same win-loss record by definition, so
the maps they dropped getting there are usually what decides who they play
next. A bare pair still locks the series, but it is counted as 2-1 and the
following round may pair wrongly. `update-results.mjs` always writes the
score.

A locked series renders as final, cannot be clicked, and survives "Clear
picks", so a visitor arriving mid-event only picks what is still open.
Everything downstream keeps deriving from it.

Fill rounds in order — a round's pairings are not settled until everything
before it is. Anything that is not a pairing the rules produce gets flagged in
a banner on the page rather than silently ignored.

You can fill the table by hand, or let the updater do it:

```
node update-results.mjs --dry     # show what would change
node update-results.mjs           # write it into index.html
```

It takes `PAIRINGS` from Valve's own bracket and `RESULTS` from the games
Valve and OpenDota recorded, using Liquipedia only as a cross-check — anything
the wiki asserts that the game data contradicts is printed rather than
silently resolved. A series is recorded only once it is actually decided, and
any team it cannot match is skipped loudly. One request per source per run,
well inside every rate limit.

`PAIRINGS` is only ever rewritten when Valve answers with a round-1 draw, so
an outage leaves the existing bracket alone rather than blanking it.

## Deploying

Any static host works: build with `node build.mjs`, serve `public/`. The build
also writes `public/_headers`, so the security and cache headers travel with
the output rather than living in one host's config file.

**Cloudflare** is what this is set up for — either classic Pages or the newer
Workers-with-assets, which is what "Connect to Git" defaults to now. Connect
the repo, then set:

| setting | value |
| --- | --- |
| build command | `node build.mjs` |
| build output directory | `public` |

`wrangler.jsonc` pins `assets.directory` to `./public` as well. It is not
redundant with the dashboard setting: on Workers-with-assets, a project with
no Wrangler config falls back to deploying the repo as-is, which serves
`index.html` — the unwrapped Artifact source, missing `<meta charset>` among
other things — instead of running the build at all. `.node-version` pins
Node 20 so the build does not land on a default old enough to choke on ESM
and top-level await.

The free plan allows 500 builds a month with unmetered bandwidth, which
matters: a full group stage is 44 results and therefore 44 deploys. Netlify's
free plan moved to a credit model that charges 15 credits per production
deploy against 300 a month — about 20 deploys before the site goes offline
until the 1st. `netlify.toml` is still here and still correct if you want it,
but it will not survive a tournament on the free plan.

The loop is closed by `.github/workflows/update-results.yml`, which runs the
updater every ten minutes on GitHub's runners and commits `index.html` when a
series has finished. That push is what triggers the rebuild, so a result
reaches the site about a minute after Valve records it — with no machine of
your own needing to be awake at 05:00 for a Shanghai start time.

It commits only when something changed, so a commit in the log means a real
result landed. `workflow_dispatch` lets you run it by hand from the Actions
tab.

The commit is scoped to `index.html` rather than `git commit -a`. This job
runs unattended against a public repo, and `-a` would publish anything else
that happened to be modified in the tree.

A local scheduler works too, but only while the machine is on:

```
*/10 * * * * cd ~/swissPret && node update-results.mjs && \
             git commit -m results -- index.html && git push
```

## Credit

Format, rules and the round-1 draw come from
[Liquipedia](https://liquipedia.net/dota2/The_International/2026), CC-BY-SA.
An unofficial fan tool, not affiliated with Valve.

The tool stops at the eight teams who reach the main event. Valve has not
published how they seed into the playoff bracket, so neither does this.
