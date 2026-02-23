## Initial
None yet.

## Task 2: SQLite + better-sqlite3 persistence layer

- **better-sqlite3** is synchronous — no async/await needed for DB calls, which simplifies the server code and avoids callback hell in Express route handlers.
- The project uses `"module": "ESNext"` with `"moduleResolution": "Bundler"` — `better-sqlite3` default export works fine with `import Database from 'better-sqlite3'` under these settings.
- Schema uses `datetime('now')` SQLite function for timestamps (ISO 8601 text format) — keeps things portable and human-readable.
- `RETURNING *` clause works in SQLite ≥ 3.35.0 (better-sqlite3 bundles a recent enough version) — avoids a separate SELECT after INSERT/UPDATE.
- Database singleton pattern with lazy `initDatabase()` — safe to call from multiple route handlers; first call bootstraps schema, subsequent calls return cached instance.
- `journal_mode = WAL` set for concurrent read performance (important when Express handles parallel requests).
- `foreign_keys = ON` must be set per-connection in SQLite (not persisted) — done in `initDatabase`.
- DB file defaults to `data/app.db` relative to project root — keeps it out of `server/src/` and easy to `.gitignore`.
- Unique composite index on `(open_id, config_name)` in `saved_configs` enables upsert-by-name semantics for `saveOrUpdateConfig`.
- All 8 exported helpers: `initDatabase`, `upsertUser`, `upsertSession`, `getSessionByToken`, `listSavedConfigs`, `getSavedConfig`, `saveOrUpdateConfig`, `deleteSavedConfig`.
- Types exported: `UserRow`, `AuthSessionRow`, `SavedConfigRow`.

## Task 3: Feishu OAuth2 backend routes

 **No new dependencies** needed for auth flow — `axios` (already present) handles HTTP calls to Feishu APIs, `node:crypto` provides `randomBytes` for session tokens and CSRF state.
 **Cookie parsing without cookie-parser** — manual `parseCookies()` helper splits `Cookie` header on `;`, then on first `=` per pair. Avoids adding a new dependency for a trivial operation.
 Express 5 has built-in `res.cookie()` and `res.clearCookie()` — no middleware needed for setting cookies, only for reading them.
 **Feishu OAuth2 v2 token endpoint** (`/authen/v2/oauth/token`) uses `client_id`/`client_secret` fields (not `app_id`/`app_secret`) — different from the v1 app_access_token endpoint used elsewhere in the codebase.
 **Feishu user_info endpoint** (`/authen/v1/user_info`) requires a *user* access token (from OAuth code exchange), not an *app* access token — uses `Authorization: Bearer <user_token>` header.
 Session token is 32 random bytes (hex-encoded, 64 chars) — cryptographically strong, no collision risk.
 `SESSION_MAX_AGE_SECONDS` defaults to 604800 (7 days); Express `maxAge` option expects milliseconds, so multiply by 1000.
 Cookie options: `httpOnly: true` (no JS access), `sameSite: 'lax'` (CSRF protection while allowing top-level navigations), `secure` controlled by env (false in dev, true in prod behind HTTPS).
 `getUserByOpenId` added to `storage.ts` — needed by `/api/auth/session` to return user profile alongside session validation.
 All 4 routes are backward-compatible — existing `/api/health`, `/api/template/*`, `/api/users/*`, `/api/documents/*` routes unchanged.
 Auth routes placed before existing API routes in the file for logical grouping, but Express route order only matters for overlapping patterns (these don't overlap).
 `state` parameter in authorize URL uses `crypto.randomBytes(16).toString('hex')` — provides CSRF protection for the OAuth flow.

## Task 4: Save/load configuration API endpoints

 **No new storage helpers needed** — Task 2 already exported `listSavedConfigs`, `getSavedConfig`, `saveOrUpdateConfig`, `deleteSavedConfig` from `storage.ts`. Only needed to import them in `index.ts`.
 **Shared `resolveCurrentUser()` helper** extracts the cookie→session→user lookup pattern used by `/api/auth/session` into a reusable function. Returns `{ openId }` or `null` for 401.
 **Zod v4 `z.record(z.string(), z.unknown())`** works for arbitrary JSON payload validation — allows any nested structure while ensuring the top level is an object with string keys.
 **Upsert semantics via `configName`** — `POST /api/configs` uses `saveOrUpdateConfig` which leverages the `(open_id, config_name)` unique index for INSERT…ON CONFLICT DO UPDATE. Frontend sends `configName` and gets back the upserted row.
 **List endpoint omits `payload`** for bandwidth — `GET /api/configs` returns only `id`, `configName`, `createdAt`, `updatedAt`. Full payload is fetched via `GET /api/configs/:id`.
 **`payload_json` parsed with try/catch** — `GET /api/configs/:id` wraps `JSON.parse` in try/catch, falling back to `{}` if the stored JSON is somehow corrupt. Defensive but cheap.
 **Config ID validation** — `Number(request.params.id)` with `Number.isFinite` + `> 0` check catches NaN, Infinity, negative, and zero values before hitting the DB.
 **All 4 config endpoints require auth** — consistent 401 response `{ ok: false, error: '未登录或会话已过期。' }` when session cookie is missing/invalid/expired.
 **No new dependencies added** — reuses existing `zod`, `express`, and `storage.ts` exports.
 **Existing endpoints unchanged** — config routes placed between auth routes and health/template/users/documents routes; no overlapping patterns.

## Task 5: Frontend auth UI and session check

 **Auth state types** — `AuthUser` (id, name, email?, avatar?) and `AuthSession` (user, isAuthenticated) provide type-safe auth state management.
 **Three auth states** — `authLoading` (initial check), `authSession` (user data + flag), `authError` (error message) cover all UI scenarios.
 **Session check on mount** — `useEffect` with empty deps runs once, calls `GET /api/auth/session`, handles 3 cases: ok+user, ok+no-user, error. Sets `authLoading: false` in finally block.
 **Login button** — simple `window.location.href = "/api/auth/feishu/login"` redirect; no state management needed since page navigates away.
 **Logout handler** — `POST /api/auth/logout` clears server-side session, then resets `authSession` and `authError` locally. Wrapped in `useCallback` for stable reference.
 **Compact auth bar** — placed in header next to title; shows loading spinner, user name + logout button (if authenticated), or login button (if not). Error indicator (⚠️) shown if `authError` is set.
 **No new dependencies** — uses existing `fetch`, `useEffect`, `useCallback`, `useState` from React.
 **Existing features unchanged** — all template/field/generation logic preserved; auth bar is purely additive UI.
 **TypeScript clean** — `npx tsc --noEmit` passes; `npm run build` succeeds with no errors (only chunk size warning, pre-existing).
 **Auth bar styling** — uses existing Tailwind classes and color scheme (blue for buttons, gray for loading, red for errors) consistent with app design.

## Task 6: Frontend saved config list/load/delete

- Added frontend config management based on backend `/api/configs` endpoints with no extra dependencies.
- New payload snapshot includes: `templateUrl`, `bindings`, `linkConfigs`, `attachmentConfigs`, `outputFieldId`, `titleFieldId`, `permissionMode`, `ownerSelected`, `collaborators`.
- Added compact `配置草稿` section under 模板文档 block:
  - logged out: hint text only
  - logged in: save input + save button + list with load/delete actions
- Added action states for better UX: `savedConfigsLoading`, `configActionLoading`, `configError`.
- Added auth-coupled refresh: when session becomes authenticated, auto-fetch saved config list.
- Load config flow safely applies payload back into current App states and preserves existing generation workflow.
