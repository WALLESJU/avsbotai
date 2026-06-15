const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;

// ── ENV ──────────────────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Bismilah2026';
const JWT_SECRET     = process.env.JWT_SECRET     || 'avsgpt2026rahasia123';

// ── MIDDLEWARE ───────────────────────────────────────────────────
app.use(cors({ origin: '*', methods: ['GET','POST','PATCH','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','x-admin-password','Authorization'] }));
app.use(express.json());

// ── IN-MEMORY DB (ganti PostgreSQL kalau mau persistent) ─────────
// Format: { username: { passwordHash, plan, is_active, usage_today, last_reset, created_at } }
let users = {};

// Reset usage harian — cek setiap request
function resetIfNewDay(user) {
  const today = new Date().toDateString();
  if (user.last_reset !== today) {
    user.usage_today = 0;
    user.last_reset  = today;
  }
}

const PLAN_LIMIT = { free: 5, pro: 15 };

// ── MIDDLEWARE ADMIN AUTH ────────────────────────────────────────
function adminAuth(req, res, next) {
  const pass = req.headers['x-admin-password'];
  if (!pass || pass !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'Password admin salah' });
  }
  next();
}

// ─────────────────────────────────────────────────────────────────
// PUBLIC ENDPOINTS
// ─────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true, message: 'AVS Bot Server aktif 🚀', time: new Date().toISOString(), userCount: Object.keys(users).length });
});

// ── LOGIN ────────────────────────────────────────────────────────
app.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ ok: false, error: 'Username & password wajib' });

    const user = users[username];
    if (!user) return res.json({ ok: false, error: 'Username tidak ditemukan' });
    if (!user.is_active) return res.json({ ok: false, error: 'Akun dinonaktifkan. Hubungi admin.' });

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return res.json({ ok: false, error: 'Password salah' });

    const token = jwt.sign({ username, plan: user.plan }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ ok: true, token, username, plan: user.plan });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── VERIFY TOKEN ─────────────────────────────────────────────────
app.post('/auth/verify', (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.json({ ok: false, error: 'Token tidak ada' });

    const decoded = jwt.verify(token, JWT_SECRET);
    const user = users[decoded.username];
    if (!user || !user.is_active) return res.json({ ok: false, error: 'Akun tidak aktif' });

    res.json({ ok: true, username: decoded.username, plan: user.plan });
  } catch (e) {
    res.json({ ok: false, error: 'Token tidak valid atau expired' });
  }
});

// ── USE (catat 1 analisa) ────────────────────────────────────────
app.post('/auth/use', (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.json({ ok: false, error: 'Token tidak ada' });

    const decoded = jwt.verify(token, JWT_SECRET);
    const user = users[decoded.username];
    if (!user || !user.is_active) return res.json({ ok: false, error: 'Akun tidak aktif' });

    resetIfNewDay(user);
    const limit = PLAN_LIMIT[user.plan] || 5;

    if (user.usage_today >= limit) {
      return res.json({
        ok: false,
        error: `Limit harian habis! (${user.usage_today}/${limit}). Reset besok jam 00:00. Upgrade ke PRO untuk lebih banyak analisa.`,
        usage: user.usage_today,
        limit
      });
    }

    user.usage_today++;
    res.json({ ok: true, usage: user.usage_today, limit, remaining: limit - user.usage_today });
  } catch (e) {
    res.json({ ok: false, error: 'Token tidak valid' });
  }
});

// ─────────────────────────────────────────────────────────────────
// ADMIN ENDPOINTS
// ─────────────────────────────────────────────────────────────────

// ── GET ALL USERS ────────────────────────────────────────────────
app.get('/admin/users', adminAuth, (req, res) => {
  const list = Object.entries(users).map(([username, u]) => {
    resetIfNewDay(u);
    return {
      username,
      plan:        u.plan,
      is_active:   u.is_active,
      usage_today: u.usage_today,
      limit:       PLAN_LIMIT[u.plan] || 5,
      created_at:  u.created_at
    };
  });
  res.json({ ok: true, users: list });
});

// ── CREATE USER ──────────────────────────────────────────────────
app.post('/admin/create-user', adminAuth, async (req, res) => {
  try {
    const { username, password, plan = 'free' } = req.body;
    if (!username || !password) return res.json({ ok: false, error: 'Username & password wajib' });
    if (users[username]) return res.json({ ok: false, error: 'Username sudah ada' });
    if (password.length < 6) return res.json({ ok: false, error: 'Password minimal 6 karakter' });

    const passwordHash = await bcrypt.hash(password, 10);
    users[username] = {
      passwordHash,
      plan:        ['free','pro'].includes(plan) ? plan : 'free',
      is_active:   true,
      usage_today: 0,
      last_reset:  new Date().toDateString(),
      created_at:  new Date().toISOString()
    };
    res.json({ ok: true, message: `User "${username}" [${plan.toUpperCase()}] berhasil dibuat!` });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── SET PLAN ─────────────────────────────────────────────────────
app.patch('/admin/set-plan', adminAuth, (req, res) => {
  const { username, plan } = req.body;
  if (!users[username]) return res.json({ ok: false, error: 'User tidak ditemukan' });
  if (!['free','pro'].includes(plan)) return res.json({ ok: false, error: 'Plan tidak valid' });
  users[username].plan = plan;
  res.json({ ok: true, message: `Plan ${username} diubah ke ${plan.toUpperCase()}` });
});

// ── SET ACTIVE ───────────────────────────────────────────────────
app.patch('/admin/set-active', adminAuth, (req, res) => {
  const { username, is_active } = req.body;
  if (!users[username]) return res.json({ ok: false, error: 'User tidak ditemukan' });
  users[username].is_active = !!is_active;
  res.json({ ok: true, message: `User ${username} ${is_active ? 'diaktifkan' : 'dinonaktifkan'}` });
});

// ── RESET PASSWORD ───────────────────────────────────────────────
app.patch('/admin/reset-password', adminAuth, async (req, res) => {
  try {
    const { username, new_password } = req.body;
    if (!users[username]) return res.json({ ok: false, error: 'User tidak ditemukan' });
    if (!new_password || new_password.length < 6) return res.json({ ok: false, error: 'Password minimal 6 karakter' });
    users[username].passwordHash = await bcrypt.hash(new_password, 10);
    res.json({ ok: true, message: `Password ${username} berhasil direset` });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── RESET USAGE ──────────────────────────────────────────────────
app.patch('/admin/reset-usage', adminAuth, (req, res) => {
  const { username } = req.body;
  if (!users[username]) return res.json({ ok: false, error: 'User tidak ditemukan' });
  users[username].usage_today = 0;
  users[username].last_reset  = new Date().toDateString();
  res.json({ ok: true, message: `Usage ${username} direset ke 0` });
});

// ── DELETE USER ──────────────────────────────────────────────────
app.delete('/admin/delete-user', adminAuth, (req, res) => {
  const { username } = req.body;
  if (!users[username]) return res.json({ ok: false, error: 'User tidak ditemukan' });
  delete users[username];
  res.json({ ok: true, message: `User ${username} dihapus` });
});

// ── 404 HANDLER ──────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ ok: false, error: `Endpoint "${req.method} ${req.path}" tidak ditemukan` });
});

app.listen(PORT, () => {
  console.log(`✅ AVS Bot Server jalan di port ${PORT}`);
  console.log(`🔑 Admin password: ${ADMIN_PASSWORD}`);
});
