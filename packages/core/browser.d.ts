/**
 * Types for the browser-safe subset of @carica/core (scoring + event projection).
 * The Node-only surface is declared in index.d.ts, which re-exports this file.
 */

export type StageStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'ok'
  | 'failed'
  | 'killed'
  | 'skipped';
/** A job and a stage move through the same states — a plain stage IS one job. */
export type JobStatus = StageStatus;
export type RunStatus = 'idle' | 'running' | 'complete' | 'failed' | 'awaiting_human' | 'cancelled';

export interface DimensionMeta {
  key: string;
  label: string;
  short: string;
  blurb: string;
  negative?: boolean;
}

export interface Dimension {
  score: number;
  justification: string;
  evidence_quote_he?: string;
  evidence_gloss_en?: string;
  source_url?: string;
}

export type Weights = Record<string, number>;

export interface Candidate {
  story_id: string;
  rank: number;
  dimensions: Record<string, Dimension>;
  weighted_total: number;
  arithmetic: string;
  verdict_summary: string;
  originality_conflicts?: { ledger_id: string; similarity_note: string }[];
}

/** One thing the agent did, as seen in the `codex exec --json` stream. */
export interface ActivityEntry {
  ts: string | null;
  kind: 'command' | 'search' | 'file' | 'message' | 'thinking' | 'tool' | 'plan' | string;
  status: 'started' | 'completed' | 'failed' | string;
  text: string;
  /** "harvest:Ynet" when the step fanned out; null otherwise. */
  label: string | null;
  /** Codex's item id, so an announced command and its result are one row, not two. */
  itemId: string | null;
  exitCode: number | null;
  output: string | null;
  files: string[] | null;
  queries: string[] | null;
}

export interface TokenUsage {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
}

export interface RetryRecord {
  attempt: number;
  reason: string;
  errors: string[];
  label?: string;
}

/**
 * One unit of agent work.
 *
 * For a fan-out stage that is one shard; for a plain stage it is the stage itself, which
 * gets exactly one job whose id IS the stage id — so every node on screen can be drawn by
 * the same component instead of special-casing "the stage that happens to be one agent".
 */
export interface JobState {
  /** `"<stageId>"` for a plain stage, `"<stageId>:<shardKey>"` for a shard. */
  id: string;
  stageId: string;
  /** The stable key the control channel names — `ynet`, not `Ynet`. */
  key: string;
  /** What a person should read. Falls back to the key. */
  label: string;
  status: JobStatus;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  attempts: number;
  retries: RetryRecord[];
  errors: string[];
  artifact: string | null;
  evidenceRecords: number | null;
  tokens: TokenUsage | null;
  /** This job's own recent moves. Bounded — see JOB_ACTIVITY_LIMIT. */
  activity: ActivityEntry[];
  activityCounts: Record<string, number>;
  lastActivity: ActivityEntry | null;
  exitCode: number | null;
  /** Why it ended this way, when a person or the pipeline said so in words. */
  reason: string | null;
}

export interface StageState {
  id: string;
  status: StageStatus;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  attempts: number;
  retries: RetryRecord[];
  errors: string[];
  artifact: string | null;
  evidenceRecords: number | null;
  evidenceRefs: number | null;
  shards: number | null;
  shardsCompleted: number;
  progress: { ts: string; message: string }[];
  replay: boolean;
  degraded: boolean;
  /** The app threw inside this step. Not a rejected artifact — there is no artifact. */
  crashed: boolean;
  /** The trimmed stack behind `crashed`, for whoever fixes it. */
  crashStack: string | null;
  /** The recent tail of what the agent did. Bounded — see ACTIVITY_LIMIT. */
  activity: ActivityEntry[];
  activityCounts: Record<string, number>;
  tokens: TokenUsage | null;
  /** The work inside this stage, keyed by job id. A fanned stage has no self-job. */
  jobs: Record<string, JobState>;
  /** Job ids in first-seen order, so a grid of shards does not reshuffle as they finish. */
  jobOrder: string[];
  /** An editor has held this stage. Distinct from status, which still says what the work is doing. */
  paused: boolean;
}

/** A cheap tally the header can read without walking every stage. */
export interface JobTotals {
  running: number;
  ok: number;
  failed: number;
  killed: number;
  skipped: number;
  paused: number;
  pending: number;
}

export interface RunState {
  runId: string | null;
  mode: string | null;
  model: string | null;
  concurrency: number | null;
  status: RunStatus;
  startedAt: string | null;
  endedAt: string | null;
  failedStage: string | null;
  /** What `run.end` said about why the run ended. The only account when no step is named. */
  endReason: string | null;
  humanRequired: { stage: string; message: string } | null;
  /** The single most recent thing any agent did, for a one-line "what is happening now". */
  lastActivity: (ActivityEntry & { stage: string; jobId: string }) | null;
  stages: Record<string, StageState>;
  order: string[];
  lastSeq: number;
  eventCount: number;
  /** The editor has held the whole run. */
  paused: boolean;
  pausedStages: string[];
  killedJobs: string[];
  jobTotals: JobTotals;
}

// ---------------------------------------------------------------- control channel

export type ControlAction = 'pause' | 'resume' | 'kill' | 'skip';

export type ControlTarget =
  | { kind: 'run' }
  | { kind: 'stage'; stage: string }
  | { kind: 'job'; stage: string; job_id: string };

export interface ControlRecord {
  seq: number;
  ts: string;
  /** Stable, so applying the same record twice is a no-op. */
  request_id: string;
  action: ControlAction;
  target: ControlTarget;
  /** Free-text actor, e.g. 'editor'. */
  by: string | null;
}

/** The standing intentions a control log expresses, once folded. */
export interface ControlState {
  paused: boolean;
  pausedStages: string[];
  killedJobs: string[];
  skippedJobs: string[];
  killedStages: string[];
  skippedStages: string[];
  runKilled: boolean;
  /** request_ids in the order they were applied. */
  applied: string[];
}

// ---------------------------------------------------------------- checkpoint

export interface CheckpointJob {
  key: string;
  label: string;
  status: JobStatus;
  artifact: string | null;
  started_at: string | null;
  ended_at: string | null;
  attempts: number;
}

export interface CheckpointStage {
  status: StageStatus;
  artifact: string | null;
  /** The stage ended well and named an artifact. A claim, not a proof — resume re-validates. */
  valid: boolean;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  jobs: Record<string, CheckpointJob>;
}

export interface Milestone {
  stage: string;
  n: number;
  title: string;
  at: string | null;
  /** Every stage before this one has a usable artifact, so starting here would work. */
  resumable: boolean;
}

export interface Checkpoint {
  schema_version: string;
  run_id: string | null;
  updated_at: string | null;
  mode: string | null;
  status: RunStatus;
  from: string | null;
  stages: Record<string, CheckpointStage>;
  milestones: Milestone[];
  control: { paused: boolean; paused_stages: string[]; killed_jobs: string[] };
}

export declare const DIMENSIONS: DimensionMeta[];
export declare const DIMENSION_KEYS: string[];
export declare const STAGE_ORDER: string[];
export declare const ACTIVITY_LIMIT: number;
export declare const JOB_ACTIVITY_LIMIT: number;
export declare const CONTROL_ACTIONS: readonly ControlAction[];
export declare const CONTROL_TARGET_KINDS: readonly ControlTarget['kind'][];
export declare const CHECKPOINT_FILE: string;
export declare const CHECKPOINT_SCHEMA_VERSION: string;

export declare function weightedTotal(dimensions: Record<string, Dimension>, weights: Weights): number;
export declare function arithmeticString(dimensions: Record<string, Dimension>, weights: Weights): string;
export declare function rerank<T extends { story_id: string; dimensions: Record<string, Dimension> }>(
  candidates: T[] | undefined,
  weights: Weights
): (T & { weighted_total: number; rank: number })[];
export declare function floorBreaches(
  dimensions: Record<string, Dimension>,
  floors?: { legibility_min?: number; legal_risk_max?: number; shelf_life_min?: number }
): string[];

export declare function projectRun(events?: any[]): RunState;
export declare function activeStage(state: RunState): string;
/** A stage's jobs in jobOrder. Never re-sort these — the order is the point. */
export declare function jobsOf(state: RunState, stageId: string): JobState[];

export declare function validateControlRecord(rec: unknown): { ok: boolean; errors: string[] };
export declare function controlState(records?: ControlRecord[]): ControlState;

export declare function deriveCheckpoint(
  events?: any[],
  opts?: {
    manifest?: any;
    stageMeta?: Record<string, { n?: number; title?: string }>;
    now?: string;
  }
): Checkpoint;
export declare function resumePoints(checkpoint: Checkpoint | null | undefined): Milestone[];
