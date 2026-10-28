'use strict';
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const APP_NAME = process.env.APP_NAME || 'Ιδιαίτερα';
const ALLOW_SIGNUP = (process.env.ALLOW_SIGNUP || 'true') !== 'false';
const PROD = process.env.NODE_ENV === 'production';
const SESSION_DAYS = 30;
const MAX_FILE = 5 * 1024 * 1024;       // 5 MB per attachment
const MAX_FILES = 5;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (Postgres, e.g. Neon).');
  process.exit(1);
}
function pgUrl(raw) {
  // node-postgres does not understand channel_binding; Neon works fine without it.
  try {
    const u = new URL(raw);
    u.searchParams.delete('channel_binding');
    if (u.searchParams.get('sslmode') === 'require') u.searchParams.set('sslmode', 'verify-full');
    return u.toString();
  } catch { return raw; }
}
const pool = new Pool({
  connectionString: pgUrl(process.env.DATABASE_URL),
  max: Number(process.env.PG_POOL_MAX || 5),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
  keepAlive: true,
});
pool.on('error', err => console.error('[db] idle client error:', err.message));
const q = (text, params) => pool.query(text, params);

const DEFAULT_DATA = () => ({
  students: [], appointments: [],
  settings: { teacherName: '', defaultRate: 15, subjects: 'Μαθηματικά, Φυσική, Χημεία, Αγγλικά, Νέα Ελληνικά, Ιστορία' },
  theme: 'light',
});

async function migrate() {
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      pw_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('teacher','student')),
      name TEXT NOT NULL DEFAULT '',
      teacher_id INT REFERENCES users(id) ON DELETE CASCADE,
      student_ref TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS users_student_link ON users(teacher_id, student_ref) WHERE role = 'student';
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS teacher_data (
      user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS invites (
      code TEXT PRIMARY KEY,
      teacher_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      student_ref TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS materials (
      id SERIAL PRIMARY KEY,
      teacher_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note','exercise')),
      target_type TEXT NOT NULL CHECK (target_type IN ('student','class','all')),
      student_ref TEXT,
      class_label TEXT,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      due_date TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS materials_teacher ON materials(teacher_id);
    CREATE TABLE IF NOT EXISTS attachments (
      id SERIAL PRIMARY KEY,
      material_id INT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INT NOT NULL,
      data BYTEA NOT NULL
    );
    CREATE INDEX IF NOT EXISTS attachments_material ON attachments(material_id);
  `);
  await q('DELETE FROM sessions WHERE expires_at < now()');
}

// ---------- helpers ----------
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
function checkPw(pw, stored) {
  const [alg, saltHex, keyHex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const key = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(keyHex, 'hex');
  return want.length === key.length && crypto.timingSafeEqual(want, key);
}
const normEmail = e => String(e || '').trim().toLowerCase();
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;
const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
function fail(res, code, error) { return res.status(code).json({ error }); }

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
async function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await q(`INSERT INTO sessions(token_hash,user_id,expires_at) VALUES ($1,$2, now() + interval '${SESSION_DAYS} days')`, [sha(token), userId]);
  res.setHeader('Set-Cookie', `fid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${PROD ? '; Secure' : ''}`);
}
function clearCookie(res) {
  res.setHeader('Set-Cookie', `fid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${PROD ? '; Secure' : ''}`);
}
const publicUser = u => ({ id: u.id, email: u.email, role: u.role, name: u.name });

// brute-force guard (in-memory)
const fails = new Map();
function tooMany(key) {
  const f = fails.get(key);
  return f && f.count >= 8 && Date.now() - f.first < 15 * 60 * 1000;
}
function markFail(key) {
  const f = fails.get(key);
  if (!f || Date.now() - f.first > 15 * 60 * 1000) fails.set(key, { count: 1, first: Date.now() });
  else f.count++;
}

async function getTeacherData(teacherId) {
  const r = await q('SELECT data FROM teacher_data WHERE user_id=$1', [teacherId]);
  return r.rows[0] ? { ...DEFAULT_DATA(), ...r.rows[0].data } : DEFAULT_DATA();
}

// ---------- app ----------
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});
app.use(express.json({ limit: '40mb' }));

// CSRF: every mutating /api call must carry X-App header (forces CORS preflight cross-site)
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.get('X-App') !== '1') return fail(res, 403, 'Μη έγκυρο αίτημα');
  next();
});

async function loadUser(req, res, next) {
  try {
    const token = parseCookies(req).fid;
    if (token) {
      const r = await q(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at > now()`, [sha(token)]);
      req.user = r.rows[0] || null;
    }
    next();
  } catch (e) { next(e); }
}
app.use('/api', loadUser);
const auth = role => (req, res, next) => {
  if (!req.user) return fail(res, 401, 'Απαιτείται σύνδεση');
  if (role && req.user.role !== role) return fail(res, 403, 'Δεν επιτρέπεται');
  next();
};
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get('/healthz', wrap(async (req, res) => {
  await q('SELECT 1');
  res.json({ ok: true, app: APP_NAME, storage: 'postgres', persistent: true, signup: ALLOW_SIGNUP });
}));

app.get('/api/config', (req, res) => res.json({ appName: APP_NAME, signup: ALLOW_SIGNUP }));

// ---- auth ----
app.post('/api/auth/signup', wrap(async (req, res) => {
  const email = normEmail(req.body.email);
  const password = String(req.body.password || '');
  const name = str(req.body.name, 120);
  const inviteCode = str(req.body.inviteCode, 64).toUpperCase();
  if (!validEmail(email)) return fail(res, 400, 'Μη έγκυρο email');
  if (password.length < 8) return fail(res, 400, 'Ο κωδικός πρέπει να έχει τουλάχιστον 8 χαρακτήρες');
  const exists = await q('SELECT 1 FROM users WHERE email=$1', [email]);
  if (exists.rowCount) return fail(res, 409, 'Υπάρχει ήδη λογαριασμός με αυτό το email');

  let user;
  if (inviteCode) {
    const inv = (await q('SELECT * FROM invites WHERE code=$1 AND used_at IS NULL AND expires_at > now()', [inviteCode])).rows[0];
    if (!inv) return fail(res, 400, 'Ο κωδικός πρόσκλησης δεν είναι έγκυρος ή έληξε');
    const data = await getTeacherData(inv.teacher_id);
    const st = data.students.find(s => s.id === inv.student_ref);
    if (!st) return fail(res, 400, 'Ο μαθητής της πρόσκλησης δεν υπάρχει πια');
    const linked = await q(`SELECT 1 FROM users WHERE role='student' AND teacher_id=$1 AND student_ref=$2`, [inv.teacher_id, inv.student_ref]);
    if (linked.rowCount) return fail(res, 409, 'Ο μαθητής έχει ήδη λογαριασμό');
    user = (await q(`INSERT INTO users(email,pw_hash,role,name,teacher_id,student_ref) VALUES ($1,$2,'student',$3,$4,$5) RETURNING *`,
      [email, hashPw(password), name || st.name, inv.teacher_id, inv.student_ref])).rows[0];
    await q('UPDATE invites SET used_at=now() WHERE code=$1', [inviteCode]);
  } else {
    if (!ALLOW_SIGNUP) return fail(res, 403, 'Οι εγγραφές είναι κλειστές');
    user = (await q(`INSERT INTO users(email,pw_hash,role,name) VALUES ($1,$2,'teacher',$3) RETURNING *`, [email, hashPw(password), name])).rows[0];
    const d = DEFAULT_DATA(); d.settings.teacherName = name;
    await q('INSERT INTO teacher_data(user_id,data) VALUES ($1,$2)', [user.id, d]);
  }
  await createSession(res, user.id);
  res.status(201).json({ user: publicUser(user) });
}));

app.post('/api/auth/login', wrap(async (req, res) => {
  const email = normEmail(req.body.email);
  const key = `${req.ip}|${email}`;
  if (tooMany(key)) return fail(res, 429, 'Πολλές αποτυχημένες προσπάθειες. Δοκίμασε σε 15 λεπτά.');
  const u = (await q('SELECT * FROM users WHERE email=$1', [email])).rows[0];
  if (!u || !checkPw(String(req.body.password || ''), u.pw_hash)) { markFail(key); return fail(res, 401, 'Λάθος email ή κωδικός'); }
  fails.delete(key);
  await createSession(res, u.id);
  res.json({ user: publicUser(u) });
}));

app.post('/api/auth/logout', wrap(async (req, res) => {
  const token = parseCookies(req).fid;
  if (token) await q('DELETE FROM sessions WHERE token_hash=$1', [sha(token)]);
  clearCookie(res);
  res.json({ ok: true });
}));

app.get('/api/me', (req, res) => res.json({ user: req.user ? publicUser(req.user) : null }));

app.post('/api/auth/password', auth(), wrap(async (req, res) => {
  const { current, next } = req.body;
  if (!checkPw(String(current || ''), req.user.pw_hash)) return fail(res, 400, 'Λάθος τρέχων κωδικός');
  if (String(next || '').length < 8) return fail(res, 400, 'Ο νέος κωδικός πρέπει να έχει τουλάχιστον 8 χαρακτήρες');
  await q('UPDATE users SET pw_hash=$1 WHERE id=$2', [hashPw(String(next)), req.user.id]);
  res.json({ ok: true });
}));

// ---- teacher data (same shape as the original Firestore document) ----
app.get('/api/data', auth('teacher'), wrap(async (req, res) => res.json(await getTeacherData(req.user.id))));

app.put('/api/data', auth('teacher'), wrap(async (req, res) => {
  const b = req.body || {};
  if (!Array.isArray(b.students) || !Array.isArray(b.appointments)) return fail(res, 400, 'Μη έγκυρα δεδομένα');
  const data = {
    students: b.students.slice(0, 5000),
    appointments: b.appointments.slice(0, 50000),
    settings: { ...DEFAULT_DATA().settings, ...(b.settings || {}) },
    theme: b.theme === 'dark' ? 'dark' : 'light',
  };
  await q(`INSERT INTO teacher_data(user_id,data,updated_at) VALUES ($1,$2,now())
           ON CONFLICT (user_id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`, [req.user.id, data]);
  // remove student logins whose student was deleted
  const ids = data.students.map(s => String(s.id));
  await q(`DELETE FROM users WHERE role='student' AND teacher_id=$1 AND NOT (student_ref = ANY($2::text[]))`, [req.user.id, ids]);
  await q(`DELETE FROM materials WHERE teacher_id=$1 AND target_type='student' AND NOT (student_ref = ANY($2::text[]))`, [req.user.id, ids]);
  res.json({ ok: true });
}));

// ---- student accounts (teacher side) ----
async function requireStudent(req, res) {
  const data = await getTeacherData(req.user.id);
  const st = data.students.find(s => String(s.id) === req.params.ref);
  if (!st) { fail(res, 404, 'Ο μαθητής δεν βρέθηκε'); return null; }
  return st;
}

app.get('/api/student-accounts', auth('teacher'), wrap(async (req, res) => {
  const accts = (await q(`SELECT id,email,student_ref,created_at FROM users WHERE role='student' AND teacher_id=$1`, [req.user.id])).rows;
  const invites = (await q(`SELECT code,student_ref,expires_at FROM invites WHERE teacher_id=$1 AND used_at IS NULL AND expires_at > now()`, [req.user.id])).rows;
  res.json({ accounts: accts, invites });
}));

app.post('/api/students/:ref/account', auth('teacher'), wrap(async (req, res) => {
  const st = await requireStudent(req, res); if (!st) return;
  const email = normEmail(req.body.email);
  const password = String(req.body.password || '');
  if (!validEmail(email)) return fail(res, 400, 'Μη έγκυρο email');
  if (password.length < 8) return fail(res, 400, 'Ο κωδικός πρέπει να έχει τουλάχιστον 8 χαρακτήρες');
  const existing = (await q(`SELECT * FROM users WHERE role='student' AND teacher_id=$1 AND student_ref=$2`, [req.user.id, st.id])).rows[0];
  const clash = (await q('SELECT id FROM users WHERE email=$1', [email])).rows[0];
  if (clash && (!existing || clash.id !== existing.id)) return fail(res, 409, 'Το email χρησιμοποιείται ήδη');
  if (existing) {
    await q('UPDATE users SET email=$1, pw_hash=$2 WHERE id=$3', [email, hashPw(password), existing.id]);
    await q('DELETE FROM sessions WHERE user_id=$1', [existing.id]);
  } else {
    await q(`INSERT INTO users(email,pw_hash,role,name,teacher_id,student_ref) VALUES ($1,$2,'student',$3,$4,$5)`,
      [email, hashPw(password), str(st.name, 120), req.user.id, String(st.id)]);
  }
  res.json({ ok: true, email });
}));

app.delete('/api/students/:ref/account', auth('teacher'), wrap(async (req, res) => {
  await q(`DELETE FROM users WHERE role='student' AND teacher_id=$1 AND student_ref=$2`, [req.user.id, req.params.ref]);
  await q(`DELETE FROM invites WHERE teacher_id=$1 AND student_ref=$2`, [req.user.id, req.params.ref]);
  res.json({ ok: true });
}));

app.post('/api/students/:ref/invite', auth('teacher'), wrap(async (req, res) => {
  const st = await requireStudent(req, res); if (!st) return;
  const code = crypto.randomBytes(5).toString('hex').toUpperCase();
  await q(`DELETE FROM invites WHERE teacher_id=$1 AND student_ref=$2 AND used_at IS NULL`, [req.user.id, String(st.id)]);
  await q(`INSERT INTO invites(code,teacher_id,student_ref,expires_at) VALUES ($1,$2,$3, now() + interval '14 days')`, [code, req.user.id, String(st.id)]);
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({ code, link: `${base}/?invite=${code}`, expiresInDays: 14 });
}));

// ---- materials (notes / exercises) ----
function decodeAttachments(list) {
  if (!Array.isArray(list)) return [];
  if (list.length > MAX_FILES) throw Object.assign(new Error(`Έως ${MAX_FILES} αρχεία`), { status: 400 });
  return list.map(f => {
    const buf = Buffer.from(String(f.dataBase64 || ''), 'base64');
    if (!buf.length) throw Object.assign(new Error('Κενό αρχείο'), { status: 400 });
    if (buf.length > MAX_FILE) throw Object.assign(new Error(`Το αρχείο ${f.filename} ξεπερνά τα 5MB`), { status: 400 });
    return { filename: str(f.filename, 200).replace(/[\r\n"\\/]/g, '_') || 'file', mime: str(f.mime, 100) || 'application/octet-stream', size: buf.length, data: buf };
  });
}
async function materialsWithFiles(rows) {
  if (!rows.length) return [];
  const files = (await q('SELECT id,material_id,filename,mime,size FROM attachments WHERE material_id = ANY($1::int[]) ORDER BY id', [rows.map(r => r.id)])).rows;
  return rows.map(r => ({ ...r, attachments: files.filter(f => f.material_id === r.id) }));
}

app.get('/api/materials', auth('teacher'), wrap(async (req, res) => {
  const rows = (await q('SELECT * FROM materials WHERE teacher_id=$1 ORDER BY created_at DESC', [req.user.id])).rows;
  res.json(await materialsWithFiles(rows));
}));

app.post('/api/materials', auth('teacher'), wrap(async (req, res) => {
  const b = req.body || {};
  const title = str(b.title, 200);
  if (!title) return fail(res, 400, 'Ο τίτλος είναι υποχρεωτικός');
  const kind = b.kind === 'exercise' ? 'exercise' : 'note';
  const target = ['student', 'class', 'all'].includes(b.targetType) ? b.targetType : null;
  if (!target) return fail(res, 400, 'Διάλεξε παραλήπτη');
  let studentRef = null, classLabel = null;
  if (target === 'student') {
    const data = await getTeacherData(req.user.id);
    if (!data.students.some(s => String(s.id) === String(b.studentRef))) return fail(res, 400, 'Ο μαθητής δεν βρέθηκε');
    studentRef = String(b.studentRef);
  }
  if (target === 'class') { classLabel = str(b.classLabel, 100); if (!classLabel) return fail(res, 400, 'Συμπλήρωσε τάξη/επίπεδο'); }
  const files = decodeAttachments(b.attachments);
  const client = await pool.connect();
  let m;
  try {
    await client.query('BEGIN');
    m = (await client.query(`INSERT INTO materials(teacher_id,kind,target_type,student_ref,class_label,title,body,due_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.user.id, kind, target, studentRef, classLabel, title, str(b.body, 20000), str(b.dueDate, 10) || null])).rows[0];
    for (const f of files) {
      await client.query('INSERT INTO attachments(material_id,filename,mime,size,data) VALUES ($1,$2,$3,$4,$5)', [m.id, f.filename, f.mime, f.size, f.data]);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  res.status(201).json((await materialsWithFiles([m]))[0]);
}));

app.delete('/api/materials/:id', auth('teacher'), wrap(async (req, res) => {
  await q('DELETE FROM materials WHERE id=$1 AND teacher_id=$2', [parseInt(req.params.id, 10) || 0, req.user.id]);
  res.json({ ok: true });
}));

// which materials can a student user see?
async function studentContext(user) {
  const data = await getTeacherData(user.teacher_id);
  const st = data.students.find(s => String(s.id) === user.student_ref) || null;
  return { data, st };
}
async function studentMaterials(user, st) {
  const level = (st?.level || '').trim().toLowerCase();
  return (await q(`SELECT * FROM materials WHERE teacher_id=$1 AND (
      target_type='all' OR (target_type='student' AND student_ref=$2) OR (target_type='class' AND lower(trim(class_label))=$3 AND $3 <> '')
    ) ORDER BY created_at DESC`, [user.teacher_id, user.student_ref, level])).rows;
}

app.get('/api/portal', auth('student'), wrap(async (req, res) => {
  const { data, st } = await studentContext(req.user);
  if (!st) return fail(res, 404, 'Ο λογαριασμός μαθητή δεν είναι πλέον συνδεδεμένος');
  const appts = data.appointments.filter(a => String(a.studentId) === String(st.id))
    .map(a => ({ id: a.id, date: a.date, time: a.time, subject: a.subject, duration: a.duration, status: a.status,
                 amount: a.amount, paid: !!a.paid, lessonNotes: a.lessonNotes, homework: a.homework }))
    .sort((x, y) => String(y.date).localeCompare(String(x.date)));
  const materials = await materialsWithFiles(await studentMaterials(req.user, st));
  res.json({
    teacherName: data.settings.teacherName || '',
    student: { name: st.name, level: st.level || '', subjects: st.subjects || [], rate: st.rate },
    appointments: appts,
    materials: materials.map(({ teacher_id, ...m }) => m),
  });
}));

app.get('/api/attachments/:id', auth(), wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10) || 0;
  const f = (await q('SELECT a.*, m.teacher_id, m.id AS mid FROM attachments a JOIN materials m ON m.id=a.material_id WHERE a.id=$1', [id])).rows[0];
  if (!f) return fail(res, 404, 'Δεν βρέθηκε');
  let allowed = req.user.role === 'teacher' && f.teacher_id === req.user.id;
  if (!allowed && req.user.role === 'student' && req.user.teacher_id === f.teacher_id) {
    const { st } = await studentContext(req.user);
    allowed = (await studentMaterials(req.user, st)).some(m => m.id === f.mid);
  }
  if (!allowed) return fail(res, 404, 'Δεν βρέθηκε');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${f.filename.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(f.data);
}));

app.use('/api', (req, res) => fail(res, 404, 'Not found'));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return fail(res, 413, 'Πολύ μεγάλο αίτημα (όριο αρχείων 5MB/αρχείο)');
  if (err.status && err.status < 500) return fail(res, err.status, err.message);
  console.error(err);
  fail(res, 500, 'Σφάλμα διακομιστή');
});

async function migrateWithRetry(tries = 6) {
  for (let i = 1; ; i++) {
    try { return await migrate(); } catch (e) {
      console.error(`[db] migrate failed (attempt ${i}/${tries}): ${e.message}`);
      if (i >= tries) throw e;
      await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** i, 10000)));
    }
  }
}

migrateWithRetry().then(() => {
  app.listen(PORT, () => console.log(`${APP_NAME} listening on :${PORT}`));
}).catch(e => { console.error('Migration failed', e); process.exit(1); });

process.on('SIGTERM', () => pool.end().finally(() => process.exit(0)));
