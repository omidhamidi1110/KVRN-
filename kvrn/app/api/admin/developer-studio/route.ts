import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { readAdminMutationJson } from '@/lib/admin-mutation-safety'
import { runAiTask } from '@/lib/ai/router'
import { github, branchSha, ensureDraft, getFile, listFiles, workflowRuns, requestPreview,
  editableFile, studioConfigured, previewUrl, DRAFT, RELEASE, StudioError } from '@/lib/developer-studio'

export const dynamic = 'force-dynamic'
const SHA = /^[a-f0-9]{40}$/
const respondError = (error: unknown) => NextResponse.json({ error: error instanceof StudioError ? error.message : 'Developer Studio request failed.' },
  { status: error instanceof StudioError ? error.status : 500 })

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  const action = req.nextUrl.searchParams.get('action') || 'status'
  if (action === 'status') {
    let draftSha = ''
    if (studioConfigured()) try { draftSha = await branchSha(DRAFT) } catch { /* not created yet */ }
    return NextResponse.json({ configured: studioConfigured(), aiAvailable: process.env.AI_ENABLED === 'true',
      previewUrl: previewUrl(), draftSha, draftBranch: DRAFT, releaseBranch: RELEASE,
      setupNeeded: !studioConfigured() ? ['DEV_STUDIO_GITHUB_TOKEN Worker secret', 'GitHub Actions Cloudflare deploy secret'] : [] })
  }
  try {
    if (action === 'files') { await ensureDraft(); return NextResponse.json({ files: await listFiles() }) }
    if (action === 'file') {
      const path = req.nextUrl.searchParams.get('path') || ''
      await ensureDraft()
      return NextResponse.json({ file: await getFile(path, DRAFT), draftSha: await branchSha(DRAFT) })
    }
    if (action === 'history') {
      const commits = await github<{ sha: string; commit: { message: string; author: { date: string } }; html_url: string }[]>(`commits?sha=${encodeURIComponent(RELEASE)}&per_page=25`)
      return NextResponse.json({ commits: commits.map(c => ({ sha: c.sha, message: c.commit.message.split('\n')[0], date: c.commit.author.date, url: c.html_url })) })
    }
    if (action === 'runs') return NextResponse.json({ runs: await workflowRuns() })
    return NextResponse.json({ error: 'Unsupported action.' }, { status: 400 })
  } catch (err) { return respondError(err) }
}

export async function POST(req: NextRequest) {
  const { identity, error } = await requireAdmin(req)
  if (error) return error
  const parsed = await readAdminMutationJson(req, 63_000)
  if (!parsed.ok) return NextResponse.json({ error: 'Invalid or unauthorized request.' }, { status: parsed.status })
  const b = parsed.value as Record<string, unknown> | null
  if (!b || typeof b !== 'object' || Array.isArray(b)) return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  const action = b.action
  try {
    if (action === 'save') {
      if (!editableFile(b.path as string) || typeof b.content !== 'string' || b.content.length > 40_000 || typeof b.sha !== 'string' || !SHA.test(b.sha))
        throw new StudioError('Invalid file, content size or version. Refresh the file and retry.')
      await ensureDraft()
      const current = await getFile(b.path as string, DRAFT)
      if (current.sha !== b.sha) throw new StudioError('This file changed in GitHub. Reload before saving to prevent overwriting someone else.', 409)
      const result = await github<{ commit: { sha: string }; content: { sha: string } }>(`contents/${b.path}`, { method: 'PUT', body: {
        message: `Developer Studio: edit ${b.path} (${identity.email})`, branch: DRAFT, sha: current.sha,
        content: Buffer.from(b.content, 'utf8').toString('base64'),
      } })
      return NextResponse.json({ saved: true, commit: result.commit.sha, sha: result.content.sha, message: 'Draft saved; preview build triggered automatically.' })
    }
    if (action === 'preview') {
      await ensureDraft()
      const sha = await requestPreview()
      return NextResponse.json({ queued: true, reference: sha, message: 'Staging preview was queued by a GitHub commit. Track the build below.' })
    }
    if (action === 'publish') {
      const draftSha = await branchSha(DRAFT)
      if (b.confirm !== 'PUBLISH' || b.reference !== draftSha) throw new StudioError('The draft changed. Refresh preview and confirm publishing again.', 409)
      const compare = await github<{ files?: { filename: string; status: string }[]; total_commits: number }>(
        `compare/${encodeURIComponent(RELEASE)}...${encodeURIComponent(DRAFT)}`)
      if (!compare.files?.length || compare.files.length > 20 || compare.total_commits > 25 ||
        compare.files.some(file => file.status !== 'modified' || !editableFile(file.filename)))
        throw new StudioError('Only a small set of existing UI files can be published directly. Review this change in GitHub instead.', 409)
      const runs = await workflowRuns()
      if (!runs.some(r => r.head_sha === draftSha && r.conclusion === 'success' && r.display_title.startsWith('Studio preview ')))
        throw new StudioError('Build a successful staging preview of this exact draft before publishing.', 409)
      const response = await github<{ sha: string; merged: boolean }>('merges', { method: 'POST', body: {
        base: RELEASE, head: draftSha, commit_message: `Developer Studio: publish UI changes (${identity.email})`,
      } })
      try {
        // New changes start from the latest published commit, avoiding stale draft branches.
        await github(`git/refs/heads/${DRAFT}`, { method: 'PATCH', body: { sha: response.sha, force: true } })
      } catch { /* Production merge is already accepted; stale draft is detectable on next publish. */ }
      return NextResponse.json({ published: response.merged, commit: response.sha, message: 'Merged into release branch; production deployment starts automatically.' })
    }
    if (action === 'rollback') {
      if (b.confirm !== 'RESTORE' || typeof b.sha !== 'string' || !SHA.test(b.sha)) throw new StudioError('Select a valid release and confirm restore.')
      // Restore a bounded set of eligible UI files as a NEW draft commit based on
      // the latest production HEAD. GitHub Actions previews it then auto-merges only
      // a successful explicitly marked restore, never Neon or migrations.
      const releaseSha = await branchSha(RELEASE)
      const comparison = await github<{ status: string; files?: { filename: string; status: string }[] }>(`compare/${b.sha}...${releaseSha}`)
      const changed = comparison.files || []
      if (!['ahead','identical'].includes(comparison.status) || !changed.length || changed.length > 20 ||
          changed.some(f => f.status !== 'modified' || !editableFile(f.filename)))
        throw new StudioError('This version cannot be safely restored automatically (non-UI changes or too many files). Use GitHub for a reviewed restore.', 409)
      const currentTree = await github<{ tree: { sha: string } }>(`git/commits/${releaseSha}`)
      const oldCommit = await github<{ tree: { sha: string } }>(`git/commits/${b.sha}`)
      const oldTree = await github<{ tree: { path: string; sha: string; type: string }[]; truncated?: boolean }>(`git/trees/${oldCommit.tree.sha}?recursive=1`)
      if (oldTree.truncated) throw new StudioError('Historic source tree too large to verify.', 409)
      const snapshots = changed.map(f => ({ path: f.filename, entry: oldTree.tree.find(t => t.path===f.filename) }))
      if (snapshots.some(s => !s.entry || s.entry.type !== 'blob')) throw new StudioError('Some files did not exist in the selected version.', 409)
      const restoredTree = await github<{ sha: string }>('git/trees', { method:'POST', body: {
        base_tree: currentTree.tree.sha,
        tree: snapshots.map(s => ({path:s.path, mode:'100644', type:'blob', sha:s.entry!.sha})),
      } })
      const commit = await github<{sha:string}>('git/commits', {method:'POST', body: {
        message:`Developer Studio: restore UI to ${b.sha}`, tree:restoredTree.sha, parents:[releaseSha],
      }})
      // A restore intentionally resets the current draft. The owner confirms this in UI.
      await ensureDraft()
      await github(`git/refs/heads/${DRAFT}`, { method:'PATCH', body: {sha:commit.sha,force:true} })
      return NextResponse.json({ queued:true, reference:commit.sha,
        message:'Restore preview queued. After a successful staging build, GitHub Actions automatically publishes this compatible UI restore.' })
    }
    if (action === 'ai') {
      if (b.confirm !== true || !editableFile(b.path as string) || typeof b.instruction !== 'string' || b.instruction.length < 5 || b.instruction.length > 1500)
        throw new StudioError('Select an editable file and explicitly request AI assistance.')
      await ensureDraft()
      const file = await getFile(b.path as string, DRAFT)
      if (file.content.length > 8500) throw new StudioError('This file is too long for a safe full-file AI suggestion. Edit it manually.')
      const response = await runAiTask({ agentId: 'chief', role: 'cheap', purpose: 'owner_developer_studio_optional_code_suggestion',
        essential: false, temperature: 0.1, maxOutputTokens: 3800,
        system: 'You are a careful TypeScript/React developer. Return ONLY the full resulting source file as plain code, no markdown or commentary. Do not alter security policy or introduce secrets, database queries, server APIs, permissions or external services. If unable, return the exact string UNABLE_TO_SUGGEST.',
        input: JSON.stringify({ path: b.path, instructions: b.instruction, originalSource: file.content }),
      })
      const suggestion = response.text.trim().replace(/^```[\w-]*\s*\n/, '').replace(/\n```$/, '')
      if (suggestion === 'UNABLE_TO_SUGGEST' || suggestion.length < 15 || suggestion.length > 40_000) throw new StudioError('AI did not generate a usable suggestion. Your original source was not modified.')
      return NextResponse.json({ suggestion, model: response.model, costUsd: Number((response.costMicros/1e6).toFixed(6)) })
    }
    throw new StudioError('Unsupported operation.')
  } catch (err) { return respondError(err) }
}
