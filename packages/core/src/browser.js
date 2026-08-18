/**
 * Browser-safe subset of @carica/core.
 *
 * The review app needs the rubric arithmetic and the event projection — and must NOT drag
 * in the filesystem half of core (run store, validators, ledger, the event and control
 * logs), which imports node:fs and cannot be bundled. Importing `@carica/core/browser`
 * keeps that boundary explicit rather than relying on tree-shaking to be clever enough.
 *
 * Both halves share one implementation, so the sliders in the UI compute exactly what S5
 * did, the app's idea of "shard 3 was killed" is the server's, and the resume picker offers
 * the steps the pipeline would actually accept.
 *
 * The rule for adding anything here: it must be pure. If it reads a file, it belongs in
 * index.js, and the app should ask the server for the answer instead.
 */
export * from './scoring.js';
export * from './projection.js';
export * from './control-state.js';
export * from './checkpoint-derive.js';
