const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;

// ── ENV ──────────────────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Bismilah2026';
const JWT_SECRET = process.env.JWT_SECRET || 'avsgpt2026rahasia123';

// ── MIDDLEWARE ───────────────────────────────────────────────────
app.use(cors({ origin: '*', methods: ['GET','POST','PATCH','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','x-admin-password','Authorization'] }));
app.use(express.json());

// ── IN-MEMORY DB ─────────────────────────────────────────────────
let users = {};

// ── PAIR BOX CACHE [v5.0] ─────────────────────────────────────────
// 1 pair = 1 analisis bersama. Semua user dapat hasil yang sama
// selama TTL belum habis. GPT + TwelveData hanya dipanggil saat stale.
// TODO: Ganti dengan Redis agar persist saat Railway restart.
const pairBox = {};
const BOX_TTL = 3 * 60 * 1000; // 3 menit TTL per pair

function boxFresh(sym) {
  const b = pairBox[sym];
  return b && (Date.now() - b.ts) < BOX_TTL;
}

// Reset usage harian
function resetIfNewDay(user) {
  const today = new Date().toDateString();
  if (user.last_reset !== today) {
    user.usage_today = 0;
    user.last_reset = today;
  }
}

const PLAN_LIMIT = { free: 10, pro: 30 };

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

app.get('/health', (req, res) => {
  res.json({ ok: true, message: 'AVS Bot Server aktif 🚀', time: new Date().toISOString(), userCount: Object.keys(users).length });
});

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

app.post('/auth/verify', (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.json({ ok: false, error: 'Token tidak ada' });
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = users[decoded.username];
    if (!user || !user.is_active) return res.json({ ok: false, error: 'Akun tidak aktif' });
    resetIfNewDay(user);
    const limit = PLAN_LIMIT[user.plan] || 5;
    res.json({ ok: true, username: decoded.username, plan: user.plan, usage: user.usage_today, limit });
  } catch (e) {
    res.json({ ok: false, error: 'Token tidak valid atau expired' });
  }
});

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
      return res.json({ ok: false, error: `Limit harian habis! (${user.usage_today}/${limit}). Reset besok jam 00:00.`, usage: user.usage_today, limit });
    }
    user.usage_today++;
    res.json({ ok: true, usage: user.usage_today, limit, remaining: limit - user.usage_today });
  } catch (e) {
    res.json({ ok: false, error: 'Token tidak valid' });
  }
});

// ─────────────────────────────────────────────────────────────────
// BOT SIGNAL — GPT + TwelveData diproses di server (key aman)
// ─────────────────────────────────────────────────────────────────
const OPENAI_URL   = process.env.OPENAI_URL   || 'https://lite.koboillm.com/v1/chat/completions';
const OPENAI_KEY = process.env.OPENAI_KEY || 'sk-bbcQ_tgzKrXpMRTPXrxHvg';
const TWELVE_KEY = process.env.TWELVE_KEY || 'a99e7352827544e28063d1227ef76a4a';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'openai/gpt-4o-mini';

app.post('/bot/signal', async (req, res) => {
  try {
    const { token, expirymin, symbol } = req.body;
    if (!token) return res.json({ ok: false, error: 'Token tidak ada' });

    // Verifikasi token
    let decoded;
    try { decoded = jwt.verify(token, JWT_SECRET); }
    catch(e) { return res.json({ ok: false, error: 'Token tidak valid atau expired' }); }

    const user = users[decoded.username];
    if (!user || !user.is_active) return res.json({ ok: false, error: 'Akun tidak aktif' });

    // Reset usage jika hari baru
    resetIfNewDay(user);
    const limit = PLAN_LIMIT[user.plan] || 5;

    if (user.usage_today >= limit) {
      return res.json({ ok: false, error: `Limit harian habis! (${user.usage_today}/${limit}). Reset besok jam 00:00.`, usage: user.usage_today, limit });
    }

    const sym    = symbol    || 'EUR/USD';
    const EXPMIN = expirymin || 5; // [v5.0] default 5 menit (minimum expiry GPT)

    // ── [v5.0] PAIR BOX CACHE — serve shared analysis jika masih fresh ──
    // Tidak memanggil TwelveData maupun GPT jika box belum stale.
    // Semua user yang request dalam window BOX_TTL mendapat analisis yang sama.
    if (boxFresh(sym)) {
      user.usage_today++;
      const cached = pairBox[sym];
      const ageS   = Math.round((Date.now() - cached.ts) / 1000);
      return res.json({
        ok: true,
        signal:      cached.data,
        candles_1m:  cached.candles_1m,
        source:      'cache',
        box_age_sec: ageS,
        usage: user.usage_today, limit, remaining: limit - user.usage_today
      });
    }

    // ── BOX STALE: REBUILD — fetch TwelveData + call GPT ────────────
    if (!OPENAI_KEY || !TWELVE_KEY) {
      return res.json({ ok: false, error: 'Server belum dikonfigurasi (OPENAI_KEY / TWELVE_KEY kosong)' });
    }

    const https = require('https');

    // Fetch candle dari TwelveData (native https, tanpa axios)
    function fetchCandle(interval, size) {
      return new Promise((resolve, reject) => {
        const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=${interval}&outputsize=${size}&apikey=${TWELVE_KEY}`;
        https.get(url, (r) => {
          let data = '';
          r.on('data', d => data += d);
          r.on('end', () => {
            try {
              const json = JSON.parse(data);
              if (json.status === 'error') return reject(new Error('TwelveData: ' + json.message));
              const candles = json.values.map(v => ({
                o: parseFloat(v.open), h: parseFloat(v.high),
                l: parseFloat(v.low),  c: parseFloat(v.close)
              })).reverse();
              resolve(candles);
            } catch(e) { reject(e); }
          });
        }).on('error', reject);
      });
    }

    // [v5.0] 30 candle per TF — cukup untuk analisis 3TF profesional
    const [c1m, c5m, c15m] = await Promise.all([
      fetchCandle('1min',  30),
      fetchCandle('5min',  30),
      fetchCandle('15min', 30),
    ]);

    // Format 10 candle terakhir per TF untuk prompt GPT
    function fmtC(candles, label) {
      let o = label + '\n';
      candles.slice(-10).forEach((c, i) => {
        o += `${i+1} O:${c.o.toFixed(5)} H:${c.h.toFixed(5)} L:${c.l.toFixed(5)} C:${c.c.toFixed(5)}\n`;
      });
      return o;
    }

    const now       = new Date();
    const target    = new Date(now.getTime() + EXPMIN * 60 * 1000);
    const expiryStr = String(target.getHours()).padStart(2,'0') + ':' + String(target.getMinutes()).padStart(2,'0');
    const data      = fmtC(c15m, 'TF 15m') + fmtC(c5m, 'TF 5m') + fmtC(c1m, 'TF 1m');

    // [v5.0] Prompt diperkaya: minta srLevels + trend5m + biasStrength
    // agar client-side rule engine (checkConfirm) punya data cukup
    const prompt = `Kamu AI scalper profesional binary option ${sym}.
REAL data: ${now.toLocaleTimeString('id-ID')} | Expiry range: ${EXPMIN}–30 menit
${data}
Analisa 3TF mendalam: trend structure, smart money concept, supply demand zone, momentum.
Hanya beri BUY/SELL jika setup jelas dan tervalidasi. Beri SKIP jika market ragu/sideways.
JAWAB JSON saja (tanpa komentar, tanpa markdown):
{"signal":"BUY|SELL|SKIP","confidence":75,"trend15m":"BULLISH|BEARISH|SIDEWAYS","trend5m":"BULLISH|BEARISH|SIDEWAYS","smartmoney":true,"biasStrength":"STRONG|MODERATE|WEAK","srLevels":{"s1":1.15720,"s2":1.15680,"r1":1.15820,"r2":1.15880},"reasonopen":"max 100 char","reasonexpiry":"max 80 char","entryprice":1.15780,"expiry":"${expiryStr}"}`;

    // Call GPT (native https, tanpa axios)
    const gptResult = await new Promise((resolve, reject) => {
      const body = JSON.stringify({
        model: OPENAI_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 320,
        temperature: 0.3
      });
      const urlObj = new URL(OPENAI_URL);
      const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_KEY}`,
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 15000
      };
      const reqHttp = https.request(options, (r) => {
        let d = '';
        r.on('data', chunk => d += chunk);
        r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
      });
      reqHttp.on('error', reject);
      reqHttp.on('timeout', () => reject(new Error('GPT timeout')));
      reqHttp.write(body);
      reqHttp.end();
    });

    const raw = gptResult.choices[0].message.content.trim().replace(/```json|```/g, '').trim();
    const gpt = JSON.parse(raw);
    gpt.expirytarget = expiryStr;

    // [v5.0] Simpan ke pair box cache — 10 candle 1m untuk checkConfirm() client
    const candles1mBox = c1m.slice(-10);
    pairBox[sym] = {
      ts:         Date.now(),
      data:       gpt,
      candles_1m: candles1mBox
    };
    console.log(`[PairBox] ${sym} rebuilt — signal: ${gpt.signal} conf:${gpt.confidence}%`);

    // Catat usage +1
    user.usage_today++;

    res.json({
      ok: true,
      signal:     gpt,
      candles_1m: candles1mBox,
      source:     'fresh',
      usage: user.usage_today, limit, remaining: limit - user.usage_today
    });
  } catch (e) {
    console.error('/bot/signal error:', e.message);
    res.json({ ok: false, error: 'Gagal ambil sinyal: ' + e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// ADMIN ENDPOINTS
// ─────────────────────────────────────────────────────────────────

app.get('/admin/users', adminAuth, (req, res) => {
  const list = Object.entries(users).map(([username, u]) => {
    resetIfNewDay(u);
    return { username, plan: u.plan, is_active: u.is_active, usage_today: u.usage_today, limit: PLAN_LIMIT[u.plan] || 5, created_at: u.created_at };
  });
  res.json({ ok: true, users: list });
});

app.post('/admin/create-user', adminAuth, async (req, res) => {
  try {
    const { username, password, plan = 'free' } = req.body;
    if (!username || !password) return res.json({ ok: false, error: 'Username & password wajib' });
    if (users[username]) return res.json({ ok: false, error: 'Username sudah ada' });
    if (password.length < 6) return res.json({ ok: false, error: 'Password minimal 6 karakter' });
    const passwordHash = await bcrypt.hash(password, 10);
    users[username] = { passwordHash, plan: ['free','pro'].includes(plan) ? plan : 'free', is_active: true, usage_today: 0, last_reset: new Date().toDateString(), created_at: new Date().toISOString() };
    res.json({ ok: true, message: `User "${username}" [${plan.toUpperCase()}] berhasil dibuat!` });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.patch('/admin/set-plan', adminAuth, (req, res) => {
  const { username, plan } = req.body;
  if (!users[username]) return res.json({ ok: false, error: 'User tidak ditemukan' });
  if (!['free','pro'].includes(plan)) return res.json({ ok: false, error: 'Plan tidak valid' });
  users[username].plan = plan;
  res.json({ ok: true, message: `Plan ${username} diubah ke ${plan.toUpperCase()}` });
});

app.patch('/admin/set-active', adminAuth, (req, res) => {
  const { username, is_active } = req.body;
  if (!users[username]) return res.json({ ok: false, error: 'User tidak ditemukan' });
  users[username].is_active = !!is_active;
  res.json({ ok: true, message: `User ${username} ${is_active ? 'diaktifkan' : 'dinonaktifkan'}` });
});

app.patch('/admin/reset-password', adminAuth, async (req, res) => {
  try {
    const { username, new_password } = req.body;
    if (!users[username]) return res.json({ ok: false, error: 'User tidak ditemukan' });
    if (!new_password || new_password.length < 6) return res.json({ ok: false, error: 'Password minimal 6 karakter' });
    users[username].passwordHash = await bcrypt.hash(new_password, 10);
    res.json({ ok: true, message: `Password ${username} berhasil direset` });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.patch('/admin/reset-usage', adminAuth, (req, res) => {
  const { username } = req.body;
  if (!users[username]) return res.json({ ok: false, error: 'User tidak ditemukan' });
  users[username].usage_today = 0;
  users[username].last_reset = new Date().toDateString();
  res.json({ ok: true, message: `Usage ${username} direset ke 0` });
});

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
