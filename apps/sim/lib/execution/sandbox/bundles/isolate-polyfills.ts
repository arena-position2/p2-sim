/**
 * Minimal isolate-side shim run at the top of every bundle entry.
 *
 * Must execute BEFORE `process/browser` because that shim captures
 * `setTimeout` at module-init time. Timers themselves are installed by
 * `isolated-vm-worker.cjs` (delegated to Node's real timers via
 * `ivm.Reference` per laverdet/isolated-vm#136) BEFORE the bundle runs, so
 * `process/browser` picks up the real delegated `setTimeout`.
 *
 * The only things this file still does:
 * - alias `global -> globalThis` for UMD-style fallbacks inside the bundles
 * - define `__require` so Bun's IIFE leftover for optional CJS deps (e.g. the
 *   `docx` package's optional `stream` import, and esbuild's helper around
 *   JSZip's UMD build) does not throw `ReferenceError: __require is not
 *   defined` during evaluation or Document construction
 *
 * All other runtime surface (`console`, `TextEncoder`, `TextDecoder`, timers)
 * is installed by the worker via `ivm.Callback` / `ivm.Reference` bridges to
 * Node's native implementations — no hand-rolled polyfill logic lives in the
 * isolate.
 */

const g: typeof globalThis & {
  global?: typeof globalThis
  __require?: (id: string) => never
} = globalThis

if (typeof g.global === 'undefined') g.global = globalThis

/**
 * Bun's browser IIFE emit can leave a free `__require` in two ways:
 *
 * - Optional Node builtins that were not fully inlined (e.g. `stream` in
 *   `docx`). Those call sites catch the throw; the free variable must still
 *   resolve.
 * - A library that inlines a CommonJS dependency ships esbuild's `__require`
 *   helper around it (docx >= 9.7.1 does this for JSZip's UMD build). Bun
 *   rewrites the bare `require` references inside that helper to its own
 *   `__require` runtime helper and then never emits it, so the bundle throws
 *   `ReferenceError: __require is not defined` while it is still being
 *   evaluated.
 *
 * The isolate has no `require` at all, so the only correct answer to a dynamic
 * require is the one esbuild's helper gives when `require` is absent: throw.
 * Defining it here keeps every bundle self-contained; `build.ts` evaluates
 * each bundle in a bare context so a new variant of the defect fails the
 * build instead of shipping.
 */
if (typeof g.__require !== 'function') {
  g.__require = (id: string): never => {
    throw new Error(`Dynamic require of "${id}" is not supported in the document sandbox`)
  }
}

export {}
