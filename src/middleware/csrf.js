import { randomBytes } from 'crypto';

/** Ensure session has a CSRF token (call before rendering forms). */
export function ensureCsrfToken(req, res, next) {
  if (req.session && !req.session.csrfToken) {
    req.session.csrfToken = randomBytes(32).toString('hex');
  }
  next();
}

/** Reject POST/PUT/PATCH/DELETE if CSRF token is missing or invalid. */
export function validateCsrf(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return next();
  }
  const token = req.body && typeof req.body._csrf === 'string' ? req.body._csrf.trim() : '';
  if (!token || token !== (req.session && req.session.csrfToken)) {
    return res.status(403).send('Invalid or missing CSRF token');
  }
  next();
}
