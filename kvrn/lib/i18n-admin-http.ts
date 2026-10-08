// Lazily created service for /api/admin/content/i18n (kept out of content-http.ts so that shared file is untouched).
import { sql } from './db'
import { createI18nAdminService, type I18nAdminService } from './i18n-admin-service'

let _svc: I18nAdminService | null = null
export const i18nSvc = () => (_svc ??= createI18nAdminService(sql))
