const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Bismilah2026';
const JWT_SECRET = process.env.JWT_SECRET || 'avsgpt2026rahasia123';
const OPENAI_URL = process.env.OPENAI_URL || 'https://lite.koboillm.com/v1/chat/completions';
const OPENAI_KEY = process.env.OPENAI_KEY || 'a99e7352827544e28063d1227ef76a4a';
const TWELVE_KEY = process.env.TWELVE_KEY || 'sk-bbcQ_tgzKrXpMRTPXrxHvg';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'openai/gpt-4o-mini';

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-admin-password', 'Authorization']
}));
app.use(express.json({ limit: '1mb' }));

let users = {};
const PLAN_LIMIT = { free: 10, pro: 30 };

function resetIfNewDay(user) {
  const today = new Date().toDateString();
  if (user.last_reset !== today) {
    user.usage_today = 0;
    user.last_reset = today;
  }
}

function adminAuth(req, res, next) {
  const pass = req.headers['x-admin-password'];
  if (!pass || pass !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'Password admin salah' });
  }
  next();
}

function hhmm(date) {
  return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
}

function diffMinutesFrom(nowRef, hhmmStr) {
  if (!/^\d{2}:\d{2}$/.test(String(hhmmStr || ''))) return null;
  const [h, m] = String(hhmmStr).split(':').map(Number);
  const t = new Date(nowRef.getFullYear(), nowRef.getMonth(), nowRef.getDate(), h, m, 0, 0);
  let diff = (t.getTime() - nowRef.getTime()) / 60000;
  if (diff < -720) diff += 1440;
  return diff;
}

function fetchJson(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout }, (r) => {
      let data = '';
      r.on('data', d => data += d);
      r.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('HTTP timeout')));
  });
}

async function fetchCandle(symbol, interval, size) {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${size}&apikey=${TWELVE_KEY}`;
  const json = await fetchJson(url, 15000);
  if (json.status === 'error') throw new Error('TwelveData: ' + json.message);
  if (!Array.isArray(json.values) || !json.values.length) throw new Error('TwelveData kosong');
  return json.values.map(v => ({
    o: parseFloat(v.open),
    h: parseFloat(v.high),
    l: parseFloat(v.low),
    c: parseFloat(v.close)
  })).reverse();
}

function fmtC(candles, label) {
  let out = label + '\n';
  candles.slice(-8).forEach((c, i) => {
    out += `${i + 1} O:${c.o.toFixed(5)} H:${c.h.toFixed(5)} L:${c.l.toFixed(5)} C:${c.c.toFixed(5)}\n`;
  });
  return out;
}

function parseFirstJson(raw) {
  const cleaned = String(raw || '').replace(/```json|```/gi, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('GPT tidak return JSON valid');
  return JSON.parse(match[0]);
}

function postOpenAI(messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      max_tokens: 320,
      temperature: 0.25,
      response_format: { type: 'json_object' }
    });

    const urlObj = new URL(OPENAI_URL);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: (urlObj.pathname || '/') + (urlObj.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 20000
    };

    const req = https.request(options, (r) => {
      let data = '';
      r.on('data', chunk => data += chunk);
      r.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('GPT timeout')));
    req.write(body);
    req.end();
  });
}

app.get('/health', (req, res) => {
  res.json({ ok: true, message: 'AVS Bot Server aktif', time: new Date().toISOString(), userCount: Object.keys(users).length });
});

app.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
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
    const { token } = req.body || {};
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
    const { token } = req.body || {};
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

app.post('/bot/signal', async (req, res) => {
  try {
    const { token, expirymin, expirymax, symbol } = req.body || {};
    if (!token) return res.json({ ok: false, error: 'Token tidak ada' });
    if (!OPENAI_KEY || !TWELVE_KEY) return res.json({ ok: false, error: 'Server belum dikonfigurasi (OPENAI_KEY / TWELVE_KEY kosong)' });

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (e) {
      return res.json({ ok: false, error: 'Token tidak valid atau expired' });
    }

    const user = users[decoded.username];
    if (!user || !user.is_active) return res.json({ ok: false, error: 'Akun tidak aktif' });

    resetIfNewDay(user);
    const limit = PLAN_LIMIT[user.plan] || 5;
    if (user.usage_today >= limit) {
      return res.json({ ok: false, error: `Limit harian habis! (${user.usage_today}/${limit}). Reset besok jam 00:00.`, usage: user.usage_today, limit });
    }

    const sym = String(symbol || 'EUR/USD').trim();
    const expMin = Math.max(1, parseInt(expirymin || 5, 10));
    const expMax = Math.max(expMin, parseInt(expirymax || 30, 10));

    const [c1m, c5m, c15m] = await Promise.all([
      fetchCandle(sym, '1min', 18),
      fetchCandle(sym, '5min', 18),
      fetchCandle(sym, '15min', 18)
    ]);

    const now = new Date();
    const baseMin = new Date(Math.ceil(now.getTime() / 60000) * 60000);
    const minExpiryDate = new Date(baseMin.getTime() + expMin * 60000);
    const maxExpiryDate = new Date(baseMin.getTime() + expMax * 60000);
    const minStr = hhmm(minExpiryDate);
    const maxStr = hhmm(maxExpiryDate);
    const nowStr = now.toLocaleTimeString('id-ID', { hour12: false });
    const data = fmtC(c15m, 'TF 15m') + fmtC(c5m, 'TF 5m') + fmtC(c1m, 'TF 1m');

    const sysMsg = 'You are a binary options trading signal AI. Always respond with valid JSON only. Allowed signal values: BUY, SELL, HOLD. Use HOLD if market is choppy, late, unclear, weak, or low quality. Required keys: signal, confidence, trend15m, smartmoney, expiry, reasonopen, reasonexpiry, entryprice.';
    const userMsg = `Data ${sym} jam WIB ${nowStr}:\n${data}\nCari setup selektif. Expiry harus antara ${minStr} sampai ${maxStr} (HH:MM WIB, menit bulat). Jangan paksa entry. Jika market chop, telat, atau struktur tidak clean, pilih HOLD. Balas HANYA JSON: {"signal":"HOLD","confidence":65,"trend15m":"BULLISH","smartmoney":true,"expiry":"${minStr}","reasonopen":"setup belum clean","reasonexpiry":"menunggu momentum lebih valid","entryprice":1.15780}`;

    const gptResult = await postOpenAI([
      { role: 'system', content: sysMsg },
      { role: 'user', content: userMsg }
    ]);

    const raw = gptResult?.choices?.[0]?.message?.content;
    if (!raw) throw new Error('Respons GPT kosong');

    const gpt = parseFirstJson(raw);
    gpt.signal = ['BUY', 'SELL', 'HOLD'].includes(String(gpt.signal || '').toUpperCase()) ? String(gpt.signal).toUpperCase() : 'HOLD';
    gpt.confidence = Math.max(0, Math.min(100, parseInt(gpt.confidence || 0, 10) || 0));
    gpt.trend15m = String(gpt.trend15m || 'SIDEWAYS').toUpperCase();
    gpt.smartmoney = !!gpt.smartmoney;
    gpt.reasonopen = String(gpt.reasonopen || 'Analisa server');
    gpt.reasonexpiry = String(gpt.reasonexpiry || 'Expiry disesuaikan dengan kualitas setup');
    gpt.entryprice = Number(gpt.entryprice || c1m[c1m.length - 1].c || 0);

    const gpExp = String(gpt.expiry || '').trim();
    const diffMin = diffMinutesFrom(now, gpExp);
    if (!/^\d{2}:\d{2}$/.test(gpExp) || diffMin == null || diffMin < expMin || diffMin > expMax) {
      gpt.expiry = minStr;
      gpt.reasonexpiry += ' [server-adjusted]';
    }

    if (gpt.signal !== 'HOLD' && gpt.confidence < 60) {
      gpt.signal = 'HOLD';
      gpt.reasonopen = 'Confidence terlalu rendah, ditahan oleh server';
    }

    user.usage_today++;
    res.json({ ok: true, signal: gpt, usage: user.usage_today, limit, remaining: limit - user.usage_today });
  } catch (e) {
    console.error('/bot/signal error:', e.message);
    res.json({ ok: false, error: 'Gagal ambil sinyal: ' + e.message });
  }
});

app.get('/admin/users', adminAuth, (req, res) => {
  const list = Object.entries(users).map(([username, u]) => {
    resetIfNewDay(u);
    return { username, plan: u.plan, is_active: u.is_active, usage_today: u.usage_today, limit: PLAN_LIMIT[u.plan] || 5, created_at: u.created_at };
  });
  res.json({ ok: true, users: list });
});

app.post('/admin/create-user', adminAuth, async (req, res) => {
  try {
    const { username, password, plan = 'free' } = req.body || {};
    if (!username || !password) return res.json({ ok: false, error: 'Username & password wajib' });
    if (users[username]) return res.json({ ok: false, error: 'Username sudah ada' });
    if (String(password).length < 6) return res.json({ ok: false, error: 'Password minimal 6 karakter' });
    const passwordHash = await bcrypt.hash(password, 10);
    users[username] = {
      passwordHash,
      plan: ['free', 'pro'].includes(plan) ? plan : 'free',
      is_active: true,
      usage_today: 0,
      last_reset: new Date().toDateString(),
      created_at: new Date().toISOString()
    };
    res.json({ ok: true, message: `User \"${username}\" [${users[username].plan.toUpperCase()}] berhasil dibuat!` });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.patch('/admin/set-plan', adminAuth, (req, res) => {
  const { username, plan } = req.body || {};
  if (!users[username]) return res.json({ ok: false, error: 'User tidak ditemukan' });
  if (!['free', 'pro'].includes(plan)) return res.json({ ok: false, error: 'Plan tidak valid' });
  users[username].plan = plan;
  res.json({ ok: true, message: `Plan ${username} diubah ke ${plan.toUpperCase()}` });
});

app.patch('/admin/set-active', adminAuth, (req, res) => {
  const { username, is_active } = req.body || {};
  if (!users[username]) return res.json({ ok: false, error: 'User tidak ditemukan' });
  users[username].is_active = !!is_active;
  res.json({ ok: true, message: `User ${username} ${is_active ? 'diaktifkan' : 'dinonaktifkan'}` });
});

app.patch('/admin/reset-password', adminAuth, async (req, res) => {
  try {
    const { username, new_password } = req.body || {};
    if (!users[username]) return res.json({ ok: false, error: 'User tidak ditemukan' });
    if (!new_password || String(new_password).length < 6) return res.json({ ok: false, error: 'Password minimal 6 karakter' });
    users[username].passwordHash = await bcrypt.hash(new_password, 10);
    res.json({ ok: true, message: `Password ${username} berhasil direset` });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.patch('/admin/reset-usage', adminAuth, (req, res) => {
  const { username } = req.body || {};
  if (!users[username]) return res.json({ ok: false, error: 'User tidak ditemukan' });
  users[username].usage_today = 0;
  users[username].last_reset = new Date().toDateString();
  res.json({ ok: true, message: `Usage ${username} direset ke 0` });
});

app.delete('/admin/delete-user', adminAuth, (req, res) => {
  const { username } = req.body || {};
  if (!users[username]) return res.json({ ok: false, error: 'User tidak ditemukan' });
  delete users[username];
  res.json({ ok: true, message: `User ${username} dihapus` });
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: `Endpoint \"${req.method} ${req.path}\" tidak ditemukan` });
});

app.listen(PORT, () => {
  console.log(`AVS Bot Server jalan di port ${PORT}`);
  console.log(`Admin password: ${ADMIN_PASSWORD}`);
});
