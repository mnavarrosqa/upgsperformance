# App review – bugs and improvements

Summary of the full app review and changes applied.

---

## Bugs fixed

### 1. History pagination showed wrong/empty pages
- **Issue:** `/scans` fetches only the most recent 500 scans, then groups them. `totalPages` was computed from the full DB group count, so users could see “Page 50 of 83” but the list only had data for ~41 pages (250 groups ÷ 6 per page).
- **Fix:** Pagination is now capped to the data actually loaded: `totalPages` and `currentPage` are based on `groupsAvailable` (groups from the fetched scans), so page links never point to empty results.

### 2. Session cookie not secure in production
- **Issue:** Session cookie had `secure: false`, so in production over HTTPS the cookie could be sent insecurely if the app was misconfigured.
- **Fix:** `secure` is set to `process.env.NODE_ENV === 'production'` so cookies are HTTPS-only in production.

---

## Improvements made

- **Copy:** “All scans” links in report detail and trends nav are now “Scan history” to match the History page title and header nav.

---

## What was checked (no issues found)

- **Auth:** `requireAuth` and `redirectIfAuthenticated` used correctly; login/register/settings and session handling are consistent.
- **DB:** Parameterized queries; LIKE search uses `escapeLike()`; JSON parse wrapped in try/catch; user-scoped access (e.g. `getScanByIdAndUserId`).
- **Scans:** URL validation (`isValidUrl`), max lengths, batch delete and single delete respect `userId`; screenshot paths validated with `isSafeScreenshotPath()`; no path traversal.
- **Views:** EJS escapes output (`<%= %>`); `linkifyDescription` escapes before linkifying; no raw user input in HTML.
- **Config:** `CHROME_PATH` (and optional `SESSION_SECRET`, `DB_PATH`, `PORT`) documented in `.env.example` and README.
- **Dashboard live search:** Table rows fetched via `/scans/table-rows`, partials and event delegation (rescan, delete, bulk) are consistent.

---

## Implemented in follow-up (continue)

- **Session secret in production:** App now exits on startup with a clear error if `NODE_ENV=production` and `SESSION_SECRET` is still the default.
- **Rate limiting:** `express-rate-limit` added: 10 requests per 15 min for POST `/login` and POST `/register`; 20 per 15 min for POST `/scans`.
- **CSRF protection:** Session-based CSRF token; `ensureCsrfToken` on form pages, `validateCsrf` on all state-changing POSTs. Hidden `_csrf` in all forms; bulk-delete and rescan fetch requests include the token (from `<meta name="csrf-token">`). Logout form and all scan/auth forms protected.

---

## Optional / future improvements

1. **History beyond 500 scans**  
   History only loads the most recent 500 scans (then grouped). Users with more see correct pagination up to that window. For true “all history” you’d need either a higher fetch limit, cursor-based loading, or group-aware DB pagination.

2. **Trust proxy**  
   `app.set('trust proxy', 1)` is set; ensure the reverse proxy (if any) sends the correct `X-Forwarded-*` headers so `req.protocol` and `req.get('host')` are correct for redirects and links.

3. **Report tab keyboard support**  
   Report detail device tabs could support arrow-key navigation for accessibility.

4. **Trends URL encoding**  
   Trends use `encodeURIComponent(u)` in option values and the API uses the raw `url` query; decoding is consistent. No change needed unless you add more client-side URL handling.

---

## Files changed in this review

- `src/routes/scans.js` – history pagination capped to loaded data.
- `src/index.js` – session cookie `secure: true` when `NODE_ENV === 'production'`; production session-secret check on startup.
- `views/report-detail.ejs` – “All scans” → “Scan history” (nav and buttons); CSRF hidden inputs and rescan fetch body.
- `views/trends.ejs` – “All scans” → “Scan history” in nav.
- `REVIEW.md` – this file.

**Follow-up (continue):** `src/index.js` (session secret check), `src/routes/auth.js` (rate limit, CSRF), `src/routes/scans.js` (rate limit, CSRF), `src/middleware/csrf.js` (new), `views/partials/header.ejs` (csrf meta + logout form), `views/login.ejs`, `views/register.ejs`, `views/settings.ejs`, `views/dashboard.ejs`, `views/scans-list.ejs`, `views/partials/dashboard-scan-row.ejs` (CSRF inputs and JS bulk-delete/rescan). `package.json` – added `express-rate-limit`.
