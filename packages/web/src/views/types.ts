import type { RunState } from '@carica/core/browser';

export interface ViewProps {
  runId: string;
  /** Bumped when the stage completes, so the view refetches its artifact. */
  version: unknown;
  state: RunState;
}
