/** Developer Studio GitHub transport. Authenticated owner-facing server code only. */
const REPO = process.env.DEV_STUDIO_GITHUB_REPO || 'omidhamidi1110/KVRN-'
export const RELEASE = process.env.DEV_STUDIO_RELEASE_BRANCH || 'kvrn-cp60-source-integration'
export const DRAFT = process.env.DEV_STUDIO_DRAFT_BRANCH || 'kvrn-studio-draft'
export const WORKFLOW = 'kvrn-developer-studio.yml'
const token = () => process.env.DEV_STUDIO_GITHUB_TOKEN || ''
export const studioConfigured = () => Boolean(token() && /^[\w.-]+\/[\w.-]+$/.test(REPO))
export const previewUrl = () => process.env.DEV_STUDIO_PREVIEW_URL || ''

export type StudioFileKind = 'ui' | 'backend'
/** Explicitly scoped source editing. Nothing security/commerce/finance-sensitive is eligible. */
export function studioFileKind(path: string): StudioFileKind | null {
  if (typeof path !== 'string' || path.length > 240 || path.includes('..') || path.includes('\\') || path.includes('//')) return null
  if (!/^kvrn\/[a-zA-Z0-9_./\[\]()-]+\.(ts|tsx|css)$/.test(path)) return null
  if (/(?:^|\/)(?:node_modules|\.next|__tests__|middleware|_middleware)(?:\/|\.)/.test(path)) return null
  if (/^kvrn\/(app|components)\/.+\.(tsx|css)$/.test(path) && !/^kvrn\/app\/api\//.test(path)) return 'ui'
  // Backend AI research work only. Other backend source is handled through an independent reviewed PR.
  if (/^kvrn\/lib\/ai\/agents\/(?:ads-social|creator-affiliate|growth|market-intel|market-research|review-growth|video-performance)\.ts$/.test(path)) return 'backend'
  if (/^kvrn\/lib\/ai\/integrations\/research-[a-z0-9-]+\.ts$/.test(path)) return 'backend'
  if (/^kvrn\/app\/api\/admin\/ai\/research\/[a-z0-9/-]*route\.ts$/.test(path)) return 'backend'
  return null
}
export const editableFile = (path: string) => studioFileKind(path) !== null

export type GitHubFile = { path: string; sha: string; content: string; size: number }
export type DraftChange = { path: string; content: string; sha: string }
export class StudioError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}

export async function github<T = any>(endpoint: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  if (!studioConfigured()) throw new StudioError('Developer Studio is not connected to GitHub yet.', 503)
  const res = await fetch(`https://api.github.com/repos/${REPO}/${endpoint}`, {
    method: init.method || 'GET',
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'KVRN-Developer-Studio',
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    cache: 'no-store',
  })
  if (res.status === 204) return {} as T
  if (!res.ok) {
    if (res.status === 404) throw new StudioError('GitHub resource was not found or access was denied.', 404)
    if (res.status === 409 || res.status === 422) throw new StudioError('GitHub rejected this change (conflict, branch protection or invalid request). Refresh and retry.', 409)
    if (res.status === 401 || res.status === 403) throw new StudioError('GitHub permissions or rate limit prevented this operation.', 503)
    throw new StudioError('GitHub operation failed. Check the repository and Actions logs.', 502)
  }
  return res.json() as Promise<T>
}

export async function branchSha(branch: string): Promise<string> {
  const ref = await github<{ object: { sha: string } }>(`git/ref/heads/${encodeURIComponent(branch)}`)
  return ref.object.sha
}
/** Ensure an older draft can NEVER trigger its unsafe legacy preview workflow. */
export async function ensureDraft(): Promise<void> {
  const releaseSha = await branchSha(RELEASE)
  let draftSha: string
  try { draftSha = await branchSha(DRAFT) } catch (err) {
    if (!(err instanceof StudioError) || err.status !== 404) throw err
    await github('git/refs', { method: 'POST', body: { ref: `refs/heads/${DRAFT}`, sha: releaseSha } })
    return
  }
  const workflowAt = async (branch: string) => github<{ sha: string }>(
    `contents/.github/workflows/${WORKFLOW}?ref=${encodeURIComponent(branch)}`)
  const releaseWorkflow = await workflowAt(RELEASE)
  const draftWorkflow = await workflowAt(DRAFT)
  if (draftWorkflow.sha === releaseWorkflow.sha) return
  // The previous draft workflow deployed using wrangler.toml and claimed the
  // live domain. Fast-forward safe ancestors only; never force-reset edits.
  try {
    await github(`git/refs/heads/${DRAFT}`, { method: 'PATCH', body: { sha: releaseSha, force: false } })
  } catch {
    throw new StudioError('Draft uses a legacy unsafe preview workflow and contains unmerged edits. Merge the new release into the draft through GitHub before editing; no preview was started.', 409)
  }
}
export async function getFile(path: string, branch: string): Promise<GitHubFile> {
  if (!editableFile(path)) throw new StudioError('This source path requires a separate code review.', 400)
  const data = await github<{ type: string; sha: string; content: string; encoding: string; size: number }>(
    `contents/${path}?ref=${encodeURIComponent(branch)}`,
  )
  if (data.type !== 'file' || data.encoding !== 'base64' || data.size > 45_000) throw new StudioError('This file cannot be edited in the browser.', 413)
  return { path, sha: data.sha, size: data.size, content: Buffer.from(data.content.replace(/\s/g, ''), 'base64').toString('utf8') }
}
async function treeForCommit(commitSha: string) {
  const commit = await github<{ tree: { sha: string } }>(`git/commits/${commitSha}`)
  const tree = await github<{ tree: { path: string; sha: string; type: string; size?: number }[]; truncated?: boolean }>(`git/trees/${commit.tree.sha}?recursive=1`)
  if (tree.truncated) throw new StudioError('Repository tree was truncated; safely editing is unavailable.', 503)
  return { root: commit.tree.sha, entries: tree.tree }
}
export async function listFiles(): Promise<string[]> {
  const tree = await treeForCommit(await branchSha(DRAFT))
  return tree.entries.filter(item => item.type === 'blob' && (item.size ?? 0) < 45_000 && editableFile(item.path)).map(item => item.path).sort()
}

/** A single atomic commit for up to 12 files. Reject races and unexpected file creation. */
export async function commitChangeSet(changes: DraftChange[], expectedHead: string, authorEmail: string): Promise<string> {
  if (!/^[a-f\d]{40}$/.test(expectedHead)) throw new StudioError('Refresh draft state before saving.', 409)
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > 12) throw new StudioError('Select 1–12 files per change set.')
  const names = new Set<string>()
  let total = 0
  for (const c of changes) {
    if (!c || !editableFile(c.path) || typeof c.content !== 'string' || typeof c.sha !== 'string' ||
        (c.sha !== '' && !/^[a-f\d]{40}$/.test(c.sha))) throw new StudioError('An invalid file path or version was supplied.')
    if (names.has(c.path)) throw new StudioError('Each file may appear only once in a change set.')
    names.add(c.path)
    const bytes = Buffer.byteLength(c.content, 'utf8')
    if (!bytes || bytes > 40_000) throw new StudioError('Each source file must be between 1 and 40 KB.')
    total += bytes
  }
  if (total > 220_000) throw new StudioError('Change set exceeds 220 KB.')
  await ensureDraft()
  const head = await branchSha(DRAFT)
  if (head !== expectedHead) throw new StudioError('The GitHub draft changed. Refresh before saving to avoid conflicts.', 409)
  const tree = await treeForCommit(head)
  for (const c of changes) {
    const existing = tree.entries.find(e => e.path === c.path)
    if (existing ? existing.type !== 'blob' || existing.sha !== c.sha : c.sha !== '')
      throw new StudioError(`File changed or creation conflicts in ${c.path}. Refresh first.`, 409)
  }
  const nextTree = await github<{ sha: string }>('git/trees', { method: 'POST', body: {
    base_tree: tree.root,
    tree: changes.map(c => ({ path: c.path, mode: '100644', type: 'blob', content: c.content })),
  } })
  const nextCommit = await github<{ sha: string }>('git/commits', { method: 'POST', body: {
    message: `Developer Studio: ${changes.length} source files (${authorEmail})`,
    tree: nextTree.sha, parents: [head],
  } })
  // GitHub rejects a non-fast-forward ref update caused by a simultaneous editor.
  await github(`git/refs/heads/${DRAFT}`, { method: 'PATCH', body: { sha: nextCommit.sha, force: false } })
  return nextCommit.sha
}

export async function workflowRuns(): Promise<Array<{ id: number; name: string; display_title: string; status: string; conclusion: string | null; html_url: string; head_sha: string; created_at: string }>> {
  const data = await github<{ workflow_runs: any[] }>(`actions/workflows/${WORKFLOW}/runs?per_page=40`)
  return data.workflow_runs.map(run => ({ id: run.id, name: run.name, display_title: run.display_title,
    status: run.status, conclusion: run.conclusion, html_url: run.html_url, head_sha: run.head_sha, created_at: run.created_at }))
}
export async function requestPreview(): Promise<string> {
  const sha = await branchSha(DRAFT)
  const original = await github<{ tree: { sha: string } }>(`git/commits/${sha}`)
  const commit = await github<{ sha: string }>('git/commits', { method: 'POST', body: {
    message: 'Developer Studio: preview requested', tree: original.tree.sha, parents: [sha],
  } })
  await github(`git/refs/heads/${DRAFT}`, { method: 'PATCH', body: { sha: commit.sha, force: false } })
  return commit.sha
}
