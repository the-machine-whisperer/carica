# carica — political caricature synthesis pipeline

Finds what's happening in Israeli politics, judges which stories will actually make a good
cartoon, argues why, and hands the graphics team a production brief plus a first visual draft.

Built for a **semi-weekly** newspaper column. Runs on a MacBook via the Codex CLI.

**This project holds no API keys.** Every stage is a `codex exec` invocation, and the Codex
CLI carries its own sign-in — made once with `codex login`. The pipeline never makes an HTTP
call with a credential, so there is nothing to paste, store or leak.

**The app is the product.** Everything — starting a run, watching it, stopping it, carrying
it on from where it stopped, the settings, the ranking weights, the editorial decision — is a
button in the browser. The editor using it never needs a terminal. The CLI still exists, for
automation and debugging.

> **Status: pipeline + app built, verified offline, and now looked at in a browser.** The
> live `codex exec` path has still never been run — see
> [What still needs a human](#what-still-needs-a-human).
>
> **Picking this up cold? Read [`HANDOVER.md`](HANDOVER.md) first** — decisions already made,
> what is actually proven, gotchas, and the ordered next steps.

---

## The shape of it

Eleven stages. Each one is an **autonomous Codex agent** that picks its own approach and
tools, bounded by three things it cannot negotiate:

| Bound | Mechanism |
|---|---|
| **Input** | It reads only what its charter grants it. |
| **Output** | The file it writes must validate against a JSON Schema in `contracts/`. Fails → re-invoked *with the errors*, twice. |
| **Evidence** | Every number it emits must carry an `evidence_id` resolving to a real fetch or command in `<stage>.evidence.jsonl`. **An unsourced number is a stage failure.** |

That last one is the whole trick. Agentic pipelines invent numbers; this one makes invention
structurally detectable instead of taking the work away from the agent.

```
S1  outlets   →  rank Israeli outlets by reach + engagement          [net] [evidence]
S2  harvest   →  fetch political items, one agent per outlet         [net] [evidence] [fan-out]
S3  cluster   →  merge into cross-outlet story clusters
S4  triage    →  political filter, figures, censor + sub judice flags
S5  score     →  nine-dimension caricature fitness rubric
S6  verify    →  adversarial fact check, fresh context               [net] [evidence]
S7  ideate    →  three divergent concepts per candidate              [fan-out]
S8  prompt    →  the prompt package for graphics                     [fan-out]
S9  gate      →  editorial standards adjudication, fresh context
S10 render    →  first drafts + refusal/fallback trail               [net] [fan-out]
S11 publish   →  HUMAN CHECKPOINT, brief export, ledger append
```

The app shows this as eleven named steps; `carica stages` prints the same graph, and
`GET /api/stages` serves it, so the rail and the CLI cannot disagree about the pipeline.

---

## Starting it

**For the person using it:** double-click **`Start carica.command`** (macOS) or run
`./start-carica.sh` (Linux). It installs and builds itself the first time, then opens the app.
Leave that window open; everything else happens in the browser.

**Equivalently, from a terminal:**

```bash
npm start                  # build if needed, serve on 4317, open a browser
```

First time in the app: **Start a run → Practice run**. There is nothing to configure first —
no key to paste. A practice run replays a saved snapshot through all eleven steps in about a
second, with no network, no models and no bill — the cheapest way to see the whole thing work.
A *live* run needs one thing, done once per machine in a terminal: `codex login`.

**For development:**

```bash
npm run gate               # build + 105 tests + full offline replay + contract audit. No network, no cost.
npm run dev                # hot-reloading UI on 5317, proxying /api to 4317
carica serve &             # API + SSE on 4317, without rebuilding the UI
```

The CLI does everything the app does, for scripting and CI:

```bash
carica run --replay fixtures/2026-08-11_sample
carica run --slug tuesday-column
carica run --from score --run <run-id>    # resume; steps whose results still validate are skipped
carica verify --latest
carica list
```

---

## Three decisions worth knowing about

**Candidates are stories, not articles.** Fourteen outlets covering one Knesset vote is one
candidate — and the fact that fourteen covered it is an impact signal that survives into the
cluster. S3 does this merge, which in Hebrew is real work: `נתניהו` / `ביבי` /
`בנימין נתניהו` / `רה"מ` are one person, and string similarity cannot see that. Every merge
is recorded in `name_variants_merged` so the one judgement no arithmetic can check is at
least auditable.

**Legibility is the highest-weighted rubric dimension (0.20).** Ridiculousness and spice pick
topics; legibility decides whether the cartoon *works*. A hilarious story with no visual
handle is a column, not a caricature.

**Hebrew lettering is a post-render typesetting layer.** Image models render RTL Hebrew as
reversed, malformed, or plausible-looking nonsense a non-reader won't catch. So every prompt
package tells the renderer to leave label plates and speech balloons **blank**, and ships the
Hebrew strings separately in `lettering_spec` with placement and font. The editorial gate
returns REVISE on any package that asks the model to draw Hebrew text. This single rule is
the difference between a usable draft and a garbled one.

---

## Scoring is arguable, not oracular

S5 emits **sub-scores and weights separately** and shows the arithmetic:

```
0.20*8 + 0.15*8 + 0.15*8 + 0.12*8 + 0.12*7 + 0.10*6 + 0.10*9 + 0.06*7 - 0.20*2 = 7.32
```

So the editor can re-weight in the review app and re-rank instantly without re-running
anything — and can see exactly which dimension carried a candidate. Weights live in
`config/weights.yaml`.

---

## Editorial policy is not boilerplate

`config/editorial-policy.md` carries the actual risk in this project and **must be signed off
by the standards desk and legal counsel before anything publishes.** It encodes:

- Hard-blocked visual tropes — antisemitic imagery above all, which is *especially* live when
  the subject is an Israeli politician, because the drawing travels and gets read outside its
  context. Major papers have destroyed careers here. Intent is not a defence and the gate
  does not consider it.
- The same prohibitions for every other group, without exception.
- Caricature by **signature attributes** (glasses, posture, a known prop), never physiognomy.
  Declared in a structured field at S7 so it is mechanically checkable.
- Israeli defamation exposure (statutory damages without proof of harm), military censor
  scope, sub judice.

S9 cites the specific clause for every verdict, and the policy's SHA is recorded in the run.

---

## The run directory is the whole state

```
runs/<iso>_<slug>/
  run.json                    manifest: config, charter SHAs, models — frozen at t0
  events.ndjson               append-only, monotonic seq — the backbone
  NN_*.json                   stage artifacts, written atomically
  NN_*.evidence.jsonl         the sourcing behind every number
  NN_*.transcript.jsonl       raw agent output, diagnostic only
  10_drafts/                  rendered images
  out/BRIEF-*.md              the graphics team's deliverable
```

No database. The React app is a **pure projection** of this directory — reload reprojects, and
a finished run replays identically.

---

## The app

Three screens. **Runs** is the archive plus one primary button; **a run** is the stage rail,
a purpose-built panel per step, and the activity log; **Setup** is readiness, the two model
settings, the ranking weights and the editorial policy — no credentials, because there are none.

Two rules run through the interface:

**Plain words in the headline, precise words in the detail.** The pipeline's own vocabulary —
stage, artifact, shard, contract, evidence record — is exact and stays in the code, the file
names and the run folder. It is not what an editor on deadline should have to learn, so every
term has one plain-English name in `packages/web/src/lib/copy.ts` and one place to change it.
"Ideate" is *Concepts*, "gate" is *Standards check*, a shard is a *parallel job*, and
`06_verified.json` is still printed at the foot of the panel.

**Nothing that costs money is one unlabelled click away.** A live run is offered next to a
free practice run, and it says whose bill it lands on — the Codex CLI's own signed-in account;
if the machine cannot do a live run, the reason and the remedy are on the button, not in a
failure twenty seconds later. The only reasons are "the Codex command is not installed" and
"it is not signed in", each with the one command that fixes it.

`carica serve` → Fastify on 4317, serving the built UI plus:

| Endpoint | |
|---|---|
| `GET /api/runs`, `/api/runs/:id` | run list; manifest + server-side projected state |
| `POST /api/runs` | **start a run** — replay or live, resume, slug, model, concurrency |
| `POST /api/runs/:id/stop` | stop it: SIGTERM, then a hard kill |
| `GET /api/runs/:id/events` | **SSE**, with `Last-Event-ID` replay |
| `GET /api/runs/:id/verify` | the contract audit, on demand |
| `GET /api/runs/:id/artifact/:name` | any stage artifact; `.jsonl` comes back parsed |
| `GET /api/runs/:id/drafts/:file` | rendered images |
| `POST /api/runs/:id/decisions` | the human checkpoint |
| `GET /api/system`, `/api/stages`, `/api/fixtures` | readiness preflight, stage graph, snapshots |
| `GET/POST /api/settings` | the two model settings, returned in full — there is no secret here to withhold |
| `GET/PUT /api/weights` | the rubric, edited through the YAML document so the comments survive |

**It binds `127.0.0.1` and has no login.** The app can start runs that spend money on the
machine's Codex account, so it assumes exactly one trusted operator at the machine. Do not
widen the bind with `--host` without putting something that authenticates in front of it.

**One run at a time, deliberately.** A run fans out to a dozen concurrent agents and spends
real money; two overlapping runs would race on the ledger and make "what is happening right
now" unanswerable, which is the app's whole job.

**The run executes in a child process.** A stage that hangs or crashes must not take down the
app that is showing you why, "stop" has to be a real kill rather than a cooperative promise,
and the parent learns about progress the same way the browser does — by tailing
`events.ndjson`. A run whose process dies is closed out as `cancelled` or `failed`, never left
saying "running" for ever.

**SSE, not WebSocket** — the run stream is a one-directional firehose. It reconnects by
itself, and `Last-Event-ID` means a graphics-team member opening the tab mid-run sees the
whole run from t0 rather than from the moment they arrived. Control actions are ordinary
POSTs; only progress streams.

Three things in the UI are load-bearing:

**The Score panel has weight sliders that re-rank live.** S5 emits sub-scores and weights
separately, so re-weighting is arithmetic the browser can do — no re-run, no cost. Arrows show
each candidate's rank change against the run's own weights, which is the difference between a
ranking you can interrogate and one you take on faith. The arithmetic is `@carica/core`'s
`rerank()` — *the same function the pipeline uses*, so the sliders cannot drift from the artifact.

**Direction follows the data, not the user.** Hebrew renders RTL with its own font stack,
English glosses LTR, mixed strings bidi-isolated. A Hebrew sentence laid out left-to-right is
genuinely hard to read and puts the punctuation in the wrong place.

**The pipeline cannot approve itself.** The approval panel writes `decisions.pending.json`;
S11 only ever *reads* it, and the server rejects any decision without an editor's name. The
**Export the briefs** button re-runs S11 — which is reading a file only a named human can
have written.

Node-only code never reaches the bundle: the app imports `@carica/core/browser`, an explicit
subpath carrying only the scoring and projection logic.

---

## Verification

`npm test` — **105 assertions**. The ones that matter are the negative ones.

**Contracts (38)** — 20 are rejection tests. A validator that accepts everything is not a
validator, so the suite mutates fixtures into things an agent might plausibly emit and asserts
they fail: a claim marked `verified` on one source, a REVISE with no actionable asks, a rubric
dimension silently dropped, `legal_risk` given a positive weight, a cast member with no
declared handles, a placeholder timestamp, a cited `evidence_id` with no record. Three of them
guard the no-keys design specifically: `data_basis: similarweb_api` and a signal of kind
`similarweb_rank` must now *fail*, so a paid-API reach number cannot re-enter through the
vocabulary, and a render *outcome* used as an attempt `status` is refused. A further pair
asserts the honest no-renderer path is first-class — `no_renderer_available` validates and
stays distinct from `all_variants_refused`, because "our tooling was offline" and "a model
declined to draw this minister" are different findings and only one of them is about the concept.

**Scoring + projection (22)** — the UI arithmetic must reproduce each candidate's own
`weighted_total` exactly, and re-weighting must be *capable of changing the winner* (a slider
that only moves numbers is decorative). Projection is tested against a real event log and
against the awkward cases: a finished shard must not finish its parent stage, a shard's part
file must not overwrite the parent's artifact name, garbage events must not throw.

**Server + SSE (18)** — path traversal refused on four vectors, decisions rejected without
attribution, and the SSE tailer proven to deliver an event appended *after* the client
connected, plus `Last-Event-ID` proven to resume rather than replay.

**Control plane (23)** — a practice run started over HTTP, driven to completion and audited;
a second concurrent run refused; a resume with no step, an unknown step and a run id trying to
escape `runs/` all refused; a `.env` write proven to keep its comments and its unmanaged keys;
a positive `legal_risk` weight refused *and the file proven untouched*; a weight save proven to
keep the comments that explain the weights. Three of these exist to stop the key-based design
creeping back: readiness is asserted to ask whether Codex is *signed in* and never for an API
key, no managed setting may be marked secret or come back key-shaped, and `ready_for_live` is
asserted to reproduce the pipeline's own `codexReadiness().ready` — so the readiness screen
cannot drift from the pipeline it describes and offer a run the pipeline is about to refuse.

**Stopping (4)** — a stand-in worker that ignores SIGTERM proves the hard kill lands, that
the run is closed out as `cancelled` in both the manifest and the event log, and that a run
which dies on its own is recorded as `failed` rather than left saying "running".

Still owed:

- **Nobody has clicked through the UI in a real browser.** Every screen has now been rendered
  and read by eye (headless Firefox, screenshots reviewed: runs, a run, each panel, setup, the
  start dialog), and one dialog was opened by a driven click. Full interaction — changing a
  setting, saving weights, recording a decision, watching a live run — is still unexercised by hand.
- **Scorer rank agreement** — 12 stories the column editor ranks by hand, measured against S5
  by Spearman ρ (target ≥ 0.7). Nothing yet proves the rubric ranks the way an editor does.
- **Editorial red-team** — 8 deliberately trope-laden concepts S9 must BLOCK.

---

## What still needs a human

1. **Click through the app on the target machine.** `npm start`, then run a practice run and
   use every control: the weights, a decision, stop, continue. It has been read by eye but not
   operated by hand.
2. **`config/editorial-policy.md` needs the standards desk and legal counsel.** It is marked
   DRAFT and nothing may publish before that sign-off. It carries the real risk in this project.
   The app says so on every screen that matters, but it cannot enforce the sign-off itself.
3. **The scorer eval set** — only the column editor can produce it.

## First live run on the Mac

1. `codex exec --help` and check the flags in `packages/codex/src/exec.js` →
   `buildCodexArgs()`. They are centralised in that one function precisely so this is a
   one-line correction. Nothing downstream depends on the CLI's stdout shape — agents write
   files, and files are what get validated. Pay particular attention to `--sandbox`: net
   stages run `danger-full-access`, because under `workspace-write` the network is simply off
   and a fetching stage does not fail, it quietly gathers nothing.
2. `codex login`, once, in a terminal. That is the whole of the credential story — there is no
   key to paste, and **Setup** will show a green sign-in the moment it is done.
3. Feed URLs in `config/outlets.he.yaml` are **seeds, not facts**. Israeli outlets move them
   without notice. S1 fetches each one and marks `verified` only on a real parse; expect some
   to be dead on the first run and to need updating.
4. Start a live run on a real news day and **read the News sources step before letting it get
   far** — press Stop if step 1 looks wrong, fix `outlets.he.yaml`, and Continue. Stopping
   costs nothing you have already paid for: finished steps are reused, not repeated.
5. Then let it reach Rank candidates and read the scoring rationale cold. That is the first
   real signal on whether the rubric is any good.
