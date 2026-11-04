import crypto from 'node:crypto';
import fs from 'node:fs';
import { db } from './db.js';

// Users live in the database with a salted scrypt hash; the first run creates admin / admin.
db.exec('CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL)');
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
export function setPassword(username, pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO users (username,salt,hash) VALUES (?,?,?) ON CONFLICT(username) DO UPDATE SET salt=excluded.salt, hash=excluded.hash')
    .run(username, salt, hashPw(pw, salt));
}
if (!db.prepare('SELECT COUNT(*) n FROM users').get().n) setPassword('admin', 'admin');

// Session cookie = "user.expiry.signature"; the signing secret is kept in data/ so logins survive a restart.
const secretFile = 'data/session.key';
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'));
const SECRET = fs.readFileSync(secretFile, 'utf8');
const DAYS = 7;
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
const makeToken = user => { const s = `${encodeURIComponent(user)}.${Date.now() + DAYS * 864e5}`; return `${s}.${sign(s)}`; };
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
function userOf(req) {
  const m = /(?:^|;\s*)session=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const [user, exp, sig] = m[1].split('.');
  if (!sig || !same(sig, sign(`${user}.${exp}`)) || +exp < Date.now()) return null;
  return decodeURIComponent(user);
}

// Slow down password guessing: 5 wrong tries from one address locks it out for a minute.
const fails = new Map();
const locked = ip => (fails.get(ip)?.until || 0) > Date.now();
function failed(ip) {
  const f = fails.get(ip) || { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= 5) { f.until = Date.now() + 60000; f.n = 0; }
  fails.set(ip, f);
}

export function mountAuth(app) {
  app.set('trust proxy', true);
  const cookie = (req, value, maxAge) =>
    `session=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${req.secure ? '; Secure' : ''}`;

  app.post('/api/login', (req, res) => {
    if (locked(req.ip)) return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
    const { username = '', password = '' } = req.body || {};
    const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(username).trim());
    const ok = u && same(u.hash, hashPw(String(password), u.salt));
    if (!ok) { failed(req.ip); return res.status(401).json({ error: 'Wrong username or password' }); }
    fails.delete(req.ip);
    res.setHeader('Set-Cookie', cookie(req, makeToken(u.username), DAYS * 86400));
    res.json({ user: u.username });
  });
  app.post('/api/logout', (req, res) => {
    res.setHeader('Set-Cookie', cookie(req, '', 0));
    res.json({ ok: true });
  });
  app.get('/api/me', (req, res) => {
    const user = userOf(req);
    user ? res.json({ user }) : res.status(401).json({ error: 'Not logged in' });
  });
  // everything else under /api needs a valid session
  app.use('/api', (req, res, next) => (userOf(req) ? next() : res.status(401).json({ error: 'Please log in' })));
}
