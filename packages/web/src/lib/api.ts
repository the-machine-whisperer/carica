import type { Checkpoint, ControlAction, RunState } from '@carica/core/browser';

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = body?.errors?.length ? `${body.error}: ${body.errors.join('; ')}` : body?.error;
    const err = new Error(detail ?? `${res.status} ${res.statusText}`);
    (err as any).status = res.status;
    (err as any).body = body;
    throw err;
  }
  return body as T;
}

const post = <T>(url: string, body?: unknown) =>
  j<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

export interface RunSummary {
  run_id: string;
  status: string;
  interrupted?: boolean;
  active?: boolean;
  created_at: string | null;
  finished_at: string | null;
  slug: string | null;
  mode: string | null;
  stage_summary?: { stage: string; ok: boolean; skipped?: boolean }[] | null;
}

export interface RunDetail {
  run_id: string;
  manifest: any;
  state: RunState;
  artifacts: string[];
  active: boolean;
  interrupted: boolean;
  policy: PolicyStatus;
}

export interface StageInfo {
  id: string;
  n: number;
  title: string;
  blurb: string;
  artifact: string;
  network: boolean;
  fanout: boolean;
  freshContext: boolean;
  humanCheckpoint: boolean;
  requiresEvidence: boolean;
  dependsOn: string[];
}

export interface SystemCheck {
  id: string;
  label: string;
  state: 'ok' | 'warn' | 'blocked';
  detail: string;
  fix: string | null;
  /** What this check stands in the way of. `null` means it is informational only. */
  blocks: 'live' | 'practice' | 'publication' | null;
}

export interface PolicyStatus {
  present: boolean;
  draft: boolean;
  sha: string | null;
  bytes?: number;
}

export interface SystemStatus {
  checks: SystemCheck[];
  ready_for_live: boolean;
  ready_for_practice: boolean;
  /**
   * The whole of this project's authentication story. There is no API key: every stage is
   * an inline `codex exec`, and the Codex CLI carries its own sign-in.
   *
   * `logged_in` is tri-state on the wire — true, false, or **absent** when the server
   * could not tell. Never collapse absent to false: that would say "signed out" on a
   * machine that is signed in perfectly well.
   */
  codex: {
    present: boolean;
    bin: string;
    logged_in?: boolean;
    auth?: 'signed_in' | 'signed_out' | 'unknown';
    auth_method?: string | null;
    auth_file?: string;
  };
  policy: PolicyStatus;
  fixtures: { name: string; stages: number }[];
  node_version: string;
  web_built: boolean;
  repo_root: string;
  active_run: ActiveRun | null;
}

export interface ActiveRun {
  run_id: string | null;
  mode: string;
  started_at: string;
  requested_by: string | null;
  stopping: boolean;
  from: string | null;
  pid: number | null;
}

/**
 * An ordinary operational setting — a model name, a path. Deliberately no `secret` or
 * `masked` field: this app collects no credentials, so there is nothing here to hide,
 * and a type that cannot express a secret is one that cannot grow one back by accident.
 */
export interface Setting {
  key: string;
  label: string;
  help: string;
  required: boolean;
  present: boolean;
  value: string | null;
  fallback: string | null;
  from_environment: boolean;
}

export interface StartRunBody {
  mode: 'live' | 'replay';
  slug?: string;
  fixture?: string;
  from?: string | null;
  resumeRunId?: string;
  concurrency?: number;
  model?: string;
  /** Registry ids to harvest. Omit or leave empty for every outlet. Narrows, never adds. */
  allowlist?: string[];
  /**
   * Start a NEW run at `from`, copying the steps before it out of this run or snapshot.
   * Mutually exclusive with `resumeRunId`, which continues a run that already has them.
   */
  seedFrom?: string;
  requested_by?: string | null;
}

/** A run or snapshot whose results a new run could start from. */
export interface SeedSource {
  id: string;
  kind: 'run' | 'fixture';
  /** Stage ids with an artifact present, contiguous from step 1. */
  stages: string[];
  through: string | null;
  artifacts: string[];
  slug?: string | null;
  created_at?: string | null;
  status?: string | null;
}

// ---------------------------------------------------------------- steering a run

/**
 * The four things a person can do to work that is already under way.
 *
 * `pause` and `resume` are a pair and are never destructive — the job is held where it is
 * and can be let go again. `kill` stops one piece of work for good; `skip` declines to do
 * it at all. Both of the latter leave a recorded gap rather than a silent absence, which is
 * the whole reason this pipeline is worth trusting: it says what it did not manage to do.
 *
 * Taken from core rather than restated, because the control log the server writes and the
 * button the editor presses have to mean the same four things or the log is fiction.
 */
export type { ControlAction };

/**
 * What the action applies to. Deliberately one shape rather than three endpoints: "pause"
 * means the same thing at every scale, and the server should be the one that decides how a
 * pause of a whole run reaches the eighteen agents inside it.
 *
 * Looser than core's `ControlTarget`, which is a discriminated union, and on purpose: this
 * is the type callers *build* a request with, often from a stage id they are holding in a
 * variable. Every value of core's union satisfies this one, so nothing is lost on the way
 * to the server — which validates it properly anyway.
 */
export interface ControlTarget {
  kind: 'run' | 'stage' | 'job';
  /** Required for `stage` and `job`. */
  stage?: string;
  /** Required for `job` — `"<stageId>:<shardKey>"` for a fanned-out step, the stage id otherwise. */
  job_id?: string;
}

/**
 * The run's own note-to-self, written as it goes.
 *
 * The event log is the truth about what *happened*; the checkpoint is the much smaller
 * answer to "if this were interrupted right now, where would it pick up?". It is a file on
 * disk in the run folder, so a run survives the app being closed — which is not a rare
 * event in a newsroom, it is Tuesday.
 *
 * Re-exported from core, not restated here: the writer of that file and the reader of it
 * have to agree down to the field, and two copies of a shape are two chances to disagree.
 */
export type { Checkpoint, CheckpointJob, CheckpointStage, Milestone } from '@carica/core/browser';

/** One outlet as `config/outlets.he.yaml` defines it. */
export interface RegistryOutlet {
  id: string;
  name_en: string;
  name_he: string;
  lean?: string;
  paywall?: string;
  authority_prior?: number;
}

export const api = {
  runs: () => j<{ runs: RunSummary[]; active: ActiveRun | null }>('/api/runs'),

  run: (runId: string) => j<RunDetail>(`/api/runs/${encodeURIComponent(runId)}`),

  startRun: (body: StartRunBody) => post<{ ok: true; run_id: string; mode: string; resumed: boolean }>('/api/runs', body),

  stopRun: (runId: string) => post<{ ok: true; run_id: string }>(`/api/runs/${encodeURIComponent(runId)}/stop`),

  /**
   * Steer a run, a step or a single job.
   *
   * The reply is only an acknowledgement — `request_id` is the receipt for the request, not
   * a report that the work has stopped. What actually happened arrives over the event
   * stream as `control.applied` and `job.killed`/`job.paused`/…, and the projection is what
   * the screen believes. Never treat this promise resolving as the new state.
   */
  control: (runId: string, action: ControlAction, target: ControlTarget, by?: string | null) =>
    post<{ ok: true; request_id: string }>(`/api/runs/${encodeURIComponent(runId)}/control`, {
      action,
      target,
      ...(by ? { by } : {}),
    }),

  /** The run's resume point, or null for a run that never wrote one (an older run, or one that never started). */
  checkpoint: (runId: string) =>
    j<{ run_id: string; checkpoint: Checkpoint | null }>(`/api/runs/${encodeURIComponent(runId)}/checkpoint`).then(
      (r) => r.checkpoint
    ),

  /**
   * Carry this same run on from `from`, reusing everything before it.
   *
   * Distinct from `startRun({ seedFrom })`, which makes a *new* run that copies the earlier
   * steps in. This one keeps the run id, so the record stays one continuous story.
   *
   * `retryKilled` is the editor's answer to "and the jobs you stopped?". Omitted or false —
   * the default, and the right one — they stay stopped: a killed shard wrote no artifact, so
   * every other signal a resume can read says it still needs doing, and only the control log
   * knows a person decided otherwise. Sending true is the explicit "I stopped that by
   * mistake, try it again", and it has to travel with the request or the choice the editor
   * made on screen is quietly discarded on the way to the server.
   */
  resumeRun: (runId: string, from: string, opts?: { retryKilled?: boolean }) =>
    post<{ ok: true; run_id: string; resumed: boolean }>(`/api/runs/${encodeURIComponent(runId)}/resume`, {
      from,
      ...(opts?.retryKilled ? { retryKilled: true } : {}),
    }),

  active: () => j<{ active: ActiveRun | null }>('/api/active'),

  seedSources: () => j<{ sources: SeedSource[] }>('/api/seed-sources').then((r) => r.sources),

  verify: (runId: string) =>
    j<{ ok: boolean; rows: { stage: string; present: boolean; ok: boolean | null; errors: string[]; evidence: { records: number; refs: number } | null }[] }>(
      `/api/runs/${encodeURIComponent(runId)}/verify`
    ),

  stages: () => j<{ stages: StageInfo[] }>('/api/stages').then((r) => r.stages),

  system: () => j<SystemStatus>('/api/system'),

  settings: () => j<{ env_file_exists: boolean; settings: Setting[] }>('/api/settings'),

  saveSettings: (settings: Record<string, string>) =>
    post<{ ok: true; settings: Setting[] }>('/api/settings', { settings }),

  weights: () => j<{ weights: Record<string, number>; floors: any; funnel: any; edited_at: string | null }>('/api/weights'),

  saveWeights: (weights: Record<string, number>) =>
    j<{ ok: true; weights: Record<string, number>; positive_sum: number; warning: string | null }>('/api/weights', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weights }),
    }),

  artifact: <T = any>(runId: string, name: string) =>
    j<T>(`/api/runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(name)}`),

  config: () => j<{ weights: any; outlets: any; policy_present: boolean }>('/api/config'),

  policyText: async () => {
    const res = await fetch('/api/policy');
    if (!res.ok) throw new Error('The editorial policy could not be read.');
    return res.text();
  },

  ledger: () => j<{ entries: any[] }>('/api/ledger').then((r) => r.entries),

  decisions: (runId: string) =>
    j<{ decisions: any[] }>(`/api/runs/${encodeURIComponent(runId)}/decisions`).then((r) => r.decisions),

  postDecisions: (runId: string, decisions: any[]) =>
    post<{ ok: true; count: number }>(`/api/runs/${encodeURIComponent(runId)}/decisions`, { decisions }),

  draftUrl: (runId: string, assetPath: string) =>
    `/api/runs/${encodeURIComponent(runId)}/drafts/${encodeURIComponent(assetPath.replace(/^10_drafts\//, ''))}`,

  briefUrl: (runId: string, briefPath: string) =>
    `/api/runs/${encodeURIComponent(runId)}/brief/${encodeURIComponent(briefPath.replace(/^out\//, ''))}`,

  eventsUrl: (runId: string, lastSeq = 0) =>
    `/api/runs/${encodeURIComponent(runId)}/events${lastSeq ? `?lastEventId=${lastSeq}` : ''}`,
};
