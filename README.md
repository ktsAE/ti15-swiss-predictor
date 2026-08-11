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

Netlify builds with `node build.mjs` and serves `public/`.

The loop is closed by `.github/workflows/update-results.yml`, which runs the
updater every ten minutes on GitHub's runners and commits `index.html` when a
series has finished. That push is what makes Netlify rebuild, so a result
reaches the site about a minute after it reaches Liquipedia — with no machine
of your own needing to be awake at 05:00 for a Shanghai start time.

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
