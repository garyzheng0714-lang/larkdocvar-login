## Initial
None yet.

## Task 3 fix: Feishu OAuth response parsing was fragile

**Problem**: The `/api/auth/feishu/callback` handler assumed the `/authen/v2/oauth/token` response had `access_token` directly on `tokenResponse.data` (axios body). Research of real-world implementations (`labring/tentix`, `lobehub`, `cso1z/Feishu-MCP`) and the existing `feishu.ts` `FeishuEnvelope<T>` pattern revealed:
- v2 token endpoint returns **flat** format: `{ code, access_token, expires_in, ... }` (tokens at top level alongside `code`)
- v1 user_info endpoint returns **envelope** format: `{ code, msg, data: { open_id, name, ... } }`
- Both formats include a `code` field (0 = success) but token placement differs

The original code would silently produce `undefined` values for `access_token`/`expires_in` if the response shape changed, creating invalid sessions with no error feedback.

**Fix applied**:
1. Removed generic type params from `axios.post`/`axios.get` — parse response as `Record<string, any>` for safe inspection
2. Check `code !== 0` on both responses and return descriptive 500 errors with Feishu error codes
3. Extract token fields with fallback: try flat (`body.access_token`) then envelope (`body.data.access_token`)
4. Extract user info with fallback: try envelope (`body.data`) then flat (`body`)
5. Validate `access_token` exists before proceeding — return 500 if missing
6. Validate `open_id` exists before persisting — return 500 if missing
7. Handle `refresh_expires_in` vs `refresh_token_expires_in` field name variation
8. Fallback `expires_in` to 7200s (2h) if 0/missing instead of creating instant-expiry session
