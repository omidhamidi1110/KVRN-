'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'

type Commit = { sha: string; message: string; date: string; url: string }
type Run = { id: number; display_title: string; status: string; conclusion: string | null; html_url: string; head_sha: string; created_at: string }
type StudioFile = { path: string; content: string; sha: string }
type Status = { configured: boolean; aiAvailable: boolean; previewUrl: string; setupNeeded: string[]; draftBranch: string; releaseBranch: string; draftSha?: string }

const api = '/api/admin/developer-studio'
const btn = 'inline-flex min-h-9 items-center justify-center rounded-lg border border-black/10 bg-white px-3 py-2 text-[11px] font-medium text-[#222] transition hover:bg-[#F8F8F7] disabled:cursor-not-allowed disabled:opacity-35'
const mainBtn = 'inline-flex min-h-9 items-center justify-center rounded-lg bg-[#171717] px-4 py-2 text-[11px] font-medium text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-35'

export function DeveloperStudioClient() {
  const [tab, setTab] = useState<'manual'|'ai'|'history'>('manual')
  const [status, setStatus] = useState<Status | null>(null)
  const [files, setFiles] = useState<string[]>([])
  const [search, setSearch] = useState('ChiefChat')
  const [file, setFile] = useState<StudioFile | null>(null)
  const [code, setCode] = useState('')
  const [instruction, setInstruction] = useState('')
  const [commits, setCommits] = useState<Commit[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [reference, setReference] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [restoreSha, setRestoreSha] = useState('')
  const dirty = Boolean(file && code !== file.content)
  const filtered = useMemo(() => files.filter(p => p.toLowerCase().includes(search.toLowerCase())).slice(0,60), [files,search])
  const latestPreview = runs.find(r => r.display_title.startsWith('Studio preview '))
  const previewReady = latestPreview?.conclusion === 'success' && latestPreview.head_sha === reference

  const read = useCallback(async (action: string, extras = '') => {
    const res = await fetch(`${api}?action=${action}${extras}`, { cache: 'no-store' })
    const data = await res.json()
    if (!res.ok) throw Error(data.error || 'Request failed.')
    return data
  }, [])
  const submit = useCallback(async (body: Record<string,unknown>) => {
    const res = await fetch(api, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) })
    const data = await res.json()
    if (!res.ok) throw Error(data.error || 'Request failed.')
    return data
  }, [])
  const refresh = useCallback(async () => {
    try {
      const [s, f, h, r] = await Promise.all([read('status'), read('files').catch(() => ({files: []})), read('history').catch(() => ({ commits: [] })), read('runs').catch(() => ({runs: []}))])
      setStatus(s); setFiles(f.files || []); setCommits(h.commits || []); setRuns(r.runs || []); if (s.draftSha) setReference(current => current || s.draftSha)
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not load Developer Studio.') }
  }, [read])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    // Poll lightweight GitHub Actions status while active, not code/AI.
    if (!status?.configured) return
    const timer = setInterval(() => { read('runs').then(d => setRuns(d.runs || [])).catch(() => {}) }, 12000)
    return () => clearInterval(timer)
  }, [read,status?.configured])

  async function act(work: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError(''); setMessage('')
    try { await work() } catch (err) { setError(err instanceof Error ? err.message : 'Action failed.') } finally { setBusy(false) }
  }
  const open = (path: string) => act(async () => {
    if (dirty && !window.confirm('Discard unsaved edits in the current file?')) return
    const body = await read('file', `&path=${encodeURIComponent(path)}`)
    setFile(body.file); setCode(body.file.content); setReference(''); setMessage('Editing draft version of '+path)
  })
  const save = () => act(async () => {
    if (!file || !dirty) return
    const out = await submit({action:'save',path:file.path,content:code,sha:file.sha})
    setFile({...file,sha:out.sha,content:code});setReference(out.commit)
    setMessage('Saved as a GitHub draft commit. Staging preview is building automatically; production is unchanged.')
  })
  const preview = () => act(async () => {
    if (dirty) throw Error('Save the file before building a preview.')
    const out = await submit({action:'preview'})
    setReference(out.reference);setMessage(out.message)
    const d = await read('runs'); setRuns(d.runs || [])
  })
  const publish = () => act(async () => {
    if (dirty) throw Error('Save the current draft first.')
    if (!previewReady) throw Error('This exact version needs a passing staging preview before publishing.')
    if (!window.confirm('Publish these UI edits to the live KVRN site? GitHub Actions will automatically build and deploy.')) return
    const out = await submit({action:'publish',reference,confirm:'PUBLISH'})
    setMessage(`${out.message} Commit ${String(out.commit).slice(0,8)}.`);setReference('')
    await refresh()
  })
  const requestAi = () => act(async () => {
    if (!file) throw Error('Choose a file first.')
    if (!instruction.trim()) throw Error('Describe the requested change.')
    if (!window.confirm('Use paid AI credits to suggest a replacement for this file? AI will receive the selected source and your instructions.')) return
    const out = await submit({action:'ai',confirm:true,path:file.path,instruction})
    setCode(out.suggestion);setMessage(`AI suggestion loaded into editor (${out.model}, estimated $${out.costUsd}). Review it, then Save Draft. No code was published.`)
    setTab('manual')
  })
  const restore = () => act(async () => {
    if (!restoreSha) return
    if (!window.confirm(`Request restoration to ${restoreSha.slice(0,8)}? This will build a restored draft and automatically publish if preview passes; Neon data is never reverted.`)) return
    const out = await submit({action:'rollback',sha:restoreSha,confirm:'RESTORE'})
    setMessage(out.message);setRestoreSha('');setReference(out.reference || '')
  })

  return <main className="mx-auto w-full max-w-[1200px] space-y-4 px-4 py-5 sm:px-7 sm:py-8 lg:px-10">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><p className="mb-1 text-[10px] font-medium uppercase tracking-[0.17em] text-black/35">KVRN SYSTEM</p><h1 className="text-[26px] font-medium tracking-[-0.035em] text-[#171717] sm:text-[30px]">Developer Studio</h1><p className="mt-1 text-[12px] text-black/50">Edit · Preview · Publish · Restore</p></div>
      <div className="flex items-center gap-2"><button type="button" className={btn} onClick={() => setShowHelp(s => !s)} aria-expanded={showHelp}>ⓘ Details</button><Link href="/admin/ai/chief" className={btn}>Chat with Chief</Link></div>
    </header>
    {showHelp && <div className="rounded-xl border border-black/10 bg-white p-4 text-[12px] leading-6 text-black/65">Manual edits are free of AI model charges. The optional AI assistant requests paid inference only when you press Generate. Draft commits do not update production. A staging build is required for full application preview; not all components can render instantly from TSX. Production uses a separate GitHub Actions release. Restore creates a new version of compatible application code but never reverses orders or Neon migrations. Editing is limited to approved interface files.</div>}
    {!status?.configured && <section className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-[12px] text-amber-900"><b>One-time GitHub connection required.</b> {status?.setupNeeded?.join(' · ') || 'Checking integration...'}. Until connected, Developer Studio cannot save or deploy changes.</section>}
    {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-[12px] text-red-800">{error}</div>}
    {message && <div role="status" className="rounded-xl border border-black/10 bg-[#F9F9F8] p-3 text-[12px] text-black/70">{message}</div>}
    <div className="flex flex-wrap gap-2 rounded-xl border border-black/[0.08] bg-white p-2">
      {([['manual','Manual editor'],['ai','AI assistant · optional'],['history','History & restore']] as const).map(([id,label]) => <button key={id} type="button" onClick={() => setTab(id)} className={`rounded-lg px-4 py-2.5 text-[11px] font-medium ${tab===id?'bg-[#171717] text-white':'text-black/55 hover:bg-black/[0.04]'}`}>{label}</button>)}
      <button type="button" className="ml-auto px-3 text-[11px] text-black/50 hover:text-black" onClick={() => void refresh()}>Refresh</button>
    </div>
    {tab !== 'history' ? <div className="grid gap-4 lg:grid-cols-[270px_minmax(0,1fr)]">
      <section className="min-w-0 rounded-2xl border border-black/[0.08] bg-white p-3">
        <h2 className="mb-3 px-1 text-[12px] font-semibold">Source files</h2>
        <label htmlFor="studio-search" className="sr-only">Search source files</label>
        <input id="studio-search" className="mb-3 w-full rounded-lg border border-black/10 px-3 py-2 text-[12px] outline-none focus:border-black/40" placeholder="Search UI files..." value={search} onChange={e => setSearch(e.target.value)}/>
        <div className="max-h-[440px] space-y-0.5 overflow-y-auto">{filtered.map(path => <button type="button" key={path} title={path} onClick={() => void open(path)} className={`block w-full break-all rounded-lg px-2 py-2 text-left text-[11px] leading-4 ${file?.path===path?'bg-black/10 text-black':'text-black/60 hover:bg-black/[0.035]'}`}>{path.replace(/^kvrn\//,'')}</button>)}{!filtered.length && <p className="p-3 text-[11px] text-black/40">No matching editable files.</p>}</div>
      </section>
      <section className="min-w-0 overflow-hidden rounded-2xl border border-black/[0.08] bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-black/[0.07] px-4 py-3"><div><h2 className="text-[13px] font-semibold">{tab==='ai'?'Optional AI coding assistant':'Code editor'}</h2><p className="mt-1 break-all text-[10px] text-black/45">{file?.path || 'Select a file on the left'}</p></div><span className="rounded-md bg-[#F6F6F5] px-2 py-1 text-[10px] text-black/50">{dirty?'Unsaved changes':'Draft branch'}</span></div>
        {tab==='ai' ? <div className="space-y-3 p-4"><p className="text-[12px] leading-6 text-black/60">Describe a change to this file. A paid AI model proposes replacement source; nothing is saved until you review it and click Save Draft.</p><textarea className="min-h-[150px] w-full resize-y rounded-xl border border-black/10 p-3 text-[13px] outline-none focus:border-black/40" value={instruction} onChange={e => setInstruction(e.target.value)} maxLength={1500} placeholder="Describe what to improve..."/><button className={mainBtn} disabled={!file || busy || !status?.aiAvailable} onClick={() => void requestAi()}>{busy?'Generating...':'Generate suggestion (paid AI)'}</button>{!status?.aiAvailable && <p className="text-[11px] text-black/45">Paid reasoning is not currently available.</p>}</div>
          : <div className="space-y-3 p-3 sm:p-4"><textarea spellCheck={false} aria-label="Source code editor" className="min-h-[410px] w-full resize-y rounded-xl border border-black/10 bg-[#FAFAF9] p-3 font-mono text-[11px] leading-5 text-[#242424] outline-none focus:border-black/40 sm:min-h-[500px] sm:text-[12px]" value={code} onChange={e => setCode(e.target.value)} disabled={!file}/><div className="flex flex-wrap items-center gap-2"><button type="button" className={mainBtn} disabled={!dirty || busy} onClick={() => void save()}>{busy?'Working...':'Save draft to GitHub'}</button><button type="button" className={btn} disabled={!file || busy || dirty} onClick={() => void preview()}>Rebuild preview</button><button type="button" className={btn} disabled={!previewReady || busy || dirty} onClick={() => void publish()}>Publish to live site</button></div><p className="text-[11px] leading-5 text-black/40">Editing source is immediate; a complete visual preview requires a staging build. Production updates after a successful deployment.</p></div>}
      </section>
    </div> : <section className="rounded-2xl border border-black/[0.08] bg-white p-4"><h2 className="mb-3 text-[13px] font-semibold">Release history</h2><p className="mb-3 text-[11px] text-black/50">Restoring creates a new commit and redeploys compatible code. It does not reverse database changes.</p><div className="space-y-2">{commits.map((c,i) => <div key={c.sha} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-black/[0.06] p-3"><div className="min-w-0"><p className="break-words text-[12px] font-medium">{c.message}</p><p className="mt-1 text-[10px] text-black/40">{c.sha.slice(0,9)} · {new Date(c.date).toLocaleString()}</p></div><button type="button" className={btn} disabled={i===0 || busy} onClick={() => setRestoreSha(c.sha)}>{i===0?'Latest':'Restore'}</button></div>)}</div>{restoreSha && <div className="mt-4 rounded-xl border border-black/10 bg-[#FAFAF9] p-4"><p className="mb-3 text-[12px]">Restore application code from commit <code>{restoreSha.slice(0,12)}</code>?</p><div className="flex gap-2"><button className={mainBtn} disabled={busy} onClick={() => void restore()}>Request restore</button><button className={btn} onClick={() => setRestoreSha('')}>Cancel</button></div></div>}</section>}
    <section className="rounded-2xl border border-black/[0.08] bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-[13px] font-semibold">Preview & deployment activity</h2><p className="mt-1 text-[11px] text-black/45">Build and deployment progress updates automatically.</p></div>{status?.previewUrl && previewReady && <a className={btn} href={status.previewUrl} target="_blank" rel="noreferrer">Open staging preview ↗</a>}</div>
      <div className="space-y-2">{runs.slice(0,8).map(run => <div key={run.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-black/[0.06] px-3 py-2"><div className="min-w-0"><p className="break-words text-[11px] font-medium">{run.display_title}</p><p className="text-[10px] text-black/40">{new Date(run.created_at).toLocaleString()}</p></div><div className="flex items-center gap-2"><span className={`text-[10px] ${run.conclusion==='success'?'text-emerald-700':run.conclusion==='failure'?'text-red-700':'text-black/50'}`}>{run.conclusion || run.status}</span><a className="text-[11px] underline underline-offset-2" href={run.html_url} target="_blank" rel="noreferrer">Logs ↗</a></div></div>)}{!runs.length && <p className="text-[11px] text-black/50">No deployment runs reported yet.</p>}</div>
      {latestPreview && <p className="mt-3 text-[11px] text-black/40">Preview {latestPreview.conclusion || latestPreview.status} · {latestPreview.display_title.slice(15,27)}</p>}
    </section>
  </main>
}
