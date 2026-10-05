// Server STS Long Range Start — perantara HP/Laptop di garis start ↔ sts-timingsystem.
//
//   HP (PS-77) ──HTTP POST /api/starts──► server ──socket.io "lrs:start" (HMAC)──► sts-timingsystem
//                                                        (room "timing", di-ack)    → Buffer-Timer-Start
//
// HTTP (dipakai aplikasi web di garis start):
//   GET  /api/time     → { serverTime }               sinkronisasi jam (NTP-style), tanpa auth
//   GET  /api/status   → { timingOnline, ... }        token starter
//   POST /api/starts   → simpan + teruskan ke timing  token starter (Bearer)
//   GET  /api/starts   → 100 data terakhir            token starter
// Socket.io (dipakai sts-timingsystem, auth.token = LRS_TIMING_TOKEN):
//   server → timing : "lrs:start" (ditandatangani HMAC, timing membalas ack { ok })
//   timing → server : "clock:ping" → ack { serverTime }
//                     "timing:clock-state" { todShiftMs, basis, trimMs, revision, updatedAt, note }  jam kalibrasi (basis RaceTime2)
//                     "timing:recomputed" { startId, time }  start dihitung ulang setelah kalibrasi
//
// Konfigurasi lewat .env / environment — lihat .env.example.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(path.join(root, '.env'));

const cfg = {
  host: process.env.LRS_HOST || '0.0.0.0',
  port: Number(process.env.PORT || process.env.LRS_PORT) || 4200, // PORT diisi otomatis oleh Render/PaaS
  starterToken: process.env.LRS_STARTER_TOKEN || '',
  timingToken: process.env.LRS_TIMING_TOKEN || '',
  hmacSecret: process.env.LRS_HMAC_SECRET || '',
  dataDir: path.resolve(root, process.env.LRS_DATA_DIR || 'data'),
  corsOrigins: (process.env.LRS_CORS_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean),
  redeliverHours: Number(process.env.LRS_REDELIVER_HOURS) || 12,
};
for (const k of ['starterToken', 'timingToken', 'hmacSecret']) {
  if (!cfg[k]) { console.error(`Konfigurasi ${k} kosong — isi .env (lihat .env.example).`); process.exit(1); }
}

const PUBLIC = path.join(root, 'public');
const STARTS_FILE = path.join(cfg.dataDir, 'starts.jsonl');
const DELIVERED_FILE = path.join(cfg.dataDir, 'delivered.log');
const ACK_TIMEOUT_MS = 4000;

// --------------------------------------------------------------- penyimpanan ---

/** startId → record. Append-only di disk agar tidak hilang saat server restart. */
const starts = new Map();
fs.mkdirSync(cfg.dataDir, { recursive: true });
for (const line of readLines(STARTS_FILE)) starts.set(line.startId, line);
// Baris: "<startId>\t<deliveredAt>\t<waktu di timing>" (versi awal hanya startId).
for (const line of readLines(DELIVERED_FILE, false)) {
  const [id, at, time] = line.split('\t');
  const r = starts.get(id);
  if (r) Object.assign(r, { deliveredAt: at || r.deliveredAt || 'restored', timingTime: time || r.timingTime || null });
}

function readLines(file, json = true) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    if (!json) return [l.trim()];
    try { return [JSON.parse(l)]; } catch { return []; }
  });
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

// ---------------------------------------------------------------------- HMAC ---

// Sama dengan canonical() di sts-timingsystem src/services/longrangeCore.js.
function canonical(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map(canonical);
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = canonical(v[k]);
    return out;
  }
  return v;
}
const sign = (payload) => ({ ...payload, sig: crypto.createHmac('sha256', cfg.hmacSecret).update(JSON.stringify(canonical(payload))).digest('hex') });

function tokenOk(given, expected) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ------------------------------------------------------------- validasi start ---

const str = (v, max) => (v === undefined || v === null ? null : String(v).slice(0, max));

function parseStart(p) {
  if (!p || typeof p !== 'object') throw new Error('payload bukan objek');
  if (!/^[0-9a-f-]{36}$/i.test(p.startId || '')) throw new Error('startId tidak valid');
  if (!['START', 'RECALL', 'TEST'].includes(p.type)) throw new Error('type harus START/RECALL/TEST');
  if (!Number.isFinite(p.startTimeMs)) throw new Error('startTimeMs tidak valid');
  if (p.type === 'RECALL' && !/^[0-9a-f-]{36}$/i.test(p.refStartId || '')) throw new Error('RECALL butuh refStartId');
  return {
    type: p.type,
    startId: p.startId,
    refStartId: p.type === 'RECALL' ? p.refStartId : null,
    seq: Number.isInteger(p.seq) ? p.seq : null,
    startTimeMs: Math.round(p.startTimeMs),
    eventName: str(p.eventName, 200),
    raceId: str(p.raceId, 64),
    wave: Number.isInteger(Number(p.wave)) ? Number(p.wave) : null,
    deviceId: str(p.deviceId, 64),
    deviceName: str(p.deviceName, 64),
    inputMode: str(p.inputMode, 32),
    clockSynced: p.clockSynced === true,
    clockRttMs: Number.isFinite(p.clockRttMs) ? p.clockRttMs : null,
  };
}

// ------------------------------------------------------------- kirim ke timing ---

let io;
const timingCount = () => io.sockets.adapter.rooms.get('timing')?.size ?? 0;

/**
 * Jam kalibrasi terakhir dari sts-timingsystem. Jam Buffer-Timer-Start
 * (ms sejak tengah malam) = wrap(jam server + todShiftMs). Diteruskan ke HP
 * lewat /api/status agar semua tampilan waktu memakai basis RaceTime2.
 */
let timingClock = null;
function timingClockPublic() {
  if (!timingClock || !timingCount()) return null;
  return { ...timingClock, ageMs: Date.now() - timingClock.at };
}

function timingMessage(r) {
  return sign({
    type: 'lrs:start',
    kind: r.type,
    startId: r.startId,
    refStartId: r.refStartId,
    startServerMs: r.startTimeMs,
    eventName: r.eventName,
    raceId: r.raceId,
    wave: r.wave,
    deviceName: r.deviceName,
    inputMode: r.inputMode,
    clockSynced: r.clockSynced,
    clockRttMs: r.clockRttMs,
    receivedAt: r.receivedAt,
  });
}

/** true bila minimal satu aplikasi timing membalas ack ok. */
async function deliver(r) {
  if (r.type === 'TEST' || r.deliveredAt || !timingCount()) return !!r.deliveredAt;
  try {
    const acks = await io.to('timing').timeout(ACK_TIMEOUT_MS).emitWithAck('lrs:start', timingMessage(r));
    const ok = acks.find((a) => a && a.ok);
    if (!ok) return false;
    // Waktu Buffer-Timer-Start hasil konversi + kalibrasi di timing (basis RaceTime2).
    r.timingTime = typeof ok.time === 'string' ? ok.time.slice(0, 16) : r.timingTime || null;
  } catch {
    return false; // timeout — dicoba lagi saat timing tersambung ulang
  }
  r.deliveredAt = new Date().toISOString();
  fs.appendFileSync(DELIVERED_FILE, `${r.startId}\t${r.deliveredAt}\t${r.timingTime || ''}\n`);
  log(`→ timing  ${r.type} ${r.startId.slice(0, 8)}${r.timingTime ? ` = ${r.timingTime}` : ''}`);
  return true;
}

async function redeliver() {
  const since = Date.now() - cfg.redeliverHours * 3600_000;
  const pending = [...starts.values()].filter((r) => r.type !== 'TEST' && !r.deliveredAt && Date.parse(r.receivedAt) >= since);
  for (const r of pending.sort((a, b) => a.startTimeMs - b.startTimeMs)) await deliver(r);
}

// ---------------------------------------------------------------------- HTTP ---

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
};

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && (cfg.corsOrigins.includes('*') || cfg.corsOrigins.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
}

const starterAuth = (req) => tokenOk((req.headers.authorization || '').replace(/^Bearer\s+/i, ''), cfg.starterToken);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 32 * 1024) { reject(new Error('payload terlalu besar')); req.destroy(); } });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/time') return send(res, 200, { serverTime: Date.now() });
  if (!starterAuth(req)) return send(res, 401, { error: 'token starter tidak valid' });

  if (url.pathname === '/api/status') {
    return send(res, 200, { ok: true, timingOnline: timingCount(), timingClock: timingClockPublic(), serverTime: Date.now() });
  }

  if (url.pathname === '/api/starts' && req.method === 'GET') {
    return send(res, 200, [...starts.values()].slice(-100).reverse());
  }

  if (url.pathname === '/api/starts' && req.method === 'POST') {
    const receivedAt = Date.now();
    let p;
    try { p = parseStart(JSON.parse(await readBody(req))); } catch (e) { return send(res, 422, { error: e.message }); }

    let r = starts.get(p.startId);
    const duplicate = !!r;
    if (!r) {
      r = { ...p, receivedAt: new Date(receivedAt).toISOString(), transitMs: receivedAt - p.startTimeMs, deliveredAt: null };
      starts.set(r.startId, r);
      fs.appendFileSync(STARTS_FILE, `${JSON.stringify(r)}\n`);
      log(`${r.type.padEnd(6)} race=${r.raceId || '-'} wave=${r.wave ?? '-'} t=${new Date(r.startTimeMs).toISOString()} via=${r.inputMode} dev=${r.deviceName} transit=${r.transitMs}ms`);
    }
    const delivered = await deliver(r);
    return send(res, duplicate ? 200 : 201, { ok: true, duplicate, startId: r.startId, delivered, timingTime: r.timingTime || null, timingOnline: timingCount(), timingClock: timingClockPublic() });
  }

  return send(res, 404, { error: 'not found' });
}

function serveStatic(res, url) {
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  cors(req, res);
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => { console.error(e); send(res, 500, { error: 'server error' }); });
    return;
  }
  serveStatic(res, url);
});

// ----------------------------------------------------------------- socket.io ---

io = new Server(server, { cors: { origin: cfg.corsOrigins.includes('*') ? true : cfg.corsOrigins } });

io.use((socket, next) => (tokenOk(socket.handshake.auth?.token, cfg.timingToken) ? next() : next(new Error('Unauthorized'))));

io.on('connection', (socket) => {
  socket.join('timing');
  log(`timing tersambung (${socket.handshake.address}), total ${timingCount()}`);
  socket.on('clock:ping', (_msg, ack) => typeof ack === 'function' && ack({ ok: true, serverTime: Date.now() }));
  socket.on('timing:clock-state', (st) => {
    if (!st || !Number.isFinite(st.todShiftMs)) return;
    const next = {
      todShiftMs: Math.round(st.todShiftMs),
      basis: String(st.basis || '').slice(0, 16),
      trimMs: Number.isFinite(st.trimMs) ? st.trimMs : 0,
      revision: Number.isInteger(st.revision) ? st.revision : 0,
      updatedAt: typeof st.updatedAt === 'string' ? st.updatedAt.slice(0, 40) : null,
      note: typeof st.note === 'string' ? st.note.slice(0, 80) : null,
      // "photofinish" = kalibrasi terakhir dibuat di STS Photo Finish (disinkronkan timing)
      origin: st.origin === 'photofinish' ? 'photofinish' : 'longrange',
      at: Date.now(),
    };
    if (!timingClock || timingClock.revision !== next.revision || Math.abs(timingClock.todShiftMs - next.todShiftMs) > 1) {
      log(`jam timing: basis=${next.basis} trim=${next.trimMs}ms rev=${next.revision} shift=${next.todShiftMs}ms`);
    }
    timingClock = next;
  });
  socket.on('timing:recomputed', (p) => {
    const r = p && starts.get(p.startId);
    if (!r || typeof p.time !== 'string' || !/^\d{2}:\d{2}:\d{2}\.\d{3}$/.test(p.time)) return;
    r.timingTime = p.time;
    fs.appendFileSync(DELIVERED_FILE, `${r.startId}\t${r.deliveredAt || new Date().toISOString()}\t${r.timingTime}\n`);
    log(`hitung ulang ${r.startId.slice(0, 8)} = ${r.timingTime}`);
  });
  socket.on('disconnect', (reason) => log(`timing terputus (${reason}), total ${timingCount()}`));
  redeliver().catch((e) => console.error('[redeliver]', e));
});

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

server.listen(cfg.port, cfg.host, () => {
  log(`STS Long Range Start → http://${cfg.host}:${cfg.port}  (data: ${path.relative(root, cfg.dataDir) || '.'}, ${starts.size} start dimuat)`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { io.close(); server.close(() => process.exit(0)); });
