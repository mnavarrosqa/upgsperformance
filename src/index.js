import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import connectSqlite3 from 'connect-sqlite3';
import { randomBytes } from 'crypto';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync } from 'fs';
import config from './config.js';
import authRoutes from './routes/auth.js';
import scanRoutes from './routes/scans.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

if (process.env.NODE_ENV === 'production' && config.sessionSecret === 'change-me-in-production') {
  console.error('Fatal: SESSION_SECRET must be set in production. Set SESSION_SECRET in .env (e.g. openssl rand -hex 32).');
  process.exit(1);
}

const app = express();

app.set('trust proxy', 1);

const dbDir = resolve(__dirname, '..', 'data');
if (!existsSync(dbDir)) {
  mkdirSync(dbDir, { recursive: true });
}

const sessionStore = config.useMemorySession
  ? undefined
  : new (connectSqlite3(session))({
      dir: dbDir,
      db: 'sessions.db',
      createDirIfNotExists: true,
    });

app.set('view engine', 'ejs');
app.set('views', join(__dirname, '..', 'views'));

app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(
  session({
    store: sessionStore,
    secret: config.sessionSecret,
    name: 'upgs.sid',
    resave: false,
    saveUninitialized: true,
    cookie: {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== '0',
      path: '/',
    },
  })
);

app.use((req, res, next) => {
  if (req.session && !req.session.csrfToken) {
    req.session.csrfToken = randomBytes(32).toString('hex');
  }
  res.locals.email = req.session?.email ?? null;
  res.locals.userName = req.session?.name || req.session?.email || null;
  res.locals.title = 'UPGS Perf';
  res.locals.csrfToken = req.session?.csrfToken ?? '';
  next();
});

app.use(express.static(join(__dirname, '..', 'public')));

app.get('/.well-known/appspecific/com.chrome.devtools.json', (req, res) => {
  res.status(204).end();
});

app.get('/', (req, res) => {
  if (req.session && req.session.userId) {
    return res.redirect('/dashboard');
  }
  const guestScansUsed = typeof req.session?.guestScansCount === 'number' ? req.session.guestScansCount : 0;
  const guestError = req.query.guest_error;
  res.render('landing', {
    title: 'UPGS Perf – Lighthouse performance, simplified',
    guestScansUsed,
    guestScansLimit: 2,
    guestError: guestError || null,
  });
});

app.use(authRoutes);
app.use(scanRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Something went wrong. Check the server logs.');
});

app.listen(config.port, () => {
  console.log(`UPGS Perf listening on port ${config.port} (session store: ${config.useMemorySession ? 'memory' : 'sqlite'})`);
});
