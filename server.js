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
const BOX_TTL = parseInt(process.env.BOX_TTL_MIN || '3') * 60 * 1000; // default 3 menit, ubah via env BOX_TTL_MIN

function boxFresh(sym) {
  const b = pairBox[sym];
  return b && (Date.now() - b.ts) < BOX_TTL;
}


// ── TIMEZONE + MARKET HELPERS [v6.0] ─────────────────────────────

// WIB time string konsisten (Asia/Jakarta)
function getWIBStr(dateObj) {
  return dateObj.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hour12: false });
}
function getWIBISOStr(dateObj) {
  // ISO 8601 dengan offset +07:00
  const d = new Date(dateObj.getTime() + 7 * 3600000);
  return d.toISOString().slice(0, 19) + '+07:00';
}

// Cek apakah pasar forex sedang buka
// Forex tutup: Jumat 22:00 UTC (=Sabtu 05:00 WIB) s.d. Minggu 22:00 UTC (=Senin 05:00 WIB)
function isForexMarketOpen() {
  const d    = new Date();
  const day  = d.getUTCDay();          // 0=Sun, 5=Fri, 6=Sat
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (day === 6) return false;                  // Sabtu UTC = tutup seharian
  if (day === 5 && mins >= 22 * 60) return false; // Jumat >= 22:00 UTC
  if (day === 0 && mins < 22 * 60) return false;  // Minggu sebelum 22:00 UTC
  return true;
}

// Anti-overlap: lock per pair saat GPT rebuild berjalan
const pairLock = {}; // { 'EUR/USD': true/false }

// Reset usage harian
function resetIfNewDay(user) {
  const today = new Date().toDateString();
  if (user.last_reset !== today) {
    user.usage_today = 0;
    user.last_reset = today;
  }
}

// Ubah limit via env: LIMIT_FREE dan LIMIT_PRO (Railway → Variables)
// Atau via endpoint /admin/set-plan-limit saat runtime
let PLAN_LIMIT = {
  free: parseInt(process.env.LIMIT_FREE || '10'),
  pro:  parseInt(process.env.LIMIT_PRO  || '30')
};

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
    const EXPMIN = expirymin || 5;

    // [v6.0] Market closed check — jangan panggil GPT saat weekend
    if (!isForexMarketOpen()) {
      return res.json({ ok: false, status: 'SKIP_MARKET_CLOSED', error: 'MARKET CLOSED — Forex tutup akhir pekan' });
    }

    // ── [v5.0] PAIR BOX CACHE — serve shared analysis jika masih fresh ──
    if (boxFresh(sym)) {
      const cached = pairBox[sym];
      const ageS   = Math.round((Date.now() - cached.ts) / 1000);
      // [v6.0] Usage hanya naik jika signal BUY/SELL, bukan SKIP
      const sig = cached.data.signal;
      if (sig === 'BUY' || sig === 'SELL') user.usage_today++;
      return res.json({
        ok: true,
        signal:      cached.data,
        candles_1m:  cached.candles_1m,
        source:      'cache',
        box_age_sec: ageS,
        usage: user.usage_today, limit, remaining: limit - user.usage_today
      });
    }

    // ── BOX STALE: REBUILD ────────────────────────────────────────
    if (!OPENAI_KEY || !TWELVE_KEY) {
      return res.json({ ok: false, error: 'Server belum dikonfigurasi (OPENAI_KEY / TWELVE_KEY kosong)' });
    }

    // [v6.0] Anti-overlap: tolak jika pair sedang dianalisis
    if (pairLock[sym]) {
      return res.json({ ok: false, status: 'SKIP_GPT_IN_PROGRESS', error: 'Analisis sedang berjalan untuk pair ini, coba lagi sebentar' });
    }
    pairLock[sym] = true;

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
    // [v6.0] Expiry dalam WIB (Asia/Jakarta), bukan UTC server
    const expiryStr = getWIBStr(target);
    const nowWIBStr = getWIBStr(now);
    const data      = fmtC(c15m, 'TF 15m') + fmtC(c5m, 'TF 5m') + fmtC(c1m, 'TF 1m');

    const prompt = `Kamu AI scalper profesional binary option ${sym}.
REAL data: ${nowWIBStr} WIB | Expiry range: ${EXPMIN}–30 menit
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

    // [v5.0] Simpan ke pair box cache
    const candles1mBox = c1m.slice(-10);
    pairBox[sym] = { ts: Date.now(), data: gpt, candles_1m: candles1mBox };
    console.log(`[PairBox] ${sym} rebuilt — signal:${gpt.signal} conf:${gpt.confidence}% expiry:${expiryStr} WIB`);

    // [v6.0] Usage hanya naik jika BUY/SELL — SKIP tidak mengurangi kuota
    const finalSig = gpt.signal;
    if (finalSig === 'BUY' || finalSig === 'SELL') {
      user.usage_today++;
      console.log(`[Usage] ${decoded.username} → ${user.usage_today}/${limit} (GPT_PLAN_GENERATED signal=${finalSig})`);
    } else {
      console.log(`[Usage] ${decoded.username} → unchanged (SKIP_NO_SIGNAL)`);
    }

    pairLock[sym] = false;
    res.json({
      ok: true,
      signal:     gpt,
      candles_1m: candles1mBox,
      source:     'fresh',
      usage: user.usage_today, limit, remaining: limit - user.usage_today
    });
  } catch (e) {
    pairLock[sym] = false; // selalu unlock meski error
    console.error('/bot/signal error:', e.message);
    res.json({ ok: false, status: 'GPT_FAILED', error: 'Gagal ambil sinyal: ' + e.message });
  }
});


// ─────────────────────────────────────────────────────────────────
// MOMENTUM PLAN — satu GPT call untuk 2 jam signal plan [v6.0]
// ─────────────────────────────────────────────────────────────────
const momentumPlans = {}; // key = 'sym|trend', value = { plan, ts }
const momentumLock  = {}; // anti-overlap per pair

app.post('/bot/momentum-plan', async (req, res) => {
  try {
    const { token, pair, trend, interval_minutes, duration_hours } = req.body;
    if (!token) return res.json({ ok: false, error: 'Token tidak ada' });

    let decoded;
    try { decoded = jwt.verify(token, JWT_SECRET); }
    catch(e) { return res.json({ ok: false, error: 'Token tidak valid atau expired' }); }

    const user = users[decoded.username];
    if (!user || !user.is_active) return res.json({ ok: false, error: 'Akun tidak aktif' });

    resetIfNewDay(user);
    const limit = PLAN_LIMIT[user.plan] || 5;
    if (user.usage_today >= limit) {
      return res.json({ ok: false, error: `Limit harian habis! (${user.usage_today}/${limit}).`, usage: user.usage_today, limit });
    }

    // Market closed check
    if (!isForexMarketOpen()) {
      return res.json({ ok: false, status: 'SKIP_MARKET_CLOSED', error: 'MARKET CLOSED — Forex tutup akhir pekan' });
    }

    const sym      = pair || 'EUR/USD';
    const trendDir = (trend === 'UP' || trend === 'DOWN') ? trend : 'UP';
    const interval = parseInt(interval_minutes) || 5;
    const durationH = parseFloat(duration_hours) || 2;
    const planKey  = sym + '|' + trendDir;

    // Anti-overlap
    if (momentumLock[planKey]) {
      return res.json({ ok: false, status: 'SKIP_GPT_IN_PROGRESS', error: 'Momentum plan sedang dibuat untuk pair ini' });
    }
    momentumLock[planKey] = true;

    const https = require('https');
    function fetchCandle(iv, size) {
      return new Promise((resolve, reject) => {
        const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=${iv}&outputsize=${size}&apikey=${TWELVE_KEY}`;
        https.get(url, (r) => {
          let data = '';
          r.on('data', d => data += d);
          r.on('end', () => {
            try {
              const j = JSON.parse(data);
              if (j.status === 'error') return reject(new Error('TwelveData: ' + j.message));
              resolve(j.values.map(v => ({ o:parseFloat(v.open),h:parseFloat(v.high),l:parseFloat(v.low),c:parseFloat(v.close) })).reverse());
            } catch(e) { reject(e); }
          });
        }).on('error', reject);
      });
    }

    const [c1m, c5m, c15m] = await Promise.all([
      fetchCandle('1min',15), fetchCandle('5min',15), fetchCandle('15min',15)
    ]);

    // Generate signal timestamps dalam WIB
    const now       = new Date();
    const startMs   = now.getTime() + interval * 60000;
    const endMs     = now.getTime() + durationH * 3600000;
    const totalSig  = Math.floor((endMs - startMs) / (interval * 60000)) + 1;
    const sigTimes  = [];
    for (let i = 0; i < totalSig; i++) {
      sigTimes.push(getWIBISOStr(new Date(startMs + i * interval * 60000)));
    }

    const nowWIBStr = getWIBStr(now);
    const snapshotRow = (candles, label) => {
      const last = candles[candles.length - 1];
      return `${label} last: O:${last.o.toFixed(5)} H:${last.h.toFixed(5)} L:${last.l.toFixed(5)} C:${last.c.toFixed(5)}`;
    };
    const snapshot = [snapshotRow(c15m,'15m'), snapshotRow(c5m,'5m'), snapshotRow(c1m,'1m')].join(' | ');

    const prompt = `Kamu AI scalper binary option ${sym}.
Waktu WIB: ${nowWIBStr} | Trend ditetapkan user: ${trendDir === 'UP' ? 'NAIK (BULLISH)' : 'TURUN (BEARISH)'}
Snapshot market: ${snapshot}

Buat signal plan ${durationH} jam dengan interval ${interval} menit.
Karena trend ${trendDir}, mayoritas signal harus ${trendDir === 'UP' ? 'BUY' : 'SELL'}. Boleh HOLD jika area kurang ideal.
Timestamp WIB yang harus diisi (TEPAT ${totalSig} signal): ${sigTimes.join(', ')}

JAWAB JSON saja:
{"strategy":"MOMENTUM","pair":"${sym}","trend":"${trendDir}","generated_at":"${getWIBISOStr(now)}","valid_from":"${sigTimes[0]}","valid_until":"${sigTimes[sigTimes.length-1]}","timezone":"Asia/Jakarta","interval_minutes":${interval},"signals":[{"time":"${sigTimes[0]}","action":"BUY"}]}`;

    const gptResult = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ model: OPENAI_MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: 1800, temperature: 0.3 });
      const urlObj = new URL(OPENAI_URL);
      const opts = {
        hostname: urlObj.hostname, path: urlObj.pathname, method: 'POST',
        headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${OPENAI_KEY}`, 'Content-Length': Buffer.byteLength(body) },
        timeout: 25000
      };
      const req2 = https.request(opts, (r) => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
      });
      req2.on('error', reject);
      req2.on('timeout', () => reject(new Error('GPT momentum timeout')));
      req2.write(body); req2.end();
    });

    const raw  = gptResult.choices[0].message.content.trim().replace(/\`\`\`json|\`\`\`/g, '').trim();
    const plan = JSON.parse(raw);

    // Validasi output
    if (!plan || plan.strategy !== 'MOMENTUM' || !Array.isArray(plan.signals) || plan.signals.length < 1) {
      momentumLock[planKey] = false;
      return res.json({ ok: false, status: 'GPT_FAILED', error: 'Output GPT tidak valid atau tidak sesuai format' });
    }
    const validActions = ['BUY','SELL','HOLD'];
    for (const sig of plan.signals) {
      if (!sig.time || !validActions.includes(sig.action)) {
        momentumLock[planKey] = false;
        return res.json({ ok: false, status: 'GPT_FAILED', error: 'Signal dalam plan tidak valid: ' + JSON.stringify(sig) });
      }
    }

    // Simpan plan
    momentumPlans[planKey] = { plan, ts: Date.now() };

    // [v6.0] Usage hanya naik jika ada BUY/SELL dalam plan (bukan semua HOLD)
    const hasActionable = plan.signals.some(s => s.action === 'BUY' || s.action === 'SELL');
    if (hasActionable) {
      user.usage_today++;
      console.log(`[Momentum] ${decoded.username} plan generated ${sym} trend=${trendDir} → usage ${user.usage_today}/${limit}`);
    } else {
      console.log(`[Momentum] ${decoded.username} plan all-HOLD, usage tidak naik`);
    }

    momentumLock[planKey] = false;
    res.json({ ok: true, plan, usage: user.usage_today, limit, remaining: limit - user.usage_today });
  } catch (e) {
    const key = (req.body.pair || 'EUR/USD') + '|' + (req.body.trend || 'UP');
    momentumLock[key] = false;
    console.error('/bot/momentum-plan error:', e.message);
    res.json({ ok: false, status: 'GPT_FAILED', error: 'Gagal generate plan: ' + e.message });
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

// ── ADMIN GPT CONFIG ENDPOINTS [v5.0] ────────────────────────────

// Ubah limit harian FREE dan PRO saat runtime (tanpa redeploy)
// PATCH /admin/set-plan-limit  body: { free: 15, pro: 50 }
app.patch('/admin/set-plan-limit', adminAuth, (req, res) => {
  const { free, pro } = req.body;
  if (free !== undefined) {
    const n = parseInt(free);
    if (isNaN(n) || n < 1) return res.json({ ok: false, error: 'Nilai free tidak valid' });
    PLAN_LIMIT.free = n;
  }
  if (pro !== undefined) {
    const n = parseInt(pro);
    if (isNaN(n) || n < 1) return res.json({ ok: false, error: 'Nilai pro tidak valid' });
    PLAN_LIMIT.pro = n;
  }
  res.json({ ok: true, message: 'Limit berhasil diupdate', plan_limit: PLAN_LIMIT });
});

// Lihat status pair box cache saat ini
// GET /admin/box-status
app.get('/admin/box-status', adminAuth, (req, res) => {
  const now    = Date.now();
  const ttlSec = BOX_TTL / 1000;
  const boxes  = Object.entries(pairBox).map(([sym, b]) => ({
    symbol:      sym,
    signal:      b.data.signal,
    confidence:  b.data.confidence,
    age_sec:     Math.round((now - b.ts) / 1000),
    ttl_sec:     ttlSec,
    fresh:       boxFresh(sym),
    expires_in:  Math.max(0, Math.round((b.ts + BOX_TTL - now) / 1000)) + 's'
  }));
  res.json({ ok: true, box_ttl_sec: ttlSec, plan_limit: PLAN_LIMIT, boxes });
});

// ── 404 HANDLER ──────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ ok: false, error: `Endpoint "${req.method} ${req.path}" tidak ditemukan` });
});

app.listen(PORT, () => {
  console.log(`✅ AVS Bot Server jalan di port ${PORT}`);
  console.log(`🔑 Admin password: ${ADMIN_PASSWORD}`);
  console.log(`📊 Plan limit — FREE: ${PLAN_LIMIT.free} | PRO: ${PLAN_LIMIT.pro}`);
  console.log(`⏱  Box TTL: ${BOX_TTL / 1000}s (env BOX_TTL_MIN=${process.env.BOX_TTL_MIN || '3'})`);
});
