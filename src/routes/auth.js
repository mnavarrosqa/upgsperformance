import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcrypt';
import { unlink } from 'fs/promises';
import { join, dirname } from 'path';
import config from '../config.js';
import * as db from '../db/index.js';
import { requireAuth, redirectIfAuthenticated } from '../middleware/auth.js';
import { ensureCsrfToken, validateCsrf } from '../middleware/csrf.js';

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many attempts. Please try again in 15 minutes.',
  standardHeaders: true,
  legacyHeaders: false,
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many login attempts. Please try again in 15 minutes.',
  standardHeaders: true,
  legacyHeaders: false,
});

const SCREENSHOTS_DIR = join(dirname(config.dbPath), 'screenshots');

function isSafeScreenshotPath(filename) {
  if (typeof filename !== 'string' || filename.length === 0) return false;
  return /^\d+\.(png|jpg|jpeg|webp)$/i.test(filename);
}

const SALT_ROUNDS = 12;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 256;
const MAX_EMAIL_LENGTH = 254;
const MAX_NAME_LENGTH = 200;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Short delay to reduce timing side-channel on login (user-not-found vs wrong-password). */
const LOGIN_TIMING_MS = 200;
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

router.get('/login', ensureCsrfToken, redirectIfAuthenticated, (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.locals.csrfToken = req.session.csrfToken;
  const sessionLost = req.query.session_lost === '1';
  req.session.save((err) => {
    if (err) return next(err);
    res.render('login', {
      title: 'Login',
      error: sessionLost ? 'Your session was not saved. Please log in again. If this keeps happening, try another browser or use the same tab.' : null,
    });
  });
});

// Login/register POST are not CSRF-protected so login works with SQLite session store in all environments (see README SESSION_STORE).
router.post('/login', redirectIfAuthenticated, loginLimiter, async (req, res) => {
  const rawEmail = typeof req.body?.email === 'string' ? req.body.email.trim().slice(0, MAX_EMAIL_LENGTH) : '';
  const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, MAX_PASSWORD_LENGTH) : '';
  if (!rawEmail || !password) {
    return res.render('login', { title: 'Login', error: 'Email and password are required' });
  }
  if (!EMAIL_REGEX.test(rawEmail)) {
    return res.render('login', { title: 'Login', error: 'Please enter a valid email address' });
  }
  const email = rawEmail.toLowerCase();
  const user = db.findUserByEmail(email);
  if (!user) {
    await delay(LOGIN_TIMING_MS);
    return res.render('login', { title: 'Login', error: 'Invalid email or password' });
  }
  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    return res.render('login', { title: 'Login', error: 'Invalid email or password' });
  }
  req.session.regenerate((err) => {
    if (err) {
      console.error('Login session regenerate error:', err);
      return res.status(500).render('login', { title: 'Login', error: 'Session error. Try again.' });
    }
    req.session.userId = user.id;
    req.session.email = user.email;
    req.session.name = user.name || null;
    req.session.save((saveErr) => {
      if (saveErr) {
        console.error('Login session save error:', saveErr);
        return res.status(500).render('login', { title: 'Login', error: 'Session error. Try again.' });
      }
      res.redirect('/dashboard');
    });
  });
});

router.get('/register', ensureCsrfToken, redirectIfAuthenticated, (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.locals.csrfToken = req.session.csrfToken;
  const message = req.query.deleted === '1' ? 'Your account has been deleted.' : null;
  req.session.save((err) => {
    if (err) return next(err);
    res.render('register', { title: 'Register', error: null, message });
  });
});

router.post('/register', redirectIfAuthenticated, authLimiter, async (req, res) => {
  const rawEmail = typeof req.body?.email === 'string' ? req.body.email.trim().slice(0, MAX_EMAIL_LENGTH) : '';
  const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, MAX_PASSWORD_LENGTH) : '';
  const confirmPassword = typeof req.body?.confirm_password === 'string' ? req.body.confirm_password.slice(0, MAX_PASSWORD_LENGTH) : '';
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, MAX_NAME_LENGTH) : '';
  if (!rawEmail || !password) {
    return res.render('register', { title: 'Register', error: 'Email and password are required' });
  }
  if (!EMAIL_REGEX.test(rawEmail)) {
    return res.render('register', { title: 'Register', error: 'Please enter a valid email address' });
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.render('register', { title: 'Register', error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  }
  if (password !== confirmPassword) {
    return res.render('register', { title: 'Register', error: 'Password and confirmation do not match' });
  }
  const email = rawEmail.toLowerCase();
  if (db.findUserByEmail(email)) {
    return res.render('register', { title: 'Register', error: 'An account with this email already exists' });
  }
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  db.createUser(email, passwordHash, name || null);
  const user = db.findUserByEmail(email);
  req.session.regenerate((err) => {
    if (err) {
      console.error('Register session regenerate error:', err);
      return res.status(500).render('register', { title: 'Register', error: 'Session error. Try again.' });
    }
    req.session.userId = user.id;
    req.session.email = user.email;
    req.session.name = user.name || null;
    req.session.save((saveErr) => {
      if (saveErr) {
        console.error('Register session save error:', saveErr);
        return res.status(500).render('register', { title: 'Register', error: 'Session error. Try again.' });
      }
      res.redirect('/dashboard');
    });
  });
});

router.get('/settings', requireAuth, ensureCsrfToken, (req, res, next) => {
  const user = db.findUserById(req.session.userId);
  if (!user) {
    return req.session.destroy((err) => {
      res.redirect('/login');
    });
  }
  const errorParam = req.query.error === 'delete_password'
    ? 'Enter your password to delete your account.'
    : null;
  res.render('settings', {
    title: 'Settings',
    email: req.session.email,
    user: { name: user.name || '', email: user.email },
    success: req.query.updated === '1',
    error: errorParam,
  });
});

router.post('/settings', requireAuth, validateCsrf, async (req, res) => {
  const user = db.findUserByIdWithPassword(req.session.userId);
  if (!user) {
    return req.session.destroy((err) => {
      res.redirect('/login');
    });
  }
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, MAX_NAME_LENGTH) : '';
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().slice(0, MAX_EMAIL_LENGTH) : '';
  const currentPassword = typeof req.body?.current_password === 'string' ? req.body.current_password : '';
  const newPassword = typeof req.body?.new_password === 'string' ? req.body.new_password : '';
  const confirmPassword = typeof req.body?.confirm_password === 'string' ? req.body.confirm_password : '';

  const updates = {};
  let error = null;

  if (!email) {
    error = 'Email is required';
  } else if (!EMAIL_REGEX.test(email)) {
    error = 'Please enter a valid email address';
  } else {
    const normalizedEmail = email.toLowerCase();
    if (normalizedEmail !== user.email) {
      const existing = db.findUserByEmail(normalizedEmail);
      if (existing && existing.id !== user.id) {
        error = 'An account with this email already exists';
      } else {
        const match = await bcrypt.compare(currentPassword, user.password_hash);
        if (!match) {
          error = 'Current password is required to change your email';
        } else {
          updates.email = normalizedEmail;
        }
      }
    }
  }

  const changingPassword = newPassword.length > 0;
  if (changingPassword) {
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      error = error || `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
    } else if (newPassword !== confirmPassword) {
      error = error || 'New password and confirmation do not match';
    } else {
      const match = await bcrypt.compare(currentPassword, user.password_hash);
      if (!match) {
        error = error || 'Current password is incorrect';
      } else {
        updates.password_hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
      }
    }
  }

  if (error) {
    return res.render('settings', {
      title: 'Settings',
      email: req.session.email,
      user: { name: name || user.name || '', email: email || user.email },
      success: false,
      error,
    });
  }

  updates.name = name || null;
  if (Object.keys(updates).length > 0) {
    db.updateUser(user.id, updates);
  }
  if (updates.email) {
    req.session.email = updates.email;
  }
  if (updates.name !== undefined) {
    req.session.name = updates.name;
  }
  req.session.save((err) => {
    if (err) {
      console.error('Settings session save error:', err);
      return res.render('settings', {
        title: 'Settings',
        email: req.session.email,
        user: { name: updates.name !== undefined ? updates.name : user.name || '', email: updates.email || user.email },
        success: false,
        error: 'Settings saved but session update failed. Please log in again.',
      });
    }
    res.redirect('/settings?updated=1');
  });
});

router.get('/account/export', requireAuth, (req, res) => {
  const user = db.findUserById(req.session.userId);
  if (!user) {
    return req.session.destroy((err) => {
      res.redirect('/login');
    });
  }
  const scans = db.getScansForUserExport(user.id);
  const exportData = {
    exported_at: new Date().toISOString(),
    user: {
      email: user.email,
      name: user.name || null,
      created_at: user.created_at,
    },
    scans,
  };
  const filename = `upgs-perf-data-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(JSON.stringify(exportData, null, 2));
});

router.post('/account/delete', requireAuth, validateCsrf, async (req, res) => {
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const user = db.findUserByIdWithPassword(req.session.userId);
  if (!user) {
    return req.session.destroy((err) => {
      res.redirect('/login');
    });
  }
  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    return res.redirect('/settings?error=delete_password');
  }
  const screenshots = db.getScanScreenshotPathsByUserId(user.id);
  for (const row of screenshots) {
    if (row.screenshot_path && isSafeScreenshotPath(row.screenshot_path)) {
      try {
        await unlink(join(SCREENSHOTS_DIR, row.screenshot_path));
      } catch (e) {
        if (e.code !== 'ENOENT') console.error('Account delete: screenshot unlink failed', e);
      }
    }
  }
  db.deleteUser(user.id);
  req.session.destroy((err) => {
    if (err) console.error('Account delete: session destroy failed', err);
    res.redirect('/register?deleted=1');
  });
});

router.post('/logout', validateCsrf, (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).send('Logout failed');
    res.redirect('/login');
  });
});

export default router;
