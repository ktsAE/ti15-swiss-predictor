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
| `update-results.mjs` | pulls finished series off Liquipedia into `index.html` |
| `netlify.toml` | build command, publish directory, headers |

`index.html` is written for Claude's Artifact host, which supplies the doctype
and `<head>` itself — so the source starts at `<title>`. `build.mjs` adds that
skeleton for anywhere else. Edit `index.html`; never edit `public/`.

## Running it

Open `index.html` in a browser. That is the whole development loop.

## Filling in results as the tournament runs

Series that have actually been played live in the `RESULTS` table near the top
of the script in `index.html`, winner first, in the round they belong to:

```js
r1: [["flcn", "lgd"], ["1w", "ngx"]]     // Falcons beat LGD, Iron Wing beat Nigma
```

A locked series renders as final, cannot be clicked, and survives "Clear
picks", so a visitor arriving mid-event only picks what is still open.
Everything downstream keeps deriving from it.

Fill rounds in order — a round's pairings are not settled until everything
before it is. Anything that is not a pairing the rules produce gets flagged in
a banner on the page rather than silently ignored.

You can fill the table by hand, or let Liquipedia do it:

```
node update-results.mjs --dry     # show what would change
node update-results.mjs           # write it into index.html
```

One API request per run, well inside Liquipedia's rate limit. It records a
series only once it is actually decided, and skips (loudly) any team name not
in its lookup table.

## Deploying

Netlify builds with `node build.mjs` and serves `public/`. To close the loop
during the event, have a cron update and push:

```
*/10 * * * * cd ~/swissPret && node update-results.mjs && \
             git commit -am "results" && git push
```

It only commits when something changed, so a push means a real result landed.

## Credit

Format, rules and the round-1 draw come from
[Liquipedia](https://liquipedia.net/dota2/The_International/2026), CC-BY-SA.
An unofficial fan tool, not affiliated with Valve.

The tool stops at the eight teams who reach the main event. Valve has not
published how they seed into the playoff bracket, so neither does this.
