'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'

type Commit = { sha: string; message: string; date: string; url: string }
type Run = { id: number; display_title: string; status: string; conclusion: string | null; html_url: string; head_sha: string; created_at: string }
type StudioFile = { path: string; content: string; sha: string }
type PendingEdit = StudioFile & { edited: string }
type ChangedSource = { filename: string; status: string; additions?: number; deletions?: number; kind: 'ui' | 'backend' | null }
type Status = { configured: boolean; aiAvailable: boolean; previewUrl: string; setupNeeded: string[]; draftBranch: string; releaseBranch: string; draftSha?: string }

const api = '/api/admin/developer-studio'
const btn = 'inline-flex min-h-9 items-center justify-center rounded-lg border border-black/10 bg-white px-3 py-2 text-[11px] font-medium text-[#222] transition hover:bg-[#F8F8F7] disabled:cursor-not-allowed disabled:opacity-35'
const mainBtn = 'inline-flex min-h-9 items-center justify-center rounded-lg bg-[#171717] px-4 py-2 text-[11px] font-medium text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-35'

export function DeveloperStudioClient() {
  const [tab, setTab] = useState<'manual'|'ai'|'history'>('manual')
  const [status, setStatus] = useState<Status | null>(null)
  const [files, setFiles] = useState<string[]>([])
  const [search, setSearch] = useState('ChiefChat')
  const [newPath, setNewPath] = useState('')
  const [staged, setStaged] = useState<Record<string, PendingEdit>>({})
  const [changes, setChanges] = useState<ChangedSource[]>([])
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
  const [reviewUrl, setReviewUrl] = useState('')
  const dirty = Boolean(file && code !== file.content)
  const pendingCount = Object.keys(staged).filter(p => p !== file?.path).length + (dirty ? 1 : 0)
  const backendDraft = changes.some(c => c.kind === 'backend')
  const filtered = useMemo(() => Array.from(new Set([...files, ...Object.keys(staged)])).filter(p => p.toLowerCase().includes(search.toLowerCase())).slice(0,60), [files,search,staged])
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
      const [s, f, h, r, c] = await Promise.all([read('status'), read('files').catch(() => ({files: []})), read('history').catch(() => ({ commits: [] })), read('runs').catch(() => ({runs: []})), read('changes').catch(() => ({files: []}))])
      setStatus(s); setFiles(f.files || []); setCommits(h.commits || []); setRuns(r.runs || []); setChanges(c.files || []); if (s.draftSha) setReference(current => current || s.draftSha)
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
  function parkCurrent() {
    if (file && dirty) setStaged(prev => ({ ...prev, [file.path]: { ...file, edited: code } }))
    else if (file) setStaged(prev => { const copy = {...prev}; delete copy[file.path]; return copy })
  }
  const open = (path: string) => act(async () => {
    if (file?.path === path) return
    const cached = staged[path]
    const next: StudioFile = cached ? {path: cached.path, content: cached.content, sha: cached.sha}
      : (await read('file', `&path=${encodeURIComponent(path)}`)).file
    parkCurrent()
    setFile(next); setCode(cached ? cached.edited : next.content)
    setMessage('Editing '+path+' — changes are saved together as one draft commit.')
  })
  const addFile = () => act(async () => {
    const path = newPath.trim()
    if (!/^kvrn\/[a-zA-Z0-9_./\[\]()-]+\.(ts|tsx|css)$/.test(path)) throw Error('Enter a repository-relative .ts, .tsx or .css path beginning with kvrn/.')
    if (files.includes(path) || staged[path]) throw Error('This file already exists. Open it from the file list.')
    parkCurrent()
    setFile({ path, content: '', sha: '' }); setCode('')
    setNewPath(''); setMessage('New file ready. Save it with the other selected changes.')
  })
  const save = () => act(async () => {
    if (!status?.draftSha) throw Error('Could not resolve current draft SHA. Refresh.')
    const combined = Object.values(staged).filter(f => f.path !== file?.path)
    if (file && dirty) combined.push({...file,edited:code})
    if (!combined.length) throw Error('No unsaved changes.')
    const out = await submit({action:'save-batch',reference:status.draftSha,
      files:combined.map(f => ({path:f.path,content:f.edited,sha:f.sha}))})
    setStaged({}); setReference(out.commit)
    const [nextStatus, listed, comparison] = await Promise.all([read('status'),read('files'),read('changes')])
    setStatus(nextStatus);setFiles(listed.files || []);setChanges(comparison.files || [])
    if (file) {
      const latest = await read('file', `&path=${encodeURIComponent(file.path)}`)
      setFile(latest.file);setCode(latest.file.content)
    }
    setMessage(`${combined.length} files saved as one GitHub draft commit. Staging is building; production is unchanged.`)
  })
  const preview = () => act(async () => {
    if (pendingCount) throw Error('Save all staged files before building a preview.')
    const out = await submit({action:'preview'})
    setReference(out.reference);setMessage(out.message)
    const d = await read('runs'); setRuns(d.runs || [])
  })
  const reviewBackend = () => act(async () => {
    if (pendingCount || !previewReady || !backendDraft) throw Error('Save and verify an exact-commit staging build first.')
    if (!window.confirm('Create a GitHub draft pull request for these backend changes? This will NOT deploy production.')) return
    const out = await submit({action:'review-pr',reference,confirm:'REQUEST_REVIEW'})
    setReviewUrl(out.review.url)
    setMessage('Backend pull request created. Open GitHub to review checks and approve merging; nothing was deployed.')
  })
  const publish = () => act(async () => {
    if (pendingCount) throw Error('Save all staged files first.')
    if (!previewReady) throw Error('This exact version needs a passing staging preview before publishing.')
    if (backendDraft) throw Error('Backend changes must use GitHub pull request review, not direct Publish.')
    if (!window.confirm(`Publish ${changes.length} reviewed source file(s) to the live KVRN site? This triggers a production deployment.`)) return
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
    if (!window.confirm(`Restore compatible UI source from ${restoreSha.slice(0,8)} to draft? It will NOT publish automatically; Neon data is never reverted.`)) return
    const out = await submit({action:'rollback',sha:restoreSha,confirm:'RESTORE'})
    setMessage(out.message);setRestoreSha('');setReference(out.reference || '')
  })

  return <main className="mx-auto w-full max-w-[1200px] space-y-4 px-4 py-5 sm:px-7 sm:py-8 lg:px-10">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><p className="mb-1 text-[10px] font-medium uppercase tracking-[0.17em] text-black/35">KVRN SYSTEM</p><h1 className="text-[26px] font-medium tracking-[-0.035em] text-[#171717] sm:text-[30px]">Developer Studio</h1><p className="mt-1 text-[12px] text-black/50">Edit · Preview · Publish · Restore</p></div>
      <div className="flex items-center gap-2"><button type="button" className={btn} onClick={() => setShowHelp(s => !s)} aria-expanded={showHelp}>ⓘ Details</button><Link href="/admin/ai/chief" className={btn}>Chat with Chief</Link><a href="https://github.dev/omidhamidi1110/KVRN-/tree/kvrn-cp60-source-integration" target="_blank" rel="noreferrer" className={btn}>Protected files · Web editor ↗</a></div>
    </header>
    {showHelp && <div className="rounded-xl border border-black/10 bg-white p-4 text-[12px] leading-6 text-black/65">Manual edits are free of AI model charges. Optional per-file AI suggestions consume credits only when you press Generate. You can stage up to 12 source files per atomic GitHub draft. Backend code requires a reviewed GitHub pull request and CI checks (the Worker GitHub token needs Pull requests: Read and write). Security and deployment configuration remain protected and are edited through the GitHub web editor. AI suggestions remain optional and single-file; none are automatically saved. A successful, isolated staging build is required before publication. Preview has no live database, production secrets or custom domain. Restore changes draft UI source only and never changes Neon or publishes automatically.</div>}
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
        <input id="studio-search" className="mb-3 w-full rounded-lg border border-black/10 px-3 py-2 text-[12px] outline-none focus:border-black/40" placeholder="Search UI, API, AI agents and test files..." value={search} onChange={e => setSearch(e.target.value)}/>
        <div className="mb-3 space-y-2"><label htmlFor="studio-new-path" className="block text-[10px] text-black/50">New eligible source file (repository-relative path)</label><input id="studio-new-path" className="w-full rounded-lg border border-black/10 px-2 py-2 font-mono text-[10px]" value={newPath} onChange={e => setNewPath(e.target.value)} placeholder="kvrn/lib/ai/integrations/research-source.ts"/><button type="button" className={btn} disabled={busy || !newPath.trim()} onClick={() => void addFile()}>Add new file</button></div>
        <div className="max-h-[440px] space-y-0.5 overflow-y-auto">{filtered.map(path => <button type="button" key={path} title={path} onClick={() => void open(path)} className={`block w-full break-all rounded-lg px-2 py-2 text-left text-[11px] leading-4 ${file?.path===path?'bg-black/10 text-black':'text-black/60 hover:bg-black/[0.035]'}`}>{path.replace(/^kvrn\//,'')}</button>)}{!filtered.length && <p className="p-3 text-[11px] text-black/40">No matching editable files.</p>}</div>
      </section>
      <section className="min-w-0 overflow-hidden rounded-2xl border border-black/[0.08] bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-black/[0.07] px-4 py-3"><div><h2 className="text-[13px] font-semibold">{tab==='ai'?'Optional AI coding assistant':'Code editor'}</h2><p className="mt-1 break-all text-[10px] text-black/45">{file?.path || 'Select a file on the left'}</p></div><span className="rounded-md bg-[#F6F6F5] px-2 py-1 text-[10px] text-black/50">{dirty?'Unsaved edits':`${pendingCount} unsaved files`}</span></div>
        {tab==='ai' ? <div className="space-y-3 p-4"><p className="text-[12px] leading-6 text-black/60">Describe a change to this file. A paid AI model proposes replacement source; nothing is saved until you review it and click Save Draft.</p><textarea className="min-h-[150px] w-full resize-y rounded-xl border border-black/10 p-3 text-[13px] outline-none focus:border-black/40" value={instruction} onChange={e => setInstruction(e.target.value)} maxLength={1500} placeholder="Describe what to improve..."/><button className={mainBtn} disabled={!file || busy || !status?.aiAvailable} onClick={() => void requestAi()}>{busy?'Generating...':'Generate suggestion (paid AI)'}</button>{!status?.aiAvailable && <p className="text-[11px] text-black/45">Paid reasoning is not currently available.</p>}</div>
          : <div className="space-y-3 p-3 sm:p-4"><textarea spellCheck={false} aria-label="Source code editor" className="min-h-[410px] w-full resize-y rounded-xl border border-black/10 bg-[#FAFAF9] p-3 font-mono text-[11px] leading-5 text-[#242424] outline-none focus:border-black/40 sm:min-h-[500px] sm:text-[12px]" value={code} onChange={e => setCode(e.target.value)} disabled={!file}/><div className="flex flex-wrap items-center gap-2"><button type="button" className={mainBtn} disabled={!pendingCount || busy} onClick={() => void save()}>{busy?'Working...':`Save ${pendingCount} file(s) to draft`}</button><button type="button" className={btn} disabled={busy || Boolean(pendingCount)} onClick={() => void preview()}>Rebuild preview</button><button type="button" className={btn} disabled={!previewReady || busy || Boolean(pendingCount) || !changes.length || backendDraft} onClick={() => void publish()}>Publish UI to live site</button>{backendDraft && <button type="button" className={btn} disabled={!previewReady || busy || Boolean(pendingCount)} onClick={() => void reviewBackend()}>Create backend review PR</button>}</div><p className="text-[11px] leading-5 text-black/40">Switch files without losing edits. Save all staged files in one commit. Preview remains isolated from the production domain and Neon. Backend changes require GitHub review and passing CI before merge; UI-only publishing is a separate explicit step.</p></div>}
      </section>
    </div> : <section className="rounded-2xl border border-black/[0.08] bg-white p-4"><h2 className="mb-3 text-[13px] font-semibold">Release history</h2><p className="mb-3 text-[11px] text-black/50">Restoring creates a new draft commit. It does not automatically publish or reverse database changes.</p><div className="space-y-2">{commits.map((c,i) => <div key={c.sha} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-black/[0.06] p-3"><div className="min-w-0"><p className="break-words text-[12px] font-medium">{c.message}</p><p className="mt-1 text-[10px] text-black/40">{c.sha.slice(0,9)} · {new Date(c.date).toLocaleString()}</p></div><button type="button" className={btn} disabled={i===0 || busy} onClick={() => setRestoreSha(c.sha)}>{i===0?'Latest':'Restore'}</button></div>)}</div>{restoreSha && <div className="mt-4 rounded-xl border border-black/10 bg-[#FAFAF9] p-4"><p className="mb-3 text-[12px]">Restore application code from commit <code>{restoreSha.slice(0,12)}</code>?</p><div className="flex gap-2"><button className={mainBtn} disabled={busy} onClick={() => void restore()}>Request restore</button><button className={btn} onClick={() => setRestoreSha('')}>Cancel</button></div></div>}</section>}
    <section className="rounded-2xl border border-black/[0.08] bg-white p-4">
      <h2 className="text-[13px] font-semibold">Change-set review</h2>
      <p className="mt-1 text-[11px] text-black/50">{pendingCount} unsaved file(s) · {changes.length} changed file(s) on the GitHub draft. Backend changes require a GitHub pull request rather than direct publishing.</p>
      {pendingCount > 0 && <p className="mt-2 text-[11px] text-amber-700">Save your staged edits before previewing or publishing.</p>}
      <div className="mt-2 max-h-48 space-y-1 overflow-auto">{changes.map(change => <div key={change.filename} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[#F9F9F8] px-3 py-2 text-[11px]"><span className="break-all">{change.filename}</span><span className="text-black/45">{change.kind} · {change.status} · +{change.additions ?? 0}/-{change.deletions ?? 0}</span></div>)}</div>
      {reviewUrl && <a className="mt-3 inline-block text-[11px] underline" href={reviewUrl} target="_blank" rel="noreferrer">Open backend pull request ↗</a>}
      {!!changes.length && <a className="mt-3 inline-block text-[11px] underline" href="https://github.com/omidhamidi1110/KVRN-/compare/kvrn-cp60-source-integration...kvrn-studio-draft" target="_blank" rel="noreferrer">Review complete GitHub diff ↗</a>}
    </section>
    <section className="rounded-2xl border border-black/[0.08] bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-[13px] font-semibold">Preview & deployment activity</h2><p className="mt-1 text-[11px] text-black/45">Build and deployment progress updates automatically.</p></div>{status?.previewUrl && previewReady && <a className={btn} href={status.previewUrl} target="_blank" rel="noreferrer">Open staging preview ↗</a>}</div>
      <div className="space-y-2">{runs.slice(0,8).map(run => <div key={run.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-black/[0.06] px-3 py-2"><div className="min-w-0"><p className="break-words text-[11px] font-medium">{run.display_title}</p><p className="text-[10px] text-black/40">{new Date(run.created_at).toLocaleString()}</p></div><div className="flex items-center gap-2"><span className={`text-[10px] ${run.conclusion==='success'?'text-emerald-700':run.conclusion==='failure'?'text-red-700':'text-black/50'}`}>{run.conclusion || run.status}</span><a className="text-[11px] underline underline-offset-2" href={run.html_url} target="_blank" rel="noreferrer">Logs ↗</a></div></div>)}{!runs.length && <p className="text-[11px] text-black/50">No deployment runs reported yet.</p>}</div>
      {latestPreview && <p className="mt-3 text-[11px] text-black/40">Preview {latestPreview.conclusion || latestPreview.status} · {latestPreview.display_title.slice(15,27)}</p>}
    </section>
  </main>
}
