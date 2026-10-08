// lib/site-settings.ts — small keyed JSON settings with optimistic revision checks.
// Used for global SEO defaults, enabled locales + per-locale default currency, abandoned-
// checkout configuration, affiliate program settings, etc. Values are plain JSON; callers
// validate the shape (see the `validate` option) before saving.

type Sql = any

export class SettingsStaleError extends Error {
  readonly code = 'stale'
  constructor(key: string) { super(`Setting "${key}" was changed by someone else.`) }
}

export const SETTING_KEY_RE = /^[a-z0-9_.-]{1,80}$/

export async function getSetting<T = unknown>(sql: Sql, key: string, fallback: T): Promise<{ value: T; revision: number }> {
  if (!SETTING_KEY_RE.test(key)) throw new Error('Invalid setting key.')
  const rows = await sql`SELECT value, revision FROM site_settings WHERE key = ${key}` as any[]
  if (!rows[0]) return { value: fallback, revision: 0 }
  return { value: rows[0].value as T, revision: rows[0].revision }
}

/**
 * Save a setting. expectedRevision 0 = "I expect it not to exist yet". A mismatch throws
 * SettingsStaleError. Also writes admin_audit_logs in the same statement.
 */
export async function putSetting(
  sql: Sql, key: string, value: unknown, expectedRevision: number, actor: string,
): Promise<{ revision: number }> {
  if (!SETTING_KEY_RE.test(key)) throw new Error('Invalid setting key.')
  const json = JSON.stringify(value)
  if (json === undefined || json.length > 200_000) throw new Error('Setting value is invalid or too large.')

  const rows = await sql`
    WITH upd AS (
      UPDATE site_settings
         SET value = ${json}::jsonb, revision = revision + 1, updated_by = ${actor}
       WHERE key = ${key} AND revision = ${expectedRevision}
       RETURNING revision
    ), ins AS (
      INSERT INTO site_settings (key, value, revision, updated_by)
      SELECT ${key}, ${json}::jsonb, 1, ${actor}
       WHERE ${expectedRevision} = 0
         AND NOT EXISTS (SELECT 1 FROM site_settings WHERE key = ${key})
      ON CONFLICT (key) DO NOTHING
      RETURNING revision
    ), r AS (
      SELECT revision FROM upd UNION ALL SELECT revision FROM ins
    ), aud AS (
      INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
      SELECT ${actor}, 'settings.update', 'site_settings', ${key}, jsonb_build_object('revision', revision)
        FROM r
    )
    SELECT revision FROM r
  ` as any[]
  if (!rows[0]) throw new SettingsStaleError(key)
  return { revision: rows[0].revision }
}
