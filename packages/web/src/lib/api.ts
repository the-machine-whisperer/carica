import type { RunState } from '@carica/core/browser';

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
  requested_by?: string | null;
}

export const api = {
  runs: () => j<{ runs: RunSummary[]; active: ActiveRun | null }>('/api/runs'),

  run: (runId: string) => j<RunDetail>(`/api/runs/${encodeURIComponent(runId)}`),

  startRun: (body: StartRunBody) => post<{ ok: true; run_id: string; mode: string; resumed: boolean }>('/api/runs', body),

  stopRun: (runId: string) => post<{ ok: true; run_id: string }>(`/api/runs/${encodeURIComponent(runId)}/stop`),

  active: () => j<{ active: ActiveRun | null }>('/api/active'),

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
