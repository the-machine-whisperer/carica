/**
 * Public type surface of @carica/core.
 * The implementation is plain ESM JavaScript with JSDoc — this file is the contract.
 *
 * Browser consumers should import `@carica/core/browser`, which excludes everything that
 * touches node:fs. Those types live in browser.d.ts and are re-exported here.
 */

export * from './browser.js';

import type { Checkpoint, ControlAction, ControlRecord, ControlTarget } from './browser.js';

export interface RunManifest {
  run_id: string;
  created_at: string;
  slug: string | null;
  config: Record<string, any>;
  charter_shas: Record<string, string>;
  models: Record<string, string>;
  node_version: string;
  status: string;
  finished_at?: string;
  stage_summary?: any[];
}

export interface EvidenceRecord {
  evidence_id: string;
  kind: 'fetch' | 'command' | 'api' | 'human';
  observed_at: string;
  url?: string;
  command?: string;
  http_status?: number;
  summary: string;
  excerpt?: string;
}

export declare const REPO_ROOT: string;
export declare const CONTRACTS_DIR: string;
export declare const PROMPTS_DIR: string;
export declare const CONFIG_DIR: string;
export declare const FIXTURES_DIR: string;
export declare const RUNS_DIR: string;
export declare const HISTORY_DIR: string;
export declare const LEDGER_PATH: string;

export declare function stableId(prefix: string, seed: string, len?: number): string;
export declare function sha256(text: string): string;
export declare function shortSha(text: string): string;
export declare function makeRunId(now: Date, slug: string): string;

export declare class EventBus {
  constructor(runDir: string);
  seq: number;
  emit(type: string, payload?: Record<string, any>): any;
  onEvent(fn: (e: any) => void): void;
  close(): void;
}
export declare function appendEventToRun(runDir: string, type: string, payload?: Record<string, any>): any;
export declare function tailEvents(
  file: string,
  fromSeq: number,
  onEvent: (e: any) => void,
  intervalMs?: number
): () => void;
export declare function readEvents(file: string, afterSeq?: number): any[];

/**
 * The control channel: what the editor says to a run, as opposed to what the run says about
 * itself. Append-only NDJSON at <runDir>/control.ndjson.
 */
export declare function appendControl(
  runDir: string,
  input: { action: ControlAction; target: ControlTarget; by?: string | null; request_id?: string }
): ControlRecord;
export declare function readControl(runDir: string, afterSeq?: number): ControlRecord[];
export declare function tailControl(
  runDir: string,
  fromSeq: number,
  onRecord: (r: ControlRecord) => void,
  intervalMs?: number
): () => void;
export declare function controlPath(runDir: string): string;

/** state.json — a cache of the projection. If it disagrees with the events, the events win. */
export declare function writeCheckpoint(runDir: string, checkpoint: Checkpoint): string;
export declare function readCheckpoint(runDir: string): Checkpoint | null;

export declare function validateArtifact(
  contractFile: string,
  data: unknown
): { ok: boolean; errors: string[] };
export declare function checkEvidenceContract(
  artifact: object,
  evidenceFile: string
): { ok: boolean; errors: string[]; refCount: number; recordCount: number };
export declare function collectEvidenceRefs(node: unknown, acc?: Set<string>): Set<string>;
export declare function readEvidence(file: string): EvidenceRecord[];

export declare function createRun(opts?: Record<string, any>): { runId: string; dir: string; manifest: RunManifest };
export declare function writeJsonAtomic(file: string, data: unknown): string;
export declare function readJson(file: string): any;
export declare function artifactPath(runDir: string, filename: string): string;
export declare function hasArtifact(runDir: string, filename: string): boolean;
export declare function appendEvidence(runDir: string, stageSlug: string, record: EvidenceRecord): string;
export declare function evidencePath(runDir: string, stageSlug: string): string;
export declare function latestRun(runsDir?: string): { runId: string; dir: string } | null;
export declare function listRuns(runsDir?: string): { runId: string; dir: string; manifest: RunManifest | null }[];
export declare function finalizeRun(runDir: string, status: string, extra?: Record<string, any>): RunManifest;

export declare function readLedger(file?: string): any[];
export declare function appendLedger(entry: Record<string, any>, file?: string): any;
export declare function recentLedgerDigest(limit?: number, file?: string): any[];
