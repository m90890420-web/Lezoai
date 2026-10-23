'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { rateLimit } = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? '' : crypto.randomBytes(32).toString('hex'));
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
  connectionTimeoutMillis: 10000,
});

// On Vercel, keep the function alive even if configuration is incomplete so
// the API can return a useful JSON error instead of failing every route with 404/500.
let dbReadyPromise = null;
async function ensureRuntimeConfig(req, res, next) {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'قاعدة البيانات غير مضبوطة. أضف DATABASE_URL في Vercel Environment Variables.' });
  if (!JWT_SECRET) return res.status(503).json({ error: 'سر الجلسات غير مضبوط. أضف JWT_SECRET في Vercel Environment Variables.' });
  try {
    if (!dbReadyPromise) dbReadyPromise = initDb();
    await dbReadyPromise;
    next();
  } catch (err) {
    dbReadyPromise = null;
    console.error('Database initialization failed:', err.message);
    res.status(503).json({ error: 'تعذّر الاتصال بقاعدة البيانات. راجع DATABASE_URL وإعدادات PostgreSQL.' });
  }
}

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use('/css', express.static(path.join(__dirname, '..', 'css'), { maxAge: '1h' }));
app.use('/js', express.static(path.join(__dirname, '..', 'js'), { maxAge: '1h' }));
app.use('/assets', express.static(path.join(__dirname, '..', 'assets'), { maxAge: '1h' }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'محاولات كثيرة. استنى شوية وجرب تاني.' } });
const chatLimiter = rateLimit({ windowMs: 60 * 1000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'طلبات كثيرة في وقت قصير. استنى دقيقة.' } });

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(60) NOT NULL,
      email VARCHAR(254) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}
function makeToken(user) {
  return jwt.sign({ sub: String(user.id), email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d', issuer: 'lezo-ai' });
}
function setAuthCookie(res, user) {
  res.cookie('lezo_session', makeToken(user), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}
function requireAuth(req, res, next) {
  const token = req.cookies?.lezo_session || req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'سجّل دخولك الأول.' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { issuer: 'lezo-ai' });
    req.user = { id: Number(decoded.sub), email: decoded.email, name: decoded.name };
    next();
  } catch {
    res.clearCookie('lezo_session', { path: '/', sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
    return res.status(401).json({ error: 'انتهت جلسة الدخول. سجّل دخولك مرة أخرى.' });
  }
}
// Express does not parse cookies by default; read only our signed JWT cookie safely.
app.use((req, _res, next) => {
  const raw = req.headers.cookie || '';
  const match = raw.split(';').map(v => v.trim()).find(v => v.startsWith('lezo_session='));
  if (match) {
    try { req.cookies = { lezo_session: decodeURIComponent(match.slice('lezo_session='.length)) }; }
    catch { req.cookies = {}; }
  } else req.cookies = {};
  next();
});

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'Lezo-AI' }));

app.post('/api/auth/register', ensureRuntimeConfig, authLimiter, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (name.length < 2 || name.length > 60) return res.status(400).json({ error: 'الاسم لازم يكون من حرفين إلى 60 حرفًا.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ error: 'اكتب بريد إلكتروني صحيح.' });
    if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'كلمة المرور لازم تكون 8 أحرف على الأقل.' });
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query('INSERT INTO users(name,email,password_hash) VALUES($1,$2,$3) RETURNING id,name,email,created_at', [name, email, passwordHash]);
    const user = result.rows[0];
    setAuthCookie(res, user);
    res.status(201).json({ user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'البريد الإلكتروني ده مسجل بالفعل. جرّب تسجيل الدخول.' });
    console.error('Register error:', err.message);
    res.status(500).json({ error: 'حصل خطأ أثناء إنشاء الحساب. جرّب تاني.' });
  }
});

app.post('/api/auth/login', ensureRuntimeConfig, authLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email || !password) return res.status(400).json({ error: 'اكتب البريد الإلكتروني وكلمة المرور.' });
    const result = await pool.query('SELECT id,name,email,password_hash FROM users WHERE email=$1', [email]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.' });
    setAuthCookie(res, user);
    res.json({ user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'تعذّر تسجيل الدخول الآن. جرّب تاني.' });
  }
});

app.get('/api/auth/me', ensureRuntimeConfig, requireAuth, (req, res) => res.json({ user: req.user }));
app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie('lezo_session', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/' });
  res.json({ ok: true });
});

app.post('/api/chat', ensureRuntimeConfig, requireAuth, chatLimiter, async (req, res) => {
  try {
    if (!process.env.OPENROUTER_API_KEY) return res.status(503).json({ error: 'مفتاح OpenRouter غير مضبوط. أضف OPENROUTER_API_KEY في Vercel Environment Variables.' });
    const incoming = req.body?.messages;
    if (!Array.isArray(incoming) || incoming.length === 0 || incoming.length > 30) return res.status(400).json({ error: 'سجل المحادثة غير صالح.' });
    const messages = incoming.map(m => ({
      role: m?.role === 'assistant' ? 'assistant' : 'user',
      content: typeof m?.content === 'string' ? m.content.slice(0, 12000) : ''
    })).filter(m => m.content);
    if (!messages.length || messages[messages.length - 1].role !== 'user') return res.status(400).json({ error: 'اكتب رسالة قبل الإرسال.' });
    const model = process.env.OPENROUTER_MODEL || 'openrouter/auto';
    const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.APP_URL || `https://${req.get('host')}`,
        'X-Title': 'Lezo-AI'
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'أنت Lezo-AI، مساعد ذكي يتحدث العربية بطلاقة ويفهم اللهجة المصرية. ساعد المستخدم في البرمجة وكتابة الأكواد وشرحها. عند طلب كود، أعطِ كودًا صحيحًا ومنظمًا مع شرح مختصر عند الحاجة. لا تدّعِ تنفيذ أي شيء لم تنفذه.' },
          ...messages
        ],
        temperature: 0.7,
        max_tokens: 3000
      })
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error('OpenRouter error:', upstream.status, JSON.stringify(data).slice(0, 1000));
      const status = upstream.status === 401 || upstream.status === 402 || upstream.status === 429 ? upstream.status : 502;
      return res.status(status).json({ error: upstream.status === 401 ? 'مفتاح OpenRouter غير صحيح.' : upstream.status === 402 ? 'رصيد OpenRouter غير كافٍ لهذا الطلب.' : upstream.status === 429 ? 'وصلت لحد الطلبات لدى OpenRouter. جرّب بعد قليل.' : 'OpenRouter لم يستطع إكمال الطلب. راجع اختيار النموذج وإعدادات المفتاح.' });
    }
    const answer = data?.choices?.[0]?.message?.content;
    if (typeof answer !== 'string' || !answer.trim()) return res.status(502).json({ error: 'وصل رد فارغ من النموذج. جرّب مرة أخرى.' });
    res.json({ answer: answer.trim(), model: data.model || model });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(502).json({ error: 'تعذّر الاتصال بخدمة الذكاء الاصطناعي. جرّب مرة أخرى.' });
  }
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'المسار غير موجود.' });
  res.sendFile(path.join(__dirname, '..', 'index.html'), err => { if (err) next(err); });
});

// Vercel imports this Express app as a serverless function. For local development,
// `npm start` still runs the same app as a normal Node server.
if (require.main === module) {
  if (!process.env.DATABASE_URL && process.env.NODE_ENV !== 'production') {
    console.error('Missing DATABASE_URL. Configure PostgreSQL in your local .env file.');
    process.exitCode = 1;
  } else {
    app.listen(PORT, '0.0.0.0', () => console.log(`Lezo-AI is running on port ${PORT}`));
  }
}

module.exports = app;
