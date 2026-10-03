// STS Long Range Start — aplikasi di garis start.
//
// Alur: PS-77 (output start) → relay/opto → antarmuka USB (HID atau USB-serial)
//       → aplikasi ini mencatat waktu (high-res, jam disinkronkan ke server)
//       → POST /api/starts ke server sts-longrangestart (antrean offline + retry)
//       → server meneruskan ke sts-timingsystem → Buffer-Timer-Start.
import { hydrateIcons, icon } from './icons.js';
import { confirmDialog } from './modal.js';

const $ = (id) => document.getElementById(id);
const CFG_KEY = 'sts.lrs.cfg';
const LOG_KEY = 'sts.lrs.log';
const DEV_KEY = 'sts.lrs.deviceId';
const CLOCK_KEY = 'sts.lrs.clock';
const TIMING_CLOCK_KEY = 'sts.lrs.timingClock';
const DAY_MS = 86400000;
const SCHEMA = 'sts.start.v1';

// ---------------------------------------------------------------- config ---

const DEFAULT_CFG = {
  serverUrl: location.protocol.startsWith('http') ? location.origin : '',
  token: '',
  eventName: '',
  raceId: '',
  wave: 1,
  deviceName: '',
  lockoutMs: 3000,
  requireArm: true,
  inputMode: 'hid',
  hotkey: 'F9',
  baud: 115200,
  signal: 'clearToSend',
};

const cfg = { ...DEFAULT_CFG, ...readJson(CFG_KEY, {}) };
const deviceId = localStorage.getItem(DEV_KEY) || (() => {
  const id = `LRS-${uuid().slice(0, 8).toUpperCase()}`;
  safeSet(DEV_KEY, id);
  return id;
})();

function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function safeSet(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { console.warn('storage', e); }
}
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const api = (p) => `${cfg.serverUrl.replace(/\/+$/, '')}${p}`;
const authHeaders = () => (cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {});

// ----------------------------------------------------------------- clock ---

// Waktu dinding saat event terjadi, dihitung dari timestamp performance (monotonic).
const wallFromPerf = (perfTs) => Date.now() - (performance.now() - perfTs);

// Offset terakhir disimpan: start yang terjadi saat offline tetap memakai offset terbaik yang pernah diukur.
const clock = { offsetMs: 0, rttMs: null, synced: false, syncedAt: null, ...readJson(CLOCK_KEY, {}) };
clock.synced = false; // tandai ulang setelah sinkron pertama sesi ini

async function syncClock(samples = 8) {
  if (!cfg.serverUrl) { setSyncStatus('URL server belum diisi.', 'warn'); renderStatus(); return; }
  const results = [];
  let lastErr = null;
  for (let i = 0; i < samples; i++) {
    try {
      const t0 = Date.now();
      const res = await fetch(`${api('/api/time')}?_=${t0}`, { cache: 'no-store' });
      const t1 = Date.now();
      const server = Number((await res.json()).serverTime);
      if (!Number.isFinite(server)) throw new Error('respons tanpa serverTime');
      results.push({ rtt: t1 - t0, offset: server - (t0 + t1) / 2 });
    } catch (e) {
      lastErr = e;
    }
  }
  if (!results.length) {
    setSyncStatus(`Sinkron jam gagal: ${lastErr?.message || 'tidak ada respons'}.`, 'danger');
    renderStatus();
    return;
  }
  // Sampel dengan RTT terkecil paling akurat (NTP-style).
  results.sort((a, b) => a.rtt - b.rtt);
  const best = results[0];
  Object.assign(clock, { offsetMs: Math.round(best.offset), rttMs: best.rtt, synced: true, syncedAt: new Date().toISOString() });
  safeSet(CLOCK_KEY, JSON.stringify(clock));
  setSyncStatus(`Jam tersinkron ke server: offset ${clock.offsetMs} ms, RTT ${clock.rttMs} ms (ketelitian ±${Math.ceil(clock.rttMs / 2)} ms).`, 'success');
  renderStatus();
}
function setSyncStatus(text, level = 'info') {
  const el = $('syncStatus');
  el.hidden = false;
  el.className = `alert alert-${level}`;
  el.textContent = text;
}

// ----------------------------------------------------------- start state ---

let armed = false;
let lastTriggerPerf = -Infinity;
let lockTimer = null;
let log = readJson(LOG_KEY, []);
let seq = log.reduce((m, e) => Math.max(m, e.payload.seq || 0), 0);
const net = { server: null, timingOnline: 0, lastError: null, timingClockLive: false };

// Jam kalibrasi sts-timingsystem (basis RaceTime2): jam Buffer-Timer-Start
// (ms sejak tengah malam) = wrap(jam server + todShiftMs). Disimpan agar tetap
// dipakai saat HP/timing sedang offline (ditandai "terakhir diketahui").
let timingClock = readJson(TIMING_CLOCK_KEY, null);

function updateTimingClock(tc) {
  net.timingClockLive = !!tc;
  if (!tc) return;
  const changed = !timingClock || timingClock.todShiftMs !== tc.todShiftMs || timingClock.revision !== tc.revision;
  timingClock = {
    todShiftMs: tc.todShiftMs, basis: tc.basis, trimMs: tc.trimMs, revision: tc.revision,
    updatedAt: tc.updatedAt || null, note: tc.note || null, origin: tc.origin || 'longrange', at: new Date().toISOString(),
  };
  safeSet(TIMING_CLOCK_KEY, JSON.stringify(timingClock));
  if (changed) {
    renderLog();
    if (lastStart()) showLast(lastStart());
    if (timingClock.revision > 0) toast('info', `Kalibrasi timing diperbarui${timingClock.note ? `: ${timingClock.note}` : ''}.`);
  }
  renderCalibration();
}

function fmtTod(todMs, withMs = true) {
  const t = Math.floor(((todMs % DAY_MS) + DAY_MS) % DAY_MS);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  const base = `${p(Math.floor(t / 3600000))}:${p(Math.floor((t % 3600000) / 60000))}:${p(Math.floor((t % 60000) / 1000))}`;
  return withMs ? `${base}.${p(t % 1000, 3)}` : base;
}

/** jam server (epoch ms) → jam Buffer-Timer-Start menurut kalibrasi timing, atau null. */
const bufferTime = (serverMs, withMs = true) => (timingClock ? fmtTod(serverMs + timingClock.todShiftMs, withMs) : null);

/**
 * Waktu yang ditampilkan untuk satu start, dengan prioritas:
 *   timing   = waktu resmi dari sts-timingsystem (sudah diterima & dikalibrasi)
 *   estimate = perkiraan memakai kalibrasi timing terakhir (belum diterima timing)
 *   server   = jam server/laptop (kalibrasi timing belum pernah diterima)
 */
function displayTime(entry) {
  if (entry.timingTime) return { time: entry.timingTime, kind: 'timing', label: 'RaceTime2' };
  const est = bufferTime(entry.payload.startTimeMs);
  if (est) return { time: est, kind: 'estimate', label: 'perkiraan' };
  return { time: entry.payload.startTimeLocal, kind: 'server', label: 'jam server' };
}

function setArmed(v) {
  armed = v;
  if (v) ensureAudio();
  renderArm();
}

function trigger(source, perfTs, detail = {}) {
  if (cfg.requireArm && !armed) {
    $('lastInfo').textContent = `Trigger dari ${source} diabaikan — belum ARM.`;
    return;
  }
  if (perfTs - lastTriggerPerf < cfg.lockoutMs) return; // pantulan kontak / tekanan ganda
  lastTriggerPerf = perfTs;

  const entry = enqueue(buildPayload('START', wallFromPerf(perfTs), source, detail));

  setArmed(false);
  clearTimeout(lockTimer);
  lockTimer = setTimeout(renderArm, Math.max(0, cfg.lockoutMs - (performance.now() - perfTs)));
  feedback();
  holdStart(entry);
  showLast(entry);
}

function buildPayload(type, deviceTimeMs, source, detail = {}, extra = {}) {
  const startTimeMs = deviceTimeMs + clock.offsetMs;
  return {
    schema: SCHEMA,
    type,
    startId: uuid(),
    seq: ++seq,
    eventName: cfg.eventName,
    raceId: cfg.raceId,
    wave: Number(cfg.wave) || 1,
    deviceId,
    deviceName: cfg.deviceName || deviceId,
    source: 'SEIKO_PS77',
    inputMode: source,
    inputDetail: detail,
    startTimeMs: Math.round(startTimeMs),
    startTimeIso: new Date(startTimeMs).toISOString(),
    startTimeLocal: timeOfDay(startTimeMs),
    deviceTimeMs: Math.round(deviceTimeMs),
    clockOffsetMs: clock.offsetMs,
    clockRttMs: clock.rttMs,
    clockSynced: clock.synced,
    ...extra,
  };
}

function timeOfDay(ms, withMs = true) {
  const d = new Date(ms);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  const base = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return withMs ? `${base}.${p(d.getMilliseconds(), 3)}` : base;
}

const lastStart = () => log.find((e) => e.payload.type === 'START');

// --------------------------------------------------------- outbox/sender ---
//
// Status entri: pending (antre di perangkat) → server (diterima server, timing
// belum menerima) → delivered (diterima sts-timingsystem). failed = ditolak server.

function enqueue(payload) {
  const entry = { payload, status: 'pending', attempts: 0, lastError: null, sentAt: null, deliveredAt: null };
  log.unshift(entry);
  if (log.length > 1000) log.length = 1000;
  persistLog();
  renderLog();
  pump();
  return entry;
}
function persistLog() { safeSet(LOG_KEY, JSON.stringify(log)); }

async function send(entry) {
  if (!cfg.serverUrl) throw new Error('URL server belum diisi');
  entry.attempts += 1;
  const body = JSON.stringify({ ...entry.payload, attempt: entry.attempts, sentAt: new Date().toISOString() });
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(api('/api/starts'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': entry.payload.startId, ...authHeaders() },
      body, signal: ctrl.signal, keepalive: true,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.permanent = res.status >= 400 && res.status < 500 && ![408, 425, 429].includes(res.status);
      throw err;
    }
    net.server = true;
    net.timingOnline = data.timingOnline ?? net.timingOnline;
    updateTimingClock(data.timingClock || null);
    return data;
  } finally {
    clearTimeout(to);
  }
}

let pumping = false;
let retryTimer = null;
async function pump() {
  if (pumping) return;
  pumping = true;
  clearTimeout(retryTimer);
  let backoff = null;
  try {
    // Kirim dari yang paling lama agar urutan di buffer terjaga.
    for (const entry of [...log].reverse()) {
      if (entry.status !== 'pending') continue;
      try {
        const data = await send(entry);
        entry.status = data.delivered ? 'delivered' : 'server';
        entry.sentAt = new Date().toISOString();
        if (data.delivered) entry.deliveredAt = entry.sentAt;
        if (data.timingTime) entry.timingTime = data.timingTime;
        if (entry === lastStart()) showLast(entry);
        entry.lastError = null;
        if (entry.payload.type === 'START') {
          toast(data.delivered ? 'success' : 'warning', data.delivered
            ? `Start diterima sts-timingsystem: ${displayTime(entry).time}.`
            : `Start ${displayTime(entry).time} tersimpan di server — sts-timingsystem belum tersambung, akan diteruskan otomatis.`);
        } else if (entry.payload.type === 'TEST') {
          toast('success', `TEST diterima server. Timing system ${net.timingOnline ? 'tersambung' : 'BELUM tersambung'}.`);
        }
      } catch (e) {
        entry.lastError = e.name === 'AbortError' ? 'timeout' : e.message;
        if (e.permanent) {
          entry.status = 'failed';
          toast('danger', `Ditolak server: ${entry.lastError}`);
        } else {
          net.server = false;
          backoff = Math.min(30000, 1000 * 2 ** Math.min(entry.attempts, 5));
          break;
        }
      } finally {
        persistLog();
        renderLog();
      }
    }
  } finally {
    pumping = false;
  }
  if (backoff) retryTimer = setTimeout(pump, backoff);
}

function retryAll() {
  log.forEach((e) => { if (e.status === 'failed') e.status = 'pending'; });
  persistLog();
  pump();
}

// Pantau server: apakah timing system tersambung, dan apakah start yang masih
// "di server" sudah diterima timing.
async function poll() {
  if (!cfg.serverUrl || !cfg.token) { net.server = null; renderStatus(); return; }
  try {
    const st = await (await fetchOk(api('/api/status'))).json();
    net.server = true;
    net.timingOnline = st.timingOnline;
    updateTimingClock(st.timingClock || null);
    net.lastError = null;
    // Ambil juga waktu yang dihitung ulang timing setelah kalibrasi (start 30 menit terakhir).
    const recent = Date.now() - 30 * 60 * 1000;
    if (log.some((e) => (e.status === 'server' && e.payload.type !== 'TEST') || (e.status === 'delivered' && e.payload.startTimeMs > recent))) {
      const list = await (await fetchOk(api('/api/starts'))).json();
      const delivered = new Map(list.filter((r) => r.deliveredAt).map((r) => [r.startId, r]));
      let changed = false;
      for (const e of log) {
        const r = delivered.get(e.payload.startId);
        if (!r) continue;
        if (e.status === 'server') {
          e.status = 'delivered';
          e.deliveredAt = r.deliveredAt;
          e.timingTime = r.timingTime || null;
          changed = true;
          if (e.payload.type === 'START') toast('success', `Start sudah diterima sts-timingsystem: ${displayTime(e).time}.`);
        } else if (r.timingTime && r.timingTime !== e.timingTime) {
          if (e.timingTime && e.payload.type === 'START') toast('info', `Start dihitung ulang di timing: ${e.timingTime} → ${r.timingTime}.`);
          e.timingTime = r.timingTime;
          changed = true;
        }
      }
      if (changed) {
        persistLog();
        renderLog();
        if (lastStart()) showLast(lastStart());
      }
    }
  } catch (e) {
    net.server = false;
    net.timingClockLive = false;
    net.lastError = e.message;
  }
  renderStatus();
  renderCalibration();
}
async function fetchOk(url) {
  const res = await fetch(url, { headers: authHeaders(), cache: 'no-store' });
  if (!res.ok) throw new Error(res.status === 401 ? 'token starter salah' : `HTTP ${res.status}`);
  return res;
}

// ------------------------------------------------------------ input: HID ---

// Foot-switch USB / Pro Micro / encoder kontak-ke-keyboard mengirim satu tombol.
// event.timeStamp = waktu input diterima browser (resolusi tinggi).
window.addEventListener('keydown', (e) => {
  if (e.target === $('cfgHotkey')) return;
  if (cfg.inputMode !== 'hid' || e.repeat) return;
  if (e.code !== cfg.hotkey && e.key !== cfg.hotkey) return;
  e.preventDefault();
  trigger('hid', e.timeStamp, { key: e.code || e.key });
}, true);

$('cfgHotkey').addEventListener('keydown', (e) => {
  e.preventDefault();
  $('cfgHotkey').value = e.code || e.key;
  saveForm();
});

// --------------------------------------------------------- input: serial ---

const serial = { port: null, reader: null, active: false };

async function connectSerial() {
  if (!('serial' in navigator)) {
    toast('danger', 'Web Serial tidak didukung di browser ini. Pakai Chrome/Edge desktop lewat HTTPS, atau mode USB HID.');
    return;
  }
  try {
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate: Number(cfg.baud) || 115200 });
    serial.port = port;
    serial.active = true;
    const info = port.getInfo?.() || {};
    setInputStatus(`Terhubung ke port serial (VID ${hex(info.usbVendorId)} / PID ${hex(info.usbProductId)}).`, 'ok');
    $('btnConnect').disabled = true;
    $('btnDisconnect').disabled = false;
    if (cfg.inputMode === 'serial-signal') signalLoop(port);
    else dataLoop(port);
  } catch (e) {
    if (e.name !== 'NotFoundError') setInputStatus(`Gagal membuka port: ${e.message}`, 'bad');
  }
}
const hex = (n) => (n == null ? '?' : `0x${n.toString(16).padStart(4, '0')}`);

async function disconnectSerial() {
  serial.active = false;
  try { await serial.reader?.cancel(); } catch { /* sudah tertutup */ }
  try { await serial.port?.close(); } catch { /* sudah tertutup */ }
  serial.port = null;
  serial.reader = null;
  $('btnConnect').disabled = false;
  $('btnDisconnect').disabled = true;
  setInputStatus('Port serial diputus.', 'bad');
}

// Mode sinyal: kontak relay PS-77 menghubungkan DTR/RTS (diset HIGH sebagai sumber)
// ke CTS/DSR/DCD/RI. Perubahan dari kondisi idle = trigger.
async function signalLoop(port) {
  const sig = cfg.signal;
  try {
    await port.setSignals({ dataTerminalReady: true, requestToSend: true });
    const idle = (await port.getSignals())[sig];
    let active = false;
    let polls = 0;
    let windowStart = performance.now();
    let prevPoll = performance.now();
    setInputStatus(`Memantau ${sig} (idle = ${idle ? 'HIGH' : 'LOW'})…`, 'ok');
    while (serial.active && serial.port === port) {
      const s = await port.getSignals();
      const t = performance.now();
      const changed = s[sig] !== idle;
      if (changed && !active) {
        // Edge terjadi di antara poll sebelumnya dan sekarang → ambil titik tengah.
        trigger('serial-signal', (prevPoll + t) / 2, { signal: sig, pollGapMs: +(t - prevPoll).toFixed(2) });
      }
      active = changed;
      prevPoll = t;
      if (++polls % 500 === 0) {
        const rate = 500 / ((t - windowStart) / 1000);
        windowStart = t;
        setInputStatus(`Memantau ${sig} (idle = ${idle ? 'HIGH' : 'LOW'}), ${rate.toFixed(0)} poll/detik, resolusi ≈ ${(1000 / rate).toFixed(1)} ms.`, 'ok');
      }
    }
  } catch (e) {
    if (serial.active) { setInputStatus(`Port error: ${e.message}`, 'bad'); disconnectSerial(); }
  }
}

// Mode data: mikrokontroler mengirim satu baris (mis. "T,<micros>") saat kontak menutup.
// Waktu diambil saat byte pertama baris itu tiba. Baris diawali '#' = heartbeat, diabaikan.
async function dataLoop(port) {
  const decoder = new TextDecoder();
  let buf = '';
  let lineStartPerf = null;
  try {
    while (serial.active && port.readable) {
      serial.reader = port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await serial.reader.read();
          const t = performance.now();
          if (done) break;
          for (const ch of decoder.decode(value, { stream: true })) {
            if (ch === '\n' || ch === '\r') {
              const line = buf.trim();
              if (line && !line.startsWith('#')) trigger('serial-data', lineStartPerf ?? t, { line });
              buf = '';
              lineStartPerf = null;
            } else {
              if (!buf) lineStartPerf = t;
              buf += ch;
            }
          }
        }
      } finally {
        serial.reader.releaseLock();
      }
    }
  } catch (e) {
    if (serial.active) { setInputStatus(`Port error: ${e.message}`, 'bad'); disconnectSerial(); }
  }
}

if ('serial' in navigator) {
  navigator.serial.addEventListener('disconnect', (e) => {
    if (e.target === serial.port) disconnectSerial();
  });
}

const inputState = { text: '–', level: '' };
function setInputStatus(text, level) {
  Object.assign(inputState, { text, level });
  $('inputStatus').textContent = text;
  renderInputPill();
}

// --------------------------------------------------------------- feedback ---

let audioCtx = null;
function ensureAudio() {
  try { audioCtx ??= new AudioContext(); audioCtx.resume(); } catch { /* tanpa suara */ }
}
function feedback() {
  const f = $('flash');
  f.classList.add('on');
  requestAnimationFrame(() => requestAnimationFrame(() => f.classList.remove('on')));
  navigator.vibrate?.([120, 60, 120]);
  if (audioCtx) {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = 1200;
    g.gain.value = 0.2;
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.15);
  }
}

const TOAST_ICON = { success: 'check', warning: 'warning', danger: 'error', info: 'info' };
function toast(variant, text) {
  const el = document.createElement('div');
  el.className = `toast ${variant}`;
  el.innerHTML = `${icon(TOAST_ICON[variant])}<span></span>`;
  el.lastChild.textContent = text;
  $('toasts').append(el);
  setTimeout(() => el.remove(), variant === 'danger' ? 9000 : 5000);
}

let wakeLock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen'); } catch { /* opsional */ }
}
document.addEventListener('visibilitychange', () => { if (!wakeLock || wakeLock.released) keepAwake(); });

// ---------------------------------------------------------------- render ---

function pill(el, cls, text) {
  el.className = `status-pill ${cls}`;
  el.lastElementChild.textContent = text;
}
function stat(id, variant, value, title = '') {
  const el = $(id);
  el.className = `stat-card stat-card--${variant}`;
  el.querySelector('.stat-card__value').textContent = value;
  el.title = title;
}

function renderArm() {
  const locked = performance.now() - lastTriggerPerf < cfg.lockoutMs;
  if (locked) pill($('armState'), 'status-upcoming', 'LOCKOUT');
  else if (armed) pill($('armState'), 'status-live', 'ARMED');
  else if (!cfg.requireArm) pill($('armState'), 'status-success', 'SIAGA');
  else pill($('armState'), 'status-muted', 'DISARMED');
  const btn = $('btnArm');
  btn.lastElementChild.textContent = armed ? 'DISARM' : 'ARM';
  btn.classList.toggle('is-armed', armed);
  btn.disabled = !cfg.requireArm;
  $('btnRecall').disabled = !lastStart();
}

// Angka besar Buffer-Timer-Start = jam Long Range BERJALAN (seperti modal
// kalibrasi di sts-timingsystem). Saat trigger, angka DITAHAN di waktu start
// selama HOLD_MS lalu berjalan lagi; start terakhir tetap di baris info.
const HOLD_MS = 10000;
let hold = { until: 0, entry: null };

function holdStart(entry) {
  hold = { until: performance.now() + HOLD_MS, entry };
}

function showLast(entry) {
  const p = entry.payload;
  const d = displayTime(entry);
  const flags = [
    `${p.type} terakhir ${d.time}`,
    { timing: 'waktu RaceTime2 dari timing', estimate: 'perkiraan kalibrasi timing', server: 'jam server — kalibrasi timing belum diterima' }[d.kind],
    `via ${p.inputMode}`,
  ];
  if (d.kind !== 'server') flags.push(`jam server ${p.startTimeLocal}`);
  if (!p.clockSynced) flags.push('jam belum tersinkron sesi ini');
  $('lastInfo').textContent = flags.join(' · ');
}

function renderStatus() {
  const notAtServer = log.filter((e) => e.status === 'pending' || e.status === 'failed').length;
  const waitingTiming = log.filter((e) => e.status === 'server' && e.payload.type !== 'TEST').length;

  if (net.server === true) stat('statServer', 'success', 'Tersambung', cfg.serverUrl);
  else if (net.server === false) stat('statServer', 'danger', 'Terputus', net.lastError || '');
  else stat('statServer', 'neutral', cfg.serverUrl ? 'Memeriksa…' : 'Belum diatur');

  if (net.server !== true) stat('statTiming', 'neutral', '–');
  else if (net.timingOnline) stat('statTiming', waitingTiming ? 'warning' : 'success', waitingTiming ? `${waitingTiming} menunggu` : 'Tersambung');
  else stat('statTiming', 'danger', waitingTiming ? `Offline · ${waitingTiming} antre` : 'Offline');

  if (clock.synced) stat('statClock', clock.rttMs > 300 ? 'warning' : 'success', `±${Math.ceil(clock.rttMs / 2)} ms`, `offset ${clock.offsetMs} ms`);
  else stat('statClock', 'warning', clock.syncedAt ? 'Offset lama' : 'Belum');

  stat('statQueue', notAtServer ? 'warning' : 'success', String(notAtServer));

  $('navServer').className = `conn ${net.server === true ? 'on' : net.server === false ? 'off' : 'idle'}`;
  $('navServer').innerHTML = icon(net.server === false ? 'wifiOff' : 'wifi');
  $('navServer').title = net.server === true ? 'Server tersambung' : 'Server terputus';
  $('navTiming').className = `conn ${net.server === true && net.timingOnline ? 'on' : net.server === true ? 'off' : 'idle'}`;
  $('navTiming').title = net.timingOnline ? 'sts-timingsystem tersambung' : 'sts-timingsystem belum tersambung';
}

function renderInputPill() {
  const isSerial = cfg.inputMode !== 'hid';
  const ok = isSerial ? !!serial.port : true;
  const label = { hid: 'HID', 'serial-signal': 'Serial sinyal', 'serial-data': 'Serial data' }[cfg.inputMode];
  pill($('inputPill'), ok ? 'status-success' : inputState.level === 'bad' ? 'status-danger' : 'status-upcoming', `${label} · ${ok ? 'siap' : 'belum terhubung'}`);
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const TYPE_PILL = { START: 'status-neutral', RECALL: 'status-upcoming', TEST: 'status-muted' };

function statusCell(e) {
  if (e.status === 'delivered') return ['status-success', 'Diterima timing'];
  if (e.status === 'server') return e.payload.type === 'TEST' ? ['status-success', 'TEST OK'] : ['status-upcoming', 'Di server · menunggu timing'];
  if (e.status === 'failed') return ['status-danger', 'Ditolak'];
  return ['status-upcoming', `Antre di perangkat${e.attempts ? ` (${e.attempts}×)` : ''}`];
}

function renderLog() {
  $('logBody').innerHTML = log.slice(0, 200).map((e, i) => {
    const p = e.payload;
    const d = displayTime(e);
    const [cls, text] = statusCell(e);
    return `<tr>
      <td><span class="time">${esc(d.time)}</span><span class="time-kind ${d.kind === 'timing' ? 'timing' : d.kind}">${esc(d.label)}</span><span class="sub">${d.kind === 'server' ? esc(new Date(p.startTimeMs).toLocaleDateString('id-ID')) : `jam server ${esc(p.startTimeLocal)}`}</span></td>
      <td>${esc(p.raceId || '–')} / ${esc(p.wave)}<span class="sub">${esc(p.deviceName)}</span></td>
      <td><span class="status-pill ${TYPE_PILL[p.type]}">${esc(p.type)}</span></td>
      <td>${esc(p.inputMode)}</td>
      <td><span class="status-pill ${cls}" title="${esc(e.lastError || e.deliveredAt || e.sentAt || '')}"><span class="dot"></span>${esc(text)}</span>
        ${e.lastError ? `<span class="sub">${esc(e.lastError)}</span>` : ''}</td>
      <td>${e.status === 'pending' || e.status === 'failed' ? `<button class="btn btn-sm" data-resend="${i}">${icon('send')}Kirim</button>` : ''}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="empty-row">Belum ada start tercatat.</td></tr>';
  renderStatus();
}

$('logBody').addEventListener('click', (e) => {
  const i = e.target.closest('[data-resend]')?.dataset.resend;
  if (i == null) return;
  log[i].status = 'pending';
  persistLog();
  pump();
});

function renderHeader() {
  $('crumbEvent').textContent = cfg.eventName || 'Event belum diisi';
  $('lblRace').textContent = cfg.raceId || '–';
  $('lblWave').textContent = cfg.wave;
  $('deviceChip').lastElementChild.textContent = cfg.deviceName || deviceId;
}

function renderInputOpts() {
  const isSerial = cfg.inputMode !== 'hid';
  $('hidOpts').hidden = isSerial;
  $('serialOpts').hidden = !isSerial;
  $('signalField').hidden = cfg.inputMode !== 'serial-signal';
  $('serialHint').textContent = cfg.inputMode === 'serial-signal'
    ? 'Kontak relay PS-77 dipasang antara DTR (sumber) dan sinyal yang dipilih. Butuh Chrome/Edge desktop.'
    : 'Mikrokontroler (firmware/ps77_trigger) mengirim satu baris teks saat kontak menutup.';
  if (!isSerial) setInputStatus(`Siap: tembakan PS-77 dibaca sebagai tombol "${cfg.hotkey}". Biarkan halaman ini tetap di depan.`, 'ok');
  else if (!serial.port) setInputStatus(`Klik "Hubungkan perangkat".${'serial' in navigator ? '' : ' Web Serial tidak tersedia di browser ini.'}`, 'warn');
  renderInputPill();
}

// Jam server berjalan di navbar.
// --------------------------------------- jam Long Range + chip kalibrasi ---

const CAL_BASIS = { manual: 'Manual', racetime: 'Heartbeat RaceTime2', laptop: 'Jam laptop timing' };

/** Selisih jam RaceTime2 − jam server (ms, ±12 jam), dari kalibrasi timing. */
function calDiffMs(serverNow) {
  const d = new Date(serverNow);
  const local = serverNow - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  let diff = ((((serverNow + timingClock.todShiftMs) % DAY_MS) - local) % DAY_MS + DAY_MS) % DAY_MS;
  if (diff > DAY_MS / 2) diff -= DAY_MS;
  return diff;
}

function fmtSigned(ms) {
  const sign = ms > 0 ? '+' : ms < 0 ? '−' : '±';
  const a = Math.abs(ms);
  return a >= 1000 ? `${sign}${(a / 1000).toLocaleString('id-ID', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} dtk` : `${sign}${a} ms`;
}

function fmtAgo(iso) {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'baru saja';
  if (s < 3600) return `${Math.floor(s / 60)} mnt lalu`;
  if (s < 86400) return `${Math.floor(s / 3600)} jam lalu`;
  return `${Math.floor(s / 86400)} hari lalu`;
}

/** Chip di bawah jam Long Range — sama seperti modal kalibrasi sts-timingsystem. */
function renderCalibration() {
  const chip = (cls, text, title = '') => `<span class="cal-chip ${cls}" title="${esc(title)}">${esc(text)}</span>`;
  if (!timingClock) {
    $('calChips').innerHTML = chip('cal-chip--warn', 'Kalibrasi timing belum diterima', 'Jam di atas = jam server. Sambungkan sts-timingsystem.');
    return;
  }
  const serverNow = Date.now() + clock.offsetMs;
  const chips = [
    chip(`cal-chip--${timingClock.basis}`, CAL_BASIS[timingClock.basis] || timingClock.basis, 'Basis kalibrasi di sts-timingsystem'),
    chip('', `Trim ${timingClock.trimMs > 0 ? '+' : ''}${timingClock.trimMs ?? 0} ms`),
    chip('', `Selisih server ${fmtSigned(Math.round(calDiffMs(serverNow)))}`, 'Jam RaceTime2 − jam server'),
  ];
  if (timingClock.updatedAt) {
    chips.push(chip('', `Dikalibrasi ${timeOfDay(Date.parse(timingClock.updatedAt))} · ${fmtAgo(timingClock.updatedAt)}`,
      `Revisi ${timingClock.revision}${timingClock.note ? ` · ${timingClock.note}` : ''}`));
  }
  if (timingClock.origin === 'photofinish') {
    chips.push(chip('cal-chip--sync', 'Dari Photo Finish', 'Kalibrasi terakhir dibuat di STS Photo Finish dan diikuti otomatis'));
  }
  if (clock.synced) chips.push(chip('', `Server ±${Math.ceil(clock.rttMs / 2)} ms`, 'Ketelitian sinkron jam HP ke server'));
  if (!net.timingClockLive) chips.push(chip('cal-chip--warn', 'Timing offline · kalibrasi terakhir'));
  $('calChips').innerHTML = chips.join('');
}

// Jam navbar: basis RaceTime2 (kalibrasi timing) bila diketahui, selain itu jam server.
const BASIS_LABEL = { manual: 'kalibrasi manual', racetime: 'heartbeat RaceTime2', laptop: 'jam laptop timing' };
// Jam Long Range berjalan di panel Buffer-Timer-Start (± setiap 47 ms, seperti modal timing).
setInterval(() => {
  const el = $('lastTime');
  const held = hold.entry && performance.now() < hold.until;
  if (held) {
    el.textContent = displayTime(hold.entry).time;
    $('clockLabel').textContent = `${hold.entry.payload.type} tercatat — jam berjalan lagi sebentar lagi`;
  } else {
    const serverNow = Date.now() + clock.offsetMs;
    const rt = bufferTime(serverNow);
    el.textContent = rt || timeOfDay(serverNow);
    $('clockLabel').textContent = rt ? 'Jam Long Range (basis Buffer-Timer-Start)' : 'Jam server (kalibrasi timing belum diterima)';
    el.classList.toggle('is-server', !rt);
  }
  el.classList.toggle('is-held', !!held);
}, 47);

setInterval(() => {
  const serverNow = Date.now() + clock.offsetMs;
  // Format HH:MM:SS.mmm — sama dengan Buffer-Timer-Start.
  const rt = bufferTime(serverNow);
  $('navClock').textContent = rt || timeOfDay(serverNow);
  const tag = $('navClockTag');
  tag.textContent = rt ? 'RT2' : 'SERVER';
  tag.className = `nav-clock__tag${rt ? (net.timingClockLive ? ' is-rt' : ' is-stale') : ''}`;
  $('navClockWrap').title = rt
    ? `Jam RaceTime2 menurut sts-timingsystem (${BASIS_LABEL[timingClock.basis] || timingClock.basis}, trim ${timingClock.trimMs} ms)${net.timingClockLive ? '' : ' — terakhir diketahui, timing sedang offline'}`
    : 'Jam server (kalibrasi timing belum diterima)';
}, 47);

// ---------------------------------------------------------------- wiring ---

const FIELDS = {
  cfgServerUrl: 'serverUrl', cfgToken: 'token', cfgEvent: 'eventName', cfgRace: 'raceId', cfgWave: 'wave',
  cfgDevice: 'deviceName', cfgLockout: 'lockoutMs', cfgInputMode: 'inputMode', cfgHotkey: 'hotkey', cfgBaud: 'baud', cfgSignal: 'signal',
};
function loadForm() {
  for (const [id, key] of Object.entries(FIELDS)) $(id).value = cfg[key];
  $('cfgRequireArm').checked = cfg.requireArm;
}
function saveForm() {
  const prevServer = cfg.serverUrl;
  for (const [id, key] of Object.entries(FIELDS)) cfg[key] = $(id).value.trim();
  cfg.serverUrl = cfg.serverUrl.replace(/\/+$/, '');
  cfg.wave = Math.max(1, Number(cfg.wave) || 1);
  cfg.lockoutMs = Math.max(0, Number(cfg.lockoutMs) || 0);
  cfg.requireArm = $('cfgRequireArm').checked;
  safeSet(CFG_KEY, JSON.stringify(cfg));
  renderHeader();
  renderInputOpts();
  renderArm();
  if (cfg.serverUrl !== prevServer) syncClock();
}

$('btnSave').onclick = () => { saveForm(); toast('info', 'Pengaturan disimpan.'); poll(); pump(); };
$('btnSync').onclick = () => { saveForm(); syncClock(); };
$('btnTestSend').onclick = () => {
  saveForm();
  showLast(enqueue(buildPayload('TEST', Date.now(), 'manual-test')));
};
$('cfgInputMode').onchange = async () => {
  if (serial.port) await disconnectSerial();
  saveForm();
};
for (const id of ['cfgBaud', 'cfgSignal', 'cfgRequireArm']) $(id).onchange = saveForm;

$('btnArm').onclick = () => setArmed(!armed);
$('btnManual').addEventListener('pointerdown', (e) => {
  // pointerdown agar latensi minimum; timeStamp = saat layar disentuh.
  ensureAudio();
  trigger('manual', e.timeStamp, { pointer: e.pointerType });
});
$('btnRecall').onclick = async () => {
  const ref = lastStart();
  if (!ref) return;
  const d = displayTime(ref);
  const ok = await confirmDialog({
    variant: 'warning',
    icon: 'warning',
    title: 'Kirim RECALL / false start?',
    subtitle: cfg.eventName || undefined,
    text: 'Start di bawah akan dibatalkan. sts-timingsystem mengosongkan Buffer-Timer-Start bila waktu ini belum ditetapkan ke BIB.',
    details: [
      ['Waktu start', `${d.time} (${d.label})`, true],
      ['Race', ref.payload.raceId || '–'],
      ['Wave / Heat', String(ref.payload.wave ?? '–')],
      ['Perangkat', ref.payload.deviceName || '–'],
    ],
    note: 'Bila waktu sudah ditetapkan ke BIB, operator timing tetap harus mengubahnya manual.',
    okText: 'Kirim RECALL',
    okIcon: 'warning',
  });
  if (!ok || lastStart() !== ref) return; // start baru masuk saat dialog terbuka → batalkan
  const e = enqueue(buildPayload('RECALL', Date.now(), 'manual', {}, {
    refStartId: ref.payload.startId, raceId: ref.payload.raceId, wave: ref.payload.wave,
  }));
  showLast(e);
  renderArm();
};
$('btnNextWave').onclick = () => {
  cfg.wave = (Number(cfg.wave) || 0) + 1;
  $('cfgWave').value = cfg.wave;
  safeSet(CFG_KEY, JSON.stringify(cfg));
  renderHeader();
};
$('btnConnect').onclick = connectSerial;
$('btnDisconnect').onclick = disconnectSerial;
$('btnRetryAll').onclick = retryAll;
$('btnClearLog').onclick = async () => {
  if (!log.length) return toast('info', 'Riwayat sudah kosong.');
  const open = log.filter((e) => e.status === 'pending' || e.status === 'failed').length;
  const waiting = log.filter((e) => e.status === 'server' && e.payload.type !== 'TEST').length;
  const ok = await confirmDialog({
    variant: 'danger',
    title: 'Hapus semua riwayat?',
    text: open
      ? `${open} start BELUM sampai server dan akan HILANG permanen. Kirim ulang atau Export CSV dulu bila masih diperlukan.`
      : 'Riwayat hanya dihapus dari perangkat ini. Data di server dan sts-timingsystem tidak terhapus.',
    details: [
      ['Total riwayat', String(log.length)],
      ['Belum sampai server', String(open)],
      ['Di server, menunggu timing', String(waiting)],
    ],
    okText: open ? `Hapus, termasuk ${open} yang belum terkirim` : 'Hapus riwayat',
    okIcon: 'del',
  });
  if (!ok) return;
  log = [];
  persistLog();
  renderLog();
  renderArm();
  toast('success', 'Riwayat di perangkat ini dihapus.');
};
$('btnExport').onclick = () => {
  const cols = ['seq', 'type', 'startId', 'refStartId', 'eventName', 'raceId', 'wave', 'startTimeLocal', 'startTimeIso', 'startTimeMs', 'deviceTimeMs', 'clockOffsetMs', 'clockRttMs', 'inputMode', 'deviceName'];
  const rows = [[...cols, 'timingTime', 'status', 'attempts', 'deliveredAt', 'lastError'].join(',')];
  for (const e of [...log].reverse()) {
    rows.push([...cols.map((c) => e.payload[c]), e.timingTime, e.status, e.attempts, e.deliveredAt, e.lastError]
      .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','));
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' }));
  a.download = `starts-${deviceId}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
};

window.addEventListener('online', () => { poll(); pump(); });
window.addEventListener('offline', () => { net.server = false; net.timingClockLive = false; renderStatus(); renderCalibration(); });
setInterval(renderCalibration, 15000); // "x mnt lalu" & selisih tetap segar

// ------------------------------------------------------------------ boot ---

hydrateIcons();
$('year').textContent = new Date().getFullYear();
loadForm();
renderHeader();
renderInputOpts();
renderArm();
renderLog();
renderCalibration();
if (lastStart()) showLast(lastStart());
keepAwake();
syncClock();
poll();
setInterval(syncClock, 5 * 60 * 1000);
setInterval(poll, 5000);
setInterval(pump, 15000);
pump();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
