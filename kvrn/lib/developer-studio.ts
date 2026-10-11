/** Owner-only GitHub transport for Developer Studio. Never import from a client. */
const REPO = process.env.DEV_STUDIO_GITHUB_REPO || 'omidhamidi1110/KVRN-'
export const RELEASE = process.env.DEV_STUDIO_RELEASE_BRANCH || 'kvrn-cp60-source-integration'
export const DRAFT = process.env.DEV_STUDIO_DRAFT_BRANCH || 'kvrn-studio-draft'
export const WORKFLOW = 'kvrn-developer-studio.yml'
const token = () => process.env.DEV_STUDIO_GITHUB_TOKEN || ''
export const studioConfigured = () => Boolean(token() && /^[\w.-]+\/[\w.-]+$/.test(REPO))
export const previewUrl = () => process.env.DEV_STUDIO_PREVIEW_URL || ''

// This is a source editor, not an unrestricted server-side execution service.
// Backend, payment, auth, secrets, actions, workflows, migrations and build scripts
// are deliberately excluded from the browser editing surface.
export function editableFile(path: string): boolean {
  if (typeof path !== 'string' || path.length > 240 || path.includes('..') || path.includes('\\') || path.includes('//')) return false
  if (!/^kvrn\/(app|components)\/[a-zA-Z0-9_./\[\]()-]+\.(tsx|css)$/.test(path)) return false
  if (/(?:^|\/)(?:api|_middleware|middleware|\.next|node_modules|__tests__)(?:\/|\.)/.test(path)) return false
  return true
}

export type GitHubFile = { path: string; sha: string; content: string; size: number }
export class StudioError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}

export async function github<T = any>(endpoint: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  if (!studioConfigured()) throw new StudioError('Developer Studio is not connected to GitHub yet.', 503)
  const res = await fetch(`https://api.github.com/repos/${REPO}/${endpoint}`, {
    method: init.method || 'GET',
    headers: {
      'Authorization': `Bearer ${token()}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'KVRN-Developer-Studio',
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    cache: 'no-store',
  })
  if (res.status === 204) return {} as T
  if (!res.ok) {
    // Never return GitHub's raw error body (it can include internal URLs).
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
export async function ensureDraft(): Promise<void> {
  try { await branchSha(DRAFT); return } catch (err) {
    if (!(err instanceof StudioError) || err.status !== 404) throw err
  }
  const sha = await branchSha(RELEASE)
  await github('git/refs', { method: 'POST', body: { ref: `refs/heads/${DRAFT}`, sha } })
}
export async function getFile(path: string, branch: string): Promise<GitHubFile> {
  if (!editableFile(path)) throw new StudioError('Only approved UI source files can be edited from the website.', 400)
  const data = await github<{ type: string; sha: string; content: string; encoding: string; size: number }>(
    `contents/${path}?ref=${encodeURIComponent(branch)}`,
  )
  if (data.type !== 'file' || data.encoding !== 'base64' || data.size > 45_000) throw new StudioError('This file cannot be edited in the browser.', 413)
  return { path, sha: data.sha, size: data.size, content: Buffer.from(data.content.replace(/\s/g, ''), 'base64').toString('utf8') }
}
export async function listFiles(): Promise<string[]> {
  const sha = await branchSha(DRAFT)
  const commit = await github<{ tree: { sha: string } }>(`git/commits/${sha}`)
  const tree = await github<{ tree: { path: string; type: string; size?: number }[]; truncated?: boolean }>(`git/trees/${commit.tree.sha}?recursive=1`)
  if (tree.truncated) throw new StudioError('Repository tree was truncated; file list is incomplete.', 503)
  return tree.tree.filter(item => item.type === 'blob' && (item.size ?? 0) < 45_000 && editableFile(item.path)).map(item => item.path).sort()
}
export async function workflowRuns(): Promise<Array<{ id: number; name: string; display_title: string; status: string; conclusion: string | null; html_url: string; head_sha: string; created_at: string }>> {
  const data = await github<{ workflow_runs: any[] }>(`actions/workflows/${WORKFLOW}/runs?per_page=40`)
  return data.workflow_runs.map(run => ({ id: run.id, name: run.name, display_title: run.display_title,
    status: run.status, conclusion: run.conclusion, html_url: run.html_url, head_sha: run.head_sha, created_at: run.created_at }))
}
/** Make a fast-forward, no-content commit to trigger a preview workflow on draft push. */
export async function requestPreview(): Promise<string> {
  const sha = await branchSha(DRAFT)
  const original = await github<{ tree: { sha: string } }>(`git/commits/${sha}`)
  const commit = await github<{ sha: string }>('git/commits', { method: 'POST', body: {
    message: 'Developer Studio: preview requested', tree: original.tree.sha, parents: [sha],
  } })
  await github(`git/refs/heads/${DRAFT}`, { method: 'PATCH', body: { sha: commit.sha, force: false } })
  return commit.sha
}
