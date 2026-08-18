/**
 * The words the app says out loud.
 *
 * The pipeline's own vocabulary — stage, artifact, shard, contract, evidence record —
 * is precise and worth keeping in the code, the file names and the run directory. It is
 * not what an editor on deadline should have to learn in order to approve a cartoon. So
 * every technical term gets one plain-English name here, and exactly one place to change it.
 *
 * Rule of thumb: the headline is plain, the detail is precise. We never hide the real
 * mechanism — `06_verified.json` is still on screen — we just stop leading with it.
 */

import type { JobTotals } from '@carica/core/browser';

export interface StageCopy {
  n: number;
  /** What the step is called in the rail and in headings. */
  title: string;
  /** One line, in the second person where it helps. */
  blurb: string;
  /** What the step is doing while it runs, in the present participle. */
  doing: string;
  /** The engineering name, kept visible in small type so the two vocabularies stay linked. */
  technical: string;
}

export const STAGE_META: Record<string, StageCopy> = {
  outlets: {
    n: 1,
    title: 'News sources',
    blurb: 'Ranks Israeli outlets by how many people they actually reach.',
    doing: 'Ranking news sources',
    technical: 'outlets — reach and engagement ranking',
  },
  harvest: {
    n: 2,
    title: 'Collect coverage',
    blurb: 'Reads today’s political coverage from every ranked outlet at once.',
    doing: 'Reading the news',
    technical: 'harvest — one agent per outlet',
  },
  cluster: {
    n: 3,
    title: 'Group into stories',
    blurb: 'Fourteen outlets covering one vote is one story, not fourteen.',
    doing: 'Grouping coverage into stories',
    technical: 'cluster — cross-outlet story merge',
  },
  triage: {
    n: 4,
    title: 'Filter and flag',
    blurb: 'Keeps the political stories, names the figures, flags anything legally sensitive.',
    doing: 'Filtering and flagging',
    technical: 'triage — political filter, censor and sub judice flags',
  },
  score: {
    n: 5,
    title: 'Rank candidates',
    blurb: 'Scores each story on nine things that make a cartoon work. You can re-weight this.',
    doing: 'Scoring candidates',
    technical: 'score — nine-dimension caricature fitness rubric',
  },
  verify: {
    n: 6,
    title: 'Fact-check',
    blurb: 'A second agent, with no memory of the first, tries to knock the facts down.',
    doing: 'Fact-checking the shortlist',
    technical: 'verify — adversarial check, fresh context',
  },
  ideate: {
    n: 7,
    title: 'Concepts',
    blurb: 'Three different visual jokes per story, so there is something to choose between.',
    doing: 'Drawing up concepts',
    technical: 'ideate — three divergent concepts per candidate',
  },
  prompt: {
    n: 8,
    title: 'Art briefs',
    blurb: 'Turns each concept into the brief the graphics desk works from.',
    doing: 'Writing the art briefs',
    technical: 'prompt — the package handed to graphics',
  },
  gate: {
    n: 9,
    title: 'Standards check',
    blurb: 'Independent adjudication against the editorial policy. It can block a concept outright.',
    doing: 'Checking against editorial standards',
    technical: 'gate — editorial policy adjudication',
  },
  render: {
    n: 10,
    title: 'Draft images',
    blurb: 'A first visual draft of everything that passed, plus a record of anything refused.',
    doing: 'Drawing first drafts',
    technical: 'render — draft images and refusal trail',
  },
  publish: {
    n: 11,
    title: 'Your approval',
    blurb: 'Nothing leaves this app until you sign each candidate off by name.',
    doing: 'Waiting for you',
    technical: 'publish — human checkpoint, brief export, ledger append',
  },
};

export const STAGE_IDS = Object.keys(STAGE_META);

/** Status words the editor sees, in place of the projection's internal vocabulary. */
export const RUN_STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' | 'accent'; hint: string }> = {
  idle: { label: 'Not started', tone: 'neutral', hint: 'This run has not begun.' },
  running: { label: 'Running', tone: 'accent', hint: 'Working through the steps now.' },
  awaiting_human: { label: 'Needs your approval', tone: 'warn', hint: 'Paused at the approval step. It will not go further without you.' },
  complete: { label: 'Finished', tone: 'ok', hint: 'All steps finished.' },
  failed: { label: 'Stopped on a problem', tone: 'bad', hint: 'A step could not produce a usable result.' },
  cancelled: { label: 'Stopped by you', tone: 'neutral', hint: 'You stopped this run. Everything it had already finished is kept.' },
  interrupted: { label: 'Interrupted', tone: 'warn', hint: 'The app closed while this run was going. You can continue it from where it stopped.' },
  paused: { label: 'Paused', tone: 'warn', hint: 'Held where it is. The agents are still here — press Resume and they carry on from the same place.' },
  unknown: { label: 'Unknown', tone: 'neutral', hint: '' },
};

export const STAGE_STATUS: Record<string, string> = {
  pending: 'Not started',
  running: 'Working',
  paused: 'Paused',
  ok: 'Done',
  failed: 'Problem',
  skipped: 'Reused',
};

// ------------------------------------------------------------------ jobs

/**
 * A step that reads fourteen outlets is fourteen pieces of work happening at once. The
 * pipeline calls each one a shard; the editor sees a **job**, because that is what it is —
 * one agent, doing one thing, which can be watched, held or stopped on its own.
 *
 * Nothing here ever says "shard", and nothing ever prints a job id. A job is named by the
 * step it belongs to and the source it is reading.
 */
export const JOB_STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' | 'accent'; hint: string }> = {
  pending: { label: 'Waiting', tone: 'neutral', hint: 'Queued. It has not started yet.' },
  running: { label: 'Working', tone: 'accent', hint: 'An agent is on this now.' },
  paused: { label: 'Paused', tone: 'warn', hint: 'Held where it is. It has not been thrown away — it carries on when you resume.' },
  ok: { label: 'Done', tone: 'ok', hint: 'Finished, and its result passed its checks.' },
  failed: { label: 'Problem', tone: 'bad', hint: 'It could not finish. The step records the gap rather than hiding it.' },
  killed: { label: 'Stopped', tone: 'neutral', hint: 'You stopped this one. The step carried on without it.' },
  skipped: { label: 'Skipped', tone: 'neutral', hint: 'Left out. Either its result was already on disk, or you chose to pass over it.' },
};

/** Job counts as one readable line: "12 jobs running, 4 done, 1 stopped". */
export function jobTally(totals: JobTotals | null | undefined): string {
  if (!totals) return '';
  const order: [keyof JobTotals, (n: number) => string][] = [
    ['running', (n) => `${n} running`],
    ['paused', (n) => `${n} paused`],
    ['ok', (n) => `${n} done`],
    ['failed', (n) => (n === 1 ? '1 could not finish' : `${n} could not finish`)],
    ['killed', (n) => `${n} stopped`],
    ['skipped', (n) => `${n} skipped`],
    ['pending', (n) => `${n} still to start`],
  ];
  const parts: string[] = [];
  for (const [key, say] of order) {
    const n = totals[key] ?? 0;
    if (n > 0) parts.push(say(n));
  }
  if (!parts.length) return '';
  // The noun rides on the first phrase only, so the line reads as a sentence rather than a table.
  parts[0] = parts[0].replace(/^(\d+) /, (_m, n) => `${n} ${Number(n) === 1 ? 'job' : 'jobs'} `);
  return parts.join(', ');
}

// ------------------------------------------------------------------ steering a run

/**
 * Four things you can do to work in progress, and the one distinction that matters most
 * in this app: **Pause is not Stop.**
 *
 * Pause holds the agents where they are and lets them carry on. Stop ends the run. Getting
 * that wrong costs twenty minutes and real money, so both are spelled out wherever either
 * one is offered — never as a tooltip, and never as an icon on its own.
 */
export const CONTROL_COPY = {
  pause: {
    label: 'Pause',
    hint: 'Holds this run where it is. The agents stay alive and keep their place, nothing new is started while it waits, and Resume carries on from the same point.',
    ack: 'Pausing. The agents hold their place until you resume.',
  },
  resume: {
    label: 'Resume',
    hint: 'Carries on from exactly where it was held.',
    ack: 'Carrying on.',
  },
  stop: {
    label: 'Stop run',
    hint: 'Ends the run. The agents are shut down — this is not a pause. Everything already finished stays in the run’s folder, and you can start it again from any step later.',
    ack: 'Stopping after the current step finishes writing.',
  },
  kill: {
    label: 'Stop this one',
    hint: 'Stops this piece of work and leaves it out. The step carries on with whatever else came back, and the gap is written into the result rather than hidden.',
    ack: 'Stopped. The step carries on without it.',
  },
  skip: {
    label: 'Skip',
    hint: 'Passes over this without running it. Nothing is produced for it and the step moves on.',
    ack: 'Skipped.',
  },
  /** Held on the whole screen, not tucked into a badge — a paused run that looks slow is a support call. */
  pausedBanner: {
    title: 'This run is paused.',
    body: 'It is not stuck and it is not working. The agents are holding their place, nothing new is being started, and everything finished so far is safe.',
    action: 'Resume the run',
  },
  pausedStepsNote: (n: number) => `${n === 1 ? 'One step is' : `${n} steps are`} on hold while the rest of the run carries on.`,
  /**
   * Said before the whole run is stopped for good.
   *
   * Stopping one step or one job is confirmed in place, on the tile being stopped, by the
   * map itself — a dialog for a single job would be heavier than the act. This is the one
   * case that takes everything down at once, so it gets asked properly.
   */
  confirmKillRun: {
    title: 'Stop everything in this run?',
    body: 'Every agent still working is shut down. Steps that already finished keep their results, and you can carry the run on from any step afterwards — but the work in progress is lost. To hold the run without losing it, use Pause instead.',
    confirm: 'Stop everything',
  },
  cancel: 'Leave it running',
} as const;

// ------------------------------------------------------------------ carrying a run on

/**
 * Everything a run writes stays in its folder, so a run that stopped half way is not a
 * loss — it is a place to start from. This is the vocabulary for that: **milestones** are
 * the points in the run that have a finished result on disk, and carrying on from one of
 * them re-runs that step and everything after it.
 *
 * The consequence is stated where the choice is made. An editor who has to hover to find
 * out what a button costs will click it once and then never again.
 */
export const RESUME_COPY = {
  title: 'Carry this run on',
  description:
    'Everything this run finished is still in its folder. Pick the step it should pick up from — the run keeps its name and its record, it does not become a second run.',
  /** The difference from the other flow that also mentions steps, said once, plainly. */
  versusNewRun:
    'This carries on the same run. To start a fresh run on this one’s early results instead, use Start a run and set “Start at”.',
  chooseLabel: 'Start again from',
  consequence: (title: string, before: number) =>
    before > 0
      ? `The ${before === 1 ? 'step' : `${before} steps`} before ${title} are reused from the files already in this folder — they are not paid for twice. ${title} and every step after it runs again.`
      : `${title} and every step after it runs again. Nothing is reused, because nothing came before it.`,
  revalidation:
    'Before anything runs, each reused result is checked against the shape it is required to have. Anything that no longer passes is re-run whether you picked it or not.',
  notResumable: 'Not available: an earlier step has no result on disk to reuse, so the run cannot pick up here.',
  neverRan: 'Never ran.',
  finishedAt: (t: string) => `Finished ${t}.`,
  couldNotFinish: 'This is where the run stopped.',
  reused: 'Reused from an earlier run.',
  onDisk: (file: string) => `Its result is on disk (${file}).`,
  noResult: 'Nothing was written for this step.',
  action: (title: string) => `Carry on from ${title}`,
  running: 'This run is still going. Stop it before carrying it on from an earlier step.',
  /** Jobs the editor stopped on purpose. The default respects that decision. */
  killedTitle: 'Jobs you stopped',
  killedBody:
    'You stopped these on purpose, so a run carried on from here leaves them out again. Tick the box if you have changed your mind and want them tried once more.',
  killedRetryLabel: 'Try these again this time',
  ack: 'Carrying the run on.',
  empty: 'This run has nothing on disk to carry on from. Start it again from the beginning instead.',
  /** On the home screen, on a run that stopped part way. */
  homeAction: 'Continue from…',
} as const;

/** The two ways of looking at a run in progress. */
export const VIEW_COPY = {
  graph: { label: 'Map', hint: 'Every step and every job at once, and what each one is doing.' },
  list: { label: 'List', hint: 'The eleven steps in order, one line each.' },
} as const;

/**
 * Terms that earn a definition in place. Anything an editor might reasonably stop at,
 * defined without a link away from what they were doing.
 */
export const GLOSSARY: Record<string, string> = {
  run: 'One pass through all eleven steps, from reading the news to a signed-off brief. Everything a run produces is kept in its own folder.',
  practice:
    'A free rehearsal on a saved snapshot of a previous day’s data. It uses no internet, calls no models and costs nothing — the same machinery, none of the bill.',
  live:
    'A real run against today’s news. It drives the Codex CLI, which is signed in to its own account — so a live run spends whatever that account is billed for.',
  codex:
    'The command-line tool every step of this pipeline runs through. It carries its own sign-in, made once with `codex login`. carica never asks for, stores or shows an API key — there isn’t one.',
  evidence:
    'Every number the agents report has to point at a page they actually fetched or a command they actually ran. A figure with no source fails the step rather than reaching print.',
  contract:
    'Each step must produce a result in an exact shape, checked mechanically the moment the agent finishes. A step that fails is retried with the errors, twice, then stops.',
  parallel: 'Independent pieces of work running at the same time rather than one after another.',
  rubric: 'The nine scored dimensions, and the weight given to each, that decide the ranking.',
  weights: 'How much each scored dimension counts. Legibility counts most; legal risk subtracts.',
  gate: 'The standards check. It reads the editorial policy and can block a concept outright, citing the clause.',
  lettering:
    'Image models write Hebrew backwards or as convincing nonsense. So drafts are drawn with blank speech balloons and the Hebrew is set afterwards, as type.',
  ledger: 'The record of what the column has already published, so the ranking can penalise repeating itself.',
};

// ---------------------------------------------------------------- readiness

/**
 * There is no API key in this project, anywhere.
 *
 * Every step runs as an inline `codex exec`, and the Codex CLI carries its own sign-in.
 * So "is this machine ready for a live run" is a question about a command being installed
 * and logged in, not about a secret having been pasted into a box. The app must never
 * collect, store or display one — these strings are what it says instead.
 */
export const CODEX_COPY = {
  /** The one-liner under the Setup heading. */
  noKeys:
    'There is no API key to enter here. Every step of a run is handed to the Codex command-line tool, which is signed in to its own account, so this app holds no credentials of its own — nothing on this screen is a secret.',
  sectionTitle: 'Signing in',
  sectionDescription: 'A live run needs the Codex command installed on this computer and signed in.',
  /** Shown when the CLI cannot be found at all. */
  notInstalled:
    'The Codex command was not found on this computer. Whoever set this machine up needs to install the Codex CLI; until then, practice runs still work and cost nothing.',
  /** Shown when the CLI is there but has no session. */
  notSignedIn: 'The Codex command is installed but not signed in. Open a terminal and run:',
  /**
   * Shown when the sign-in genuinely cannot be established. Deliberately not phrased as a
   * failure: a live run is still offered, and the Codex CLI itself will say no in seconds
   * if it has to — which is a better answer than this screen guessing wrong.
   */
  signInUnknown:
    'The Codex command is installed, but this app could not tell whether it is signed in. A live run is still worth trying — Codex itself will say so straight away if it is not. If it complains, open a terminal and run:',
  /** Shown when everything is in place. */
  ready: 'The Codex command is installed and signed in. Live runs are billed to that account.',
  /** The remedy, printed verbatim so it can be copied. */
  loginCommand: 'codex login',
  /** Under the remedy, so nobody goes looking for a settings field that does not exist. */
  loginNote:
    'That sign-in lives with the Codex CLI, not with carica. Come back to this screen afterwards and the check above will turn green on its own.',
  /** When a live run is unavailable, on the button rather than twenty seconds into a run. */
  liveBlockedPrefix: 'A live run cannot start on this computer yet',
} as const;

/** Non-secret operational settings, so the section that holds them says so. */
export const SETTINGS_COPY = {
  title: 'Models and paths',
  description:
    'Which models the steps ask Codex for, and where the Codex command lives. Ordinary settings, not credentials — they are written to .env on this computer.',
} as const;

// ---------------------------------------------------------------- S1 outlets

/**
 * How S1 came by its reach numbers. There is no paid traffic API in this project, so
 * every basis here is some degree of honest proxy and the panel has to say so — a
 * proxied rank quoted as a visit count is exactly the mistake this label exists to stop.
 */
export const OUTLET_DATA_BASIS: Record<string, { label: string; tone: 'ok' | 'warn'; text: string }> = {
  public_ranking_pages: {
    label: 'public ranking pages',
    tone: 'warn',
    text: 'Proxied from free, public ranking pages the agent read itself — not measured traffic. Directionally useful for ordering outlets; do not quote these as visit counts.',
  },
  mixed: {
    label: 'mixed sources',
    tone: 'warn',
    text: 'Public ranking pages combined with engagement the agent counted itself — reader comments, cross-citations, social following. Still a proxy, not measured traffic: check the per-signal evidence before quoting any single figure.',
  },
};

/** Plain names for the reach and engagement signals an outlet can carry. */
export const OUTLET_SIGNAL_LABEL: Record<string, string> = {
  public_traffic_rank: 'traffic rank (public listing)',
  estimated_monthly_visits: 'estimated monthly visits',
  semrush_rank: 'search visibility rank',
  ahrefs_traffic: 'estimated search traffic',
  tgi_exposure_pct: 'survey exposure',
  talkback_volume: 'reader comments',
  social_footprint: 'social following',
  rotter_mentions: 'forum mentions',
  cross_citation: 'cited by other outlets',
};

// ---------------------------------------------------------------- S10 render

/**
 * The drawing step is best-effort, and "no image" is a legitimate finish rather than a
 * failure: the prompt package is the deliverable, and the graphics desk can draw from it
 * by hand. What the editor needs from this panel is *which* of three quite different
 * things happened, because the remedy differs in every case.
 */
export const RENDER_OUTCOME: Record<
  string,
  { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral'; note: string; remedy: string }
> = {
  rendered: {
    label: 'drafted',
    tone: 'ok',
    note: 'At least one draft image came back.',
    remedy: 'Read the notes under each draft — a model that scrawled marks into a blank plate still needs clearing before typesetting.',
  },
  all_variants_refused: {
    label: 'declined on policy',
    tone: 'warn',
    note: 'A model was reachable and chose not to draw this. Every refusal is recorded word for word below.',
    remedy: 'Read the refusal verbatim: it is a judgement about the concept, not a fault. Rework the concept or take it to the standards desk.',
  },
  no_renderer_available: {
    label: 'no drawing tool available',
    tone: 'neutral',
    note: 'No drawing tool could be reached from this computer, so nothing was drawn. This is a complete run, not a failed one.',
    remedy: 'The art brief is finished and stands on its own — hand it to the graphics desk to draw by hand. Nothing here needs retrying.',
  },
  error: {
    label: 'something went wrong',
    tone: 'bad',
    note: 'A drawing attempt broke part-way through.',
    remedy: 'Transient. Continue the run from this step to try again.',
  },
};

/** One attempt, and what the editor should conclude from it. */
export const RENDER_ATTEMPT_STATUS: Record<
  string,
  { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral'; hint: string }
> = {
  ok: { label: 'drew it', tone: 'ok', hint: 'The image came back.' },
  refused: {
    label: 'declined',
    tone: 'warn',
    hint: 'The model was reachable and declined on policy grounds. Its exact words are below.',
  },
  error: { label: 'error', tone: 'bad', hint: 'It broke part-way through. Worth retrying.' },
  unavailable: {
    label: 'no tool reachable',
    tone: 'neutral',
    hint: 'Nothing was there to ask — no drawing tool could be reached. Not a refusal, and not worth retrying until one is installed.',
  },
};
