// lib/__tests__/pdp-render-harness.ts — server-render the REAL PDPClient inside jest (node env).
//
// jest here has no jsdom and no JSX transform, so the harness transpiles the .tsx source itself
// (TypeScript, jsx: react-jsx) and evaluates it with a small require shim: Next/React-context
// modules are replaced by tiny deterministic stand-ins, every other import is resolved by jest.
// It lets tests prove that the storefront markup is unchanged for the coded catalog (golden
// fixtures captured from the original component) and that CMS data renders the same template.
import fs from 'fs'
import path from 'path'
import ts from 'typescript'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

export const ROOT = path.resolve(__dirname, '../..')

const noop = () => {}

export function defaultMocks(over: Record<string, any> = {}): Record<string, any> {
  return {
    'next/image': {
      __esModule: true,
      default: (p: any) => React.createElement('img', {
        src: p.src, alt: p.alt, className: p.className, style: p.style, sizes: p.sizes, loading: p.loading,
      }),
    },
    'next/link': {
      __esModule: true,
      default: (p: any) => React.createElement('a', { href: p.href, className: p.className, style: p.style }, p.children),
    },
    '@/context/CartContext': { useCart: () => ({ addItem: noop, openCart: noop }) },
    '@/context/CurrencyContext': { useCurrency: () => ({ formatPrice: (c: number) => `$${Math.round(c / 100)}` }) },
    '@/context/I18nContext': {
      useI18n: () => ({ t: { soldOut: 'Sold Out', addedToBag: 'Added', addToBag: 'Add to Bag', selectSize: 'Select a Size' } }),
    },
    '@/context/CookiePrefsContext': { useCookiePrefs: () => ({ prefs: null }) },
    '@/lib/funnel-client': { trackProductView: noop },
    '@/lib/ga-client': { gaViewItemWhenReady: noop },
    ...over,
  }
}

/** Compile + evaluate a .tsx source string; returns its module.exports. */
export function loadTsx(source: string, filename: string, mocks: Record<string, any> = defaultMocks()): any {
  const out = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true, isolatedModules: true,
    },
  }).outputText
  const mod: { exports: any } = { exports: {} }
  const req = (id: string): any => {
    if (id in mocks) return mocks[id]
    // Project .tsx modules (jest cannot compile JSX here) are compiled by this same loader.
    if (id.startsWith('@/')) {
      const base = path.join(ROOT, id.slice(2))
      const tsxFile = [`${base}.tsx`, path.join(base, 'index.tsx')].find(f => fs.existsSync(f))
      if (tsxFile) return loadTsx(fs.readFileSync(tsxFile, 'utf8'), tsxFile, mocks)
    }
    return require(id)
  }
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', out)(req, mod, mod.exports)
  return mod.exports
}

export function loadTsxFile(rel: string, mocks?: Record<string, any>) {
  const file = path.join(ROOT, rel)
  return loadTsx(fs.readFileSync(file, 'utf8'), file, mocks)
}

export function renderPdp(PDPClient: any, props: Record<string, any>): string {
  return renderToStaticMarkup(React.createElement(PDPClient, props))
}
