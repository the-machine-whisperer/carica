/**
 * Types for the browser-safe subset of @carica/core (scoring + event projection).
 * The Node-only surface is declared in index.d.ts, which re-exports this file.
 */

export type StageStatus = 'pending' | 'running' | 'ok' | 'failed' | 'skipped';
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

export interface StageState {
  id: string;
  status: StageStatus;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  attempts: number;
  retries: { attempt: number; reason: string; errors: string[]; label?: string }[];
  errors: string[];
  artifact: string | null;
  evidenceRecords: number | null;
  evidenceRefs: number | null;
  shards: number | null;
  shardsCompleted: number;
  progress: { ts: string; message: string }[];
  replay: boolean;
  degraded: boolean;
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
  humanRequired: { stage: string; message: string } | null;
  stages: Record<string, StageState>;
  order: string[];
  lastSeq: number;
  eventCount: number;
}

export declare const DIMENSIONS: DimensionMeta[];
export declare const DIMENSION_KEYS: string[];
export declare const STAGE_ORDER: string[];

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
