// lib/__tests__/helpers/tsx-loader.ts — a tiny TS/TSX module loader for tests.
//
// This repo's jest setup has no JSX transform (tsconfig keeps jsx: "preserve" for Next), so page
// components are normally only source-guarded. This loader transpiles .ts/.tsx on the fly with the
// TypeScript compiler (jsx: react-jsx), resolves the "@/" alias, and lets a test actually render a
// page with react-dom/server. External packages come from the caller's `require`.

import fs from 'fs'
import path from 'path'
import ts from 'typescript'

export const ROOT = path.resolve(__dirname, '../../..')
const EXTS = ['.ts', '.tsx', '/index.ts', '/index.tsx']

export function createLoader(externalRequire: NodeRequire, opts: { rootDir?: string; sources?: Record<string, string> } = {}) {
  const root = opts.rootDir ?? ROOT
  const cache = new Map<string, any>()
  /** virtual file contents (e.g. a page as it was at an older commit), keyed by absolute path */
  const sources = new Map<string, string>(Object.entries(opts.sources ?? {}).map(([k, v]) => [path.resolve(root, k), v]))

  function resolveFile(spec: string, fromFile: string): string | null {
    const base = spec.startsWith('@/') ? path.join(root, spec.slice(2)) : path.resolve(path.dirname(fromFile), spec)
    for (const e of ['', ...EXTS]) {
      const p = base + e
      if (sources.has(p)) return p
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p
    }
    return null
  }

  function load(file: string): any {
    if (cache.has(file)) return cache.get(file).exports
    const src = sources.get(file) ?? fs.readFileSync(file, 'utf8')
    const out = ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
      fileName: file,
    }).outputText
    const mod = { exports: {} as any }
    cache.set(file, mod)
    const req = (spec: string) => {
      if (spec.startsWith('@/') || spec.startsWith('.')) {
        const f = resolveFile(spec, file)
        if (!f) throw new Error(`tsx-loader: cannot resolve ${spec} from ${file}`)
        return load(f)
      }
      return externalRequire(spec)
    }
    // eslint-disable-next-line no-new-func
    new Function('exports', 'require', 'module', '__filename', '__dirname', out)(mod.exports, req, mod, file, path.dirname(file))
    return mod.exports
  }

  return {
    /** Load a module by repo-relative path (honours `sources` overrides). */
    load: (rel: string) => load(path.resolve(root, rel)),
  }
}
