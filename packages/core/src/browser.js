/**
 * Browser-safe subset of @carica/core.
 *
 * The review app needs the rubric arithmetic and the event projection — and must NOT drag
 * in the filesystem half of core (run store, validators, ledger), which imports node:fs and
 * cannot be bundled. Importing `@carica/core/browser` keeps that boundary explicit rather
 * than relying on tree-shaking to be clever enough.
 *
 * Both halves share one implementation, so the sliders in the UI compute exactly what S5 did.
 */
export * from './scoring.js';
export * from './projection.js';
