# carica — political caricature synthesis pipeline

Finds what's happening in Israeli politics, judges which stories will actually make a good
cartoon, argues why, and hands the graphics team a production brief plus a first visual draft.

Built for a **semi-weekly** newspaper column. Runs on a MacBook via the Codex CLI.

**This project holds no API keys.** Every stage is a `codex exec` invocation, and the Codex
CLI carries its own sign-in — made once with `codex login`. The pipeline never makes an HTTP
call with a credential, so there is nothing to paste, store or leak.

**The app is the product.** Everything — starting a run, watching it as a graph, holding or
stopping a single job inside it, carrying it on from where it stopped, the settings, the
ranking weights, the editorial decision — is a button in the browser. The editor using it
never needs a terminal. The CLI still exists, for automation and debugging.

> **Status: pipeline + app built, verified offline, and now looked at in a browser.** The
> live `codex exec` path has still never been run — see
> [What still needs a human](#what-still-needs-a-human). In particular, **holding and
> stopping jobs is proven against a stand-in agent, not against a real `codex exec` child**:
> see [What is proven and what is not](#what-is-proven-and-what-is-not).
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
npm start                  # build if needed, serve on 4417, open a browser
```

First time in the app: **Start a run → Practice run**. There is nothing to configure first —
no key to paste. A practice run replays a saved snapshot through all eleven steps in about a
second, with no network, no models and no bill — the cheapest way to see the whole thing work.
A *live* run needs one thing, done once per machine in a terminal: `codex login`.

**For development:**

```bash
npm run gate               # build + 299 tests + full offline replay + contract audit. No network, no cost.
npm run dev                # hot-reloading UI on 5317, proxying /api to 4417
carica serve &             # API + SSE on 4417, without rebuilding the UI
```

The CLI does everything the app does, for scripting and CI — with one deliberate exception,
stated below:

```bash
carica run --replay fixtures/2026-08-11_sample
carica run --slug tuesday-column
carica run --from score --run <run-id>    # resume; steps whose results still validate are skipped
carica run --from harvest --run <run-id> --retry-killed   # …and redo the jobs you stopped
carica verify --latest                    # also prints where the run could be picked up
carica list                               # status per run, and its resume point
```

**The exception: holding and stopping individual jobs is app-only.** Deciding, twenty seconds
into a fetch, that *this* outlet is not worth waiting for is a judgement made while watching —
there is nothing for a script to decide and nothing for CI to press. What a script does need
is the *consequence*: `--retry-killed` is how a resumed run is told to reconsider a decision
somebody made by hand, and `carica list` will tell you a decision was made at all.

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
  control.ndjson              what the editor told this run: pause, resume, stop, skip
  state.json                  where it would pick up — a cache of the two above
  NN_*.json                   stage artifacts, written atomically
  NN_*.part-<key>.json        one shard's share of a fanned-out step, before the merge
  NN_*.evidence.jsonl         the sourcing behind every number
  NN_*.transcript.jsonl       raw agent output, diagnostic only
  10_drafts/                  rendered images
  out/BRIEF-*.md              the graphics team's deliverable
```

No database. The React app is a **pure projection** of this directory — reload reprojects, and
a finished run replays identically.

`events.ndjson` is what the run says about itself; `control.ndjson` is what the editor said to
it, and it is a separate file for one reason: the event log is evidence and has to stay a
faithful record of what *happened*, while an instruction is an intention that may never be
honoured — the job it names may have finished a second before it was written. It appears the
first time you steer a run, and a run nobody touched simply does not have one.

`state.json` is a **cache and nothing else**. Every fact in it can be recomputed from the
events, and when the two disagree the events win, without exception. It exists because the
runs list draws thirty runs and the resume picker needs one run's shape: answering either from
the events means folding a log tens of thousands of lines long to produce two dozen words.
Delete every `state.json` under `runs/` and the system loses some speed and no information at
all — which is the property that keeps it honest.

---

## The app

Three screens. **Runs** is the archive plus one primary button; **a run** is the map, a
purpose-built panel per step, and the activity log; **Setup** is readiness, the two model
settings, the ranking weights and the editorial policy — no credentials, because there are none.

### Watching a run: the map

A run opens on a **map** of the eleven steps — cards on a grid, laid out left to right by how
far each step is from the start, with lines drawn between the ones that feed each other. It is
the same graph `carica stages` prints, except it is alive.

Inside each card is one tile per **job**. A job is one unit of agent work: a plain step is a
single job, and a step that fans out is one job per shard — so a harvest of eighteen outlets
shows eighteen tiles, each going from queued to running to finished on its own. This is the
thing the old rail could not show. A stage bar that says "harvest, 62%" is a number; eighteen
tiles with two of them stuck is a diagnosis.

The old rail is still there as **List**, a click away. Neither view is a summary of the other.

### Holding and stopping work

Click a job and you can **hold it, let it go, or stop it** — and the same three at the level of
a whole step or the whole run. Holding suspends the agent process where it stands and it
resumes exactly where it was; stopping ends it.

Two things about this are worth stating plainly, because they are what make it trustworthy
rather than merely possible:

**Stopping something is recorded, not erased.** A harvest you stopped four outlets into does
not fail and does not quietly come back with fourteen outlets as if fourteen were all there
were. It merges the fourteen it has, reports itself **degraded**, and the run folder can say
which four are missing and that a person stopped them at 09:41. An unexplained gap is the one
thing a pipeline like this cannot afford.

**Stopping is not failing.** A run you stopped ends `cancelled`, never `failed` — in the app,
in `run.json`, and in the CLI's exit code, which stays 0. Reporting a decision you made back
to you as a breakage is both wrong and useless.

An instruction you give is written to `control.ndjson` *before* it is sent to the run, so it
survives the app closing, the run dying, and the gap between clicking and the agent noticing.
That gap is real and the app does not pretend otherwise: a tile says "stopping…" until the run
itself says the job stopped, and if the run declines to stop, the tile keeps saying "running",
because that is what is true.

### Carrying a run on

**Continue** opens a list of the run's own milestones — every step that produced a usable
result, plus the next one that has not — with what carrying on from each would cost. Pick one
and the run picks up there, keeping its run id, so the record stays one continuous story.

Resumption now goes down to the **shard**. A harvest that reached fourteen of eighteen outlets
before it stopped re-uses the fourteen part files that still pass their contract and re-fetches
only four. On a live run that is the difference between four fetches and eighteen.

Jobs you stopped on purpose stay stopped when you continue — the artifact is missing, so every
other signal on disk says "redo this", and only `control.ndjson` knows a person decided
otherwise. **Try the jobs I stopped again** is a checkbox on that screen, and `--retry-killed`
on the command line. It is never the default: silently re-running a shard someone killed would
spend money undoing an editorial decision.

Starting a *new* run partway through, on an earlier run's results, is a different thing and
still lives where it did — **Start a run → Start at**. That copies results into a new folder;
Continue keeps the one you have.

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

`carica serve` → Fastify on 4417, serving the built UI plus:

| Endpoint | |
|---|---|
| `GET /api/runs`, `/api/runs/:id` | run list; manifest + server-side projected state |
| `POST /api/runs` | **start a run** — replay or live, resume, slug, model, concurrency |
| `POST /api/runs/:id/stop` | stop it: SIGTERM, then a hard kill |
| `POST /api/runs/:id/control` | **hold, release, stop or skip** — a job, a step, or the run |
| `POST /api/runs/:id/resume` | **carry this run on** from a step, optionally retrying stopped jobs |
| `GET /api/runs/:id/checkpoint` | where it would pick up — `state.json`, or `null` for an older run |
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
POSTs; only progress streams. The reply to a control POST is a *receipt*, never a report that
the work has stopped — what actually happened comes back over the stream like everything else.

**Only the run writes to `events.ndjson`.** The server appends nothing while a run is alive,
which is not fastidiousness: the run's own writer owns the monotonic `seq`, and `seq` is what
every browser resumes from. A second writer would hand out a duplicate and silently cost a
reconnecting client every event in between.

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

`npm test` — **299 assertions**. The ones that matter are the negative ones.

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

**Scoring + projection (50)** — the UI arithmetic must reproduce each candidate's own
`weighted_total` exactly, and re-weighting must be *capable of changing the winner* (a slider
that only moves numbers is decorative). Projection is tested against a real event log and
against the awkward cases: a finished shard must not finish its parent stage, a shard's part
file must not overwrite the parent's artifact name, garbage events must not throw. The job
model adds the ones that matter for the map: a job stopped by hand reads `killed` and never
`failed`, a stage all of whose jobs were stopped is `skipped` rather than a failure, and an
event log recorded *before* any of this existed must still project cleanly — which is asserted
rather than assumed, because every run already on disk is one.

**Control + checkpoint (28)** — the same instruction delivered three ways (over IPC, off the
file, and replayed on the next run) must apply exactly once, keyed on `request_id`; a
checkpoint derived twice from one log must be byte-identical, because a derivation that reads
a clock cannot be used to tell whether anything changed; and a torn, absent or hand-edited
`state.json` must degrade to "recompute from the events", never to a crash.

**Agent execution (35)** — a real child process, because "was this agent actually spawned?"
is not a question a mock can answer honestly. A stand-in agent binary is held with SIGSTOP and
proven not to progress, released and proven to finish, and killed and proven to leave a
recorded gap; a job stopped while still *queued* is proven never to start at all, which is the
case a pid-based registry gets wrong.

**Pipeline (61)** — the fan-out: shard identity end to end, a killed shard merging as partial
coverage rather than failing the stage, a resumed run reusing the part files that still
validate and re-fetching only the rest, the charter and allowlist paths, and the seed flow.

**Server + SSE (87)** — path traversal refused on four vectors, decisions rejected without
attribution, and the SSE tailer proven to deliver an event appended *after* the client
connected, plus `Last-Event-ID` proven to resume rather than replay. A job id off the wire is
checked for shape *and* for belonging, so a request cannot steer a stage it did not name;
`retryKilled` is proven to default false and to reach the run when asked for. Also: a practice
run started over HTTP, driven to completion and audited;
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

### What is proven and what is not

This project's whole disposition is that unverified things are labelled as such, so:

**Proven, offline, on this machine.** All 299 assertions, an eleven-stage replay end to end,
and the contract audit over what it produced. Holding and stopping jobs is proven with real
child processes — SIGSTOP genuinely suspends the child and it genuinely does not progress,
SIGCONT resumes it, SIGTERM ends it, and a job stopped before it was dispatched never starts.
Shard-level resume is proven: a run driven to a partial harvest and continued re-uses the part
files that still validate and re-fetches only the rest.

**Not proven: any of this against a real `codex exec` child.** There is no `codex` binary on
the machine this was built on and there never has been, so every one of those signals was
delivered to a **stand-in agent** — a small Node script that slices a frozen snapshot instead
of fetching anything. That stand-in is a faithful test of the registry, the control plane and
the merge, and it is *not* evidence about `codex exec` itself. A real Codex invocation may
spawn children of its own, in which case a SIGSTOP or SIGTERM aimed at the process the
pipeline spawned may leave a grandchild running, still working and still billing. **Nobody has
watched a real agent be paused.** Treat the first live run as the experiment it is.

Still owed:

- **Nobody has clicked through the UI in a real browser.** Every screen has now been rendered
  and read by eye (headless Firefox, screenshots reviewed: runs, a run, each panel, setup, the
  start dialog), and one dialog was opened by a driven click. Full interaction — changing a
  setting, saving weights, recording a decision, watching a live run, **stopping a job from the
  map** — is still unexercised by hand.
- **Scorer rank agreement** — 12 stories the column editor ranks by hand, measured against S5
  by Spearman ρ (target ≥ 0.7). Nothing yet proves the rubric ranks the way an editor does.
- **Editorial red-team** — 8 deliberately trope-laden concepts S9 must BLOCK.

---

## What still needs a human

1. **Click through the app on the target machine.** `npm start`, then run a practice run and
   use every control: the weights, a decision, stop, continue, and stopping a single job from
   the map. It has been read by eye but not operated by hand.
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
4. **Prove the pause against one real agent before you rely on it.** On the first live harvest,
   hold a single outlet's job from the map and watch it: `ps` should show that pid stopped, and
   nothing more should arrive from it. Then release it and check it finishes. This is the one
   claim in the whole control plane that the offline tests cannot make — see
   [What is proven and what is not](#what-is-proven-and-what-is-not). If a held job keeps
   producing output, `codex exec` has spawned a child of its own and the registry needs to
   signal the process *group*, not the process.
5. Start a live run on a real news day and **read the News sources step before letting it get
   far** — stop step 1 if it looks wrong, fix `outlets.he.yaml`, and Continue. Stopping
   costs nothing you have already paid for: finished steps are reused, not repeated, and a
   fanned-out step reuses the shards that already succeeded.
6. Then let it reach Rank candidates and read the scoring rationale cold. That is the first
   real signal on whether the rubric is any good.
