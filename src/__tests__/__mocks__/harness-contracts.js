/**
 * Shim for @harness/contracts in Jest tests.
 *
 * Re-exports everything from the real package, plus stubs the symbols that
 * @harness/core/dist/studio/validate.js and
 * @harness/core/dist/verification/studio-checkers.js import but that were
 * removed from (or never shipped in) the current @harness/contracts build.
 *
 * Without this shim Jest throws a SyntaxError at module-link time:
 *   "The requested module '@harness/contracts' does not provide an export
 *    named 'SelectionSchema'"
 */

// Re-export the real package (resolved by relative path so it bypasses the
// @harness/contracts → shim mapping and avoids a circular reference).
export * from '../../../node_modules/@harness/contracts/dist/index.js';

// ---- Stubs for schemas removed from the dist ----
// These are referenced by @harness/core but are not needed by render-worker
// code paths; they only need to be importable without crashing.

const _zStub = {
  safeParse: (_v) => ({ success: false, error: { issues: [] } }),
  parse: (_v) => { throw new Error('stub schema: not implemented'); },
};

export const SelectionSchema = _zStub;
export const TreatmentSchema = _zStub;
export const StudioNarrationSchema = _zStub;
export const TimelineV2Schema = _zStub;
