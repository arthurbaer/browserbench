import express from 'express';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import nodemailer from 'nodemailer';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const { APP_SECRET, PORT = 3000, DB_PATH = './data/bench.db', COOKIE_SECURE = 'true', BASE_URL = 'http://localhost:3000', ADMIN_EMAIL = '', SMTP_HOST, SMTP_PORT = 587, SMTP_USER, SMTP_PASS, MAIL_FROM = 'BrowserBench <noreply@localhost>' } = process.env;
if (!APP_SECRET || APP_SECRET.length < 32) { console.error('APP_SECRET (mind. 32 Zeichen) fehlt'); process.exit(1); }
const KEY = crypto.createHash('sha256').update(APP_SECRET).digest();
authenticator.options = { window: 1 };

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE NOT NULL, pw_hash TEXT NOT NULL, totp_secret TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS recovery(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, hash TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, stage TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS scores(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, cpu_model TEXT NOT NULL, gpu_model TEXT NOT NULL, cpu_single REAL NOT NULL, cpu_multi REAL NOT NULL, gpu_score REAL NOT NULL, threads INTEGER, created_at INTEGER NOT NULL);
`);
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now()), 36e5).unref();
// Migration für bestehende Datenbanken
const has = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c);
for (const [n, d] of [['email', 'TEXT'], ['email_verified', 'INTEGER NOT NULL DEFAULT 0'], ['is_admin', 'INTEGER NOT NULL DEFAULT 0'], ['banned', 'INTEGER NOT NULL DEFAULT 0'], ['verify_hash', 'TEXT'], ['verify_expires', 'INTEGER']]) if (!has('users', n)) db.exec(`ALTER TABLE users ADD COLUMN ${n} ${d}`);
if (!has('scores', 'hidden')) db.exec('ALTER TABLE scores ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users(email COLLATE NOCASE); CREATE TABLE IF NOT EXISTS admin_log(id INTEGER PRIMARY KEY, admin_id INTEGER, action TEXT, target TEXT, created_at INTEGER)');

// ---- Mail ----
const mailer = SMTP_HOST ? nodemailer.createTransport({ host: SMTP_HOST, port: +SMTP_PORT, secure: +SMTP_PORT === 465, auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined }) : null;
async function sendVerification(u) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('UPDATE users SET verify_hash=?, verify_expires=? WHERE id=?').run(sha(token), Date.now() + 864e5, u.id);
  const link = `${BASE_URL}/verify?token=${token}`;
  if (!mailer) { console.log('[mail] SMTP nicht konfiguriert – Verifizierungslink für', u.email, link); return; }
  await mailer.sendMail({ from: MAIL_FROM, to: u.email, subject: 'BrowserBench: E-Mail-Adresse bestätigen', text: `Hallo ${u.username},\n\nbitte bestätige deine E-Mail-Adresse (24 Stunden gültig):\n${link}\n\nWenn du dich nicht registriert hast, ignoriere diese Mail.` });
}
const sendSafe = u => sendVerification(u).catch(e => console.error('Mail-Fehler:', e.message));
const promote = u => { if (u && u.email_verified && !u.is_admin && ADMIN_EMAIL && u.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase()) { db.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(u.id); u.is_admin = 1; } return u; };

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const enc = t => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', KEY, iv); const ct = Buffer.concat([c.update(t, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64'); };
const dec = b => { const buf = Buffer.from(b, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12)); d.setAuthTag(buf.subarray(12, 28)); return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'); };
const DUMMY = bcrypt.hashSync('dummy', 12);
const SESSION_MS = 7 * 864e5;
const pub = u => ({ id: u.id, username: u.username, email: u.email, verified: !!u.email_verified, admin: !!u.is_admin, totp: !!u.totp_enabled });
const totpOk = (u, code) => u.totp_secret && /^\d{6}$/.test(code) && authenticator.check(code, dec(u.totp_secret));

const tokenOf = req => (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('sid='))?.slice(4);
const getSession = req => { const t = tokenOf(req); return t ? db.prepare('SELECT * FROM sessions WHERE token=? AND expires>?').get(sha(t), Date.now()) : null; };
function startSession(res, uid, stage, ms) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(sha(token), uid, stage, Date.now() + ms);
  res.cookie('sid', token, { httpOnly: true, sameSite: 'strict', secure: COOKIE_SECURE === 'true', maxAge: ms, path: '/' });
}
const auth = (req, res, next) => {
  const s = getSession(req);
  if (!s || s.stage !== 'full') return res.status(401).json({ error: 'Nicht angemeldet' });
  req.sess = s; req.user = promote(db.prepare('SELECT * FROM users WHERE id=?').get(s.user_id));
  if (!req.user || req.user.banned) return res.status(401).json({ error: 'Nicht angemeldet' });
  next();
};

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(express.json({ limit: '10kb' }));
app.use('/api', (req, res, next) => (req.method !== 'GET' && req.get('x-requested-with') !== 'bench') ? res.status(403).json({ error: 'Ungültige Anfrage' }) : next());
const authLimit = rateLimit({ windowMs: 15 * 60e3, limit: 20, standardHeaders: true, message: { error: 'Zu viele Versuche, bitte später erneut' } });
const scoreLimit = rateLimit({ windowMs: 60e3, limit: 2, message: { error: 'Maximal 2 Ergebnisse pro Minute' } });

// ---- Auth ----
app.post('/api/register', authLimit, (req, res) => {
  const { username, password, email } = req.body || {};
  if (!/^[a-zA-Z0-9_.-]{3,24}$/.test(username || '')) return res.status(400).json({ error: 'Benutzername: 3–24 Zeichen (a-z, 0-9, _ . -)' });
  if (typeof email !== 'string' || email.length > 120 || !/^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ error: 'Bitte gültige E-Mail-Adresse angeben' });
  if (typeof password !== 'string' || password.length < 10 || password.length > 128) return res.status(400).json({ error: 'Passwort: 10–128 Zeichen' });
  try {
    const r = db.prepare('INSERT INTO users(username,email,pw_hash,created_at) VALUES(?,?,?,?)').run(username, email.trim().toLowerCase(), bcrypt.hashSync(password, 12), Date.now());
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid);
    sendSafe(u); startSession(res, u.id, 'full', SESSION_MS);
    res.json({ user: pub(u) });
  } catch { res.status(409).json({ error: 'Benutzername oder E-Mail bereits vergeben' }); }
});
app.post('/api/login', authLimit, (req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(username || ''));
  const ok = bcrypt.compareSync(String(password || ''), u ? u.pw_hash : DUMMY);
  if (!u || !ok) return res.status(401).json({ error: 'Ungültige Zugangsdaten' });
  if (u.banned) return res.status(403).json({ error: 'Konto gesperrt' });
  if (u.totp_enabled) { startSession(res, u.id, 'pending', 5 * 60e3); return res.json({ needs2fa: true }); }
  promote(u); startSession(res, u.id, 'full', SESSION_MS); res.json({ user: pub(u) });
});
app.post('/api/login/2fa', authLimit, (req, res) => {
  const s = getSession(req);
  if (!s || s.stage !== 'pending') return res.status(401).json({ error: 'Sitzung abgelaufen, bitte neu anmelden' });
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(s.user_id);
  const code = String(req.body?.code || '').replace(/\s/g, '');
  let ok = totpOk(u, code);
  if (!ok) ok = db.prepare('UPDATE recovery SET used=1 WHERE user_id=? AND hash=? AND used=0').run(u.id, sha(code.toLowerCase())).changes === 1;
  if (!ok) return res.status(401).json({ error: 'Code ungültig' });
  db.prepare('DELETE FROM sessions WHERE token=?').run(s.token);
  promote(u); startSession(res, u.id, 'full', SESSION_MS); res.json({ user: pub(u) });
});
app.post('/api/logout', (req, res) => { const s = getSession(req); if (s) db.prepare('DELETE FROM sessions WHERE token=?').run(s.token); res.clearCookie('sid'); res.json({ ok: true }); });

app.get('/api/me', auth, (req, res) => {
  const id = req.user.id;
  res.json({
    user: pub(req.user),
    avg: db.prepare('SELECT COUNT(*) n, AVG(cpu_single) single, AVG(cpu_multi) multi, AVG(gpu_score) gpu, MAX(cpu_single) bestSingle, MAX(cpu_multi) bestMulti, MAX(gpu_score) bestGpu FROM scores WHERE user_id=?').get(id),
    scores: db.prepare('SELECT * FROM scores WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(id),
  });
});
app.post('/api/password', auth, authLimit, (req, res) => {
  const { current, next } = req.body || {};
  if (!bcrypt.compareSync(String(current || ''), req.user.pw_hash)) return res.status(401).json({ error: 'Aktuelles Passwort falsch' });
  if (typeof next !== 'string' || next.length < 10 || next.length > 128) return res.status(400).json({ error: 'Neues Passwort: 10–128 Zeichen' });
  db.prepare('UPDATE users SET pw_hash=? WHERE id=?').run(bcrypt.hashSync(next, 12), req.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id=? AND token!=?').run(req.user.id, req.sess.token);
  res.json({ ok: true });
});
app.delete('/api/me', auth, authLimit, (req, res) => {
  if (!bcrypt.compareSync(String(req.body?.password || ''), req.user.pw_hash)) return res.status(401).json({ error: 'Passwort falsch' });
  db.prepare('DELETE FROM users WHERE id=?').run(req.user.id); res.clearCookie('sid'); res.json({ ok: true });
});

// ---- 2FA (TOTP) ----
app.post('/api/2fa/setup', auth, async (req, res) => {
  if (req.user.totp_enabled) return res.status(400).json({ error: '2FA ist bereits aktiv' });
  const secret = authenticator.generateSecret();
  db.prepare('UPDATE users SET totp_secret=? WHERE id=?').run(enc(secret), req.user.id);
  res.json({ secret, qr: await QRCode.toDataURL(authenticator.keyuri(req.user.username, 'BrowserBench', secret)) });
});
app.post('/api/2fa/enable', auth, authLimit, (req, res) => {
  const code = String(req.body?.code || '').replace(/\s/g, '');
  if (req.user.totp_enabled || !totpOk(req.user, code)) return res.status(400).json({ error: 'Code ungültig' });
  const codes = Array.from({ length: 8 }, () => crypto.randomBytes(5).toString('hex'));
  db.prepare('DELETE FROM recovery WHERE user_id=?').run(req.user.id);
  for (const c of codes) db.prepare('INSERT INTO recovery(user_id,hash) VALUES(?,?)').run(req.user.id, sha(c));
  db.prepare('UPDATE users SET totp_enabled=1 WHERE id=?').run(req.user.id);
  res.json({ recoveryCodes: codes });
});
app.post('/api/2fa/disable', auth, authLimit, (req, res) => {
  const { password, code } = req.body || {};
  if (!bcrypt.compareSync(String(password || ''), req.user.pw_hash) || !totpOk(req.user, String(code || '').replace(/\s/g, ''))) return res.status(401).json({ error: 'Passwort oder Code falsch' });
  db.prepare('UPDATE users SET totp_enabled=0, totp_secret=NULL WHERE id=?').run(req.user.id);
  db.prepare('DELETE FROM recovery WHERE user_id=?').run(req.user.id);
  res.json({ ok: true });
});

// ---- Scores ----
function cleanGpu(raw) {
  let s = String(raw || '').trim();
  const m = s.match(/^ANGLE \((.*)\)$/);
  if (m) { const p = m[1].split(/,\s+/); s = p.length >= 3 ? p.slice(1, -1).join(', ') : (p[1] || p[0]); }
  return s.replace(/\s*\(0x[0-9a-f]+\)/gi, '').replace(/\s+Direct3D.*$/i, '').replace(/^ANGLE Metal Renderer:\s*/i, '')
    .replace(/\/(PCIe|SSE2).*$/i, '').replace(/^Mesa\s+/i, '').replace(/\((R|TM)\)/gi, '').replace(/\s+/g, ' ').trim();
}
const num = v => { v = Number(v); if (!Number.isFinite(v) || v <= 0 || v > 1e7) throw new Error('Ungültiger Messwert'); return v; };
const str = v => { v = String(v || '').trim().replace(/\s+/g, ' '); if (v.length < 2 || v.length > 80) throw new Error('Modellname ungültig (2–80 Zeichen)'); return v; };
const verified = (req, res, next) => req.user.email_verified ? next() : res.status(403).json({ error: 'Bitte zuerst die E-Mail-Adresse bestätigen' });
app.post('/api/scores', auth, verified, scoreLimit, (req, res) => {
  try {
    const b = req.body || {};
    const t = Math.min(Math.max(parseInt(b.threads) || 1, 1), 512);
    db.prepare('INSERT INTO scores(user_id,cpu_model,gpu_model,cpu_single,cpu_multi,gpu_score,threads,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(req.user.id, str(b.cpu_model), str(cleanGpu(b.gpu_model)), num(b.cpu_single), num(b.cpu_multi), num(b.gpu_score), t, Date.now());
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/scores/:id', auth, (req, res) => { db.prepare('DELETE FROM scores WHERE id=? AND user_id=?').run(req.params.id, req.user.id); res.json({ ok: true }); });

const COLS = { cpu_multi: 'cpu_multi', cpu_single: 'cpu_single', gpu: 'gpu_score' };
app.get('/api/leaderboard', (req, res) => {
  const c = COLS[req.query.type] || 'cpu_multi';
  res.json(db.prepare(`SELECT u.username, s.cpu_model, s.gpu_model, MAX(s.${c}) score FROM scores s JOIN users u ON u.id=s.user_id WHERE s.hidden=0 AND u.banned=0 GROUP BY s.user_id ORDER BY score DESC LIMIT 50`).all());
});
app.get('/api/stats/cpus', (_q, res) => res.json(db.prepare('SELECT MIN(cpu_model) name, COUNT(*) n, COUNT(DISTINCT user_id) users, AVG(cpu_single) single, AVG(cpu_multi) multi FROM scores JOIN users u ON u.id=scores.user_id WHERE scores.hidden=0 AND u.banned=0 GROUP BY lower(cpu_model) ORDER BY multi DESC').all()));
app.get('/api/stats/gpus', (_q, res) => res.json(db.prepare('SELECT MIN(gpu_model) name, COUNT(*) n, COUNT(DISTINCT user_id) users, AVG(gpu_score) score FROM scores JOIN users u ON u.id=scores.user_id WHERE scores.hidden=0 AND u.banned=0 GROUP BY lower(gpu_model) ORDER BY score DESC').all()));

// ---- E-Mail-Verifizierung ----
const page = m => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:16px system-ui;max-width:30rem;margin:3rem auto;padding:0 1rem"><p>${m}</p><a href="/">Zur Startseite</a>`;
app.get('/verify', (req, res) => {
  const t = String(req.query.token || '');
  const u = t && db.prepare('SELECT * FROM users WHERE verify_hash=? AND verify_expires>?').get(sha(t), Date.now());
  if (!u) return res.status(400).send(page('Link ungültig oder abgelaufen. Im Profil kannst du eine neue Mail anfordern.'));
  db.prepare('UPDATE users SET email_verified=1, verify_hash=NULL, verify_expires=NULL WHERE id=?').run(u.id);
  res.send(page('E-Mail-Adresse bestätigt. Du kannst jetzt Ergebnisse speichern.'));
});
const mailLimit = rateLimit({ windowMs: 36e5, limit: 5, message: { error: 'Zu viele Mails, bitte später erneut' } });
app.post('/api/verify/resend', auth, mailLimit, (req, res) => {
  if (req.user.email_verified) return res.status(400).json({ error: 'Bereits bestätigt' });
  sendSafe(req.user); res.json({ ok: true });
});

// ---- Admin-Moderation ----
const admin = (req, res, next) => req.user.is_admin ? next() : res.status(403).json({ error: 'Kein Zugriff' });
const alog = (req, a, t) => db.prepare('INSERT INTO admin_log(admin_id,action,target,created_at) VALUES(?,?,?,?)').run(req.user.id, a, String(t), Date.now());
app.get('/api/admin/users', auth, admin, (_q, res) => res.json(db.prepare('SELECT u.id, u.username, u.email, u.email_verified verified, u.is_admin admin, u.banned, u.created_at, (SELECT COUNT(*) FROM scores WHERE user_id=u.id) scores FROM users u ORDER BY u.created_at DESC LIMIT 200').all()));
const target = (req, res) => { const t = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id); if (!t) res.status(404).json({ error: 'Nicht gefunden' }); else if (t.is_admin) { res.status(400).json({ error: 'Admins können nicht bearbeitet werden' }); return null; } return t || null; };
app.post('/api/admin/users/:id/ban', auth, admin, (req, res) => {
  const t = target(req, res); if (!t) return;
  const b = req.body?.banned ? 1 : 0;
  db.prepare('UPDATE users SET banned=? WHERE id=?').run(b, t.id);
  if (b) db.prepare('DELETE FROM sessions WHERE user_id=?').run(t.id);
  alog(req, b ? 'ban' : 'unban', t.id); res.json({ ok: true });
});
app.delete('/api/admin/users/:id', auth, admin, (req, res) => { const t = target(req, res); if (!t) return; db.prepare('DELETE FROM users WHERE id=?').run(t.id); alog(req, 'delete_user', t.username); res.json({ ok: true }); });
app.get('/api/admin/scores', auth, admin, (_q, res) => res.json(db.prepare('SELECT s.id, s.cpu_model, s.gpu_model, s.cpu_single, s.cpu_multi, s.gpu_score, s.hidden, s.created_at, u.username FROM scores s JOIN users u ON u.id=s.user_id ORDER BY s.created_at DESC LIMIT 200').all()));
app.post('/api/admin/scores/:id/hide', auth, admin, (req, res) => { db.prepare('UPDATE scores SET hidden=? WHERE id=?').run(req.body?.hidden ? 1 : 0, req.params.id); alog(req, req.body?.hidden ? 'hide_score' : 'show_score', req.params.id); res.json({ ok: true }); });
app.delete('/api/admin/scores/:id', auth, admin, (req, res) => { db.prepare('DELETE FROM scores WHERE id=?').run(req.params.id); alog(req, 'delete_score', req.params.id); res.json({ ok: true }); });

app.use(express.static(path.join(dir, 'public')));
app.use((err, _q, res, _n) => res.status(400).json({ error: 'Ungültige Anfrage' }));
app.listen(PORT, () => console.log(`BrowserBench läuft auf Port ${PORT}`));
