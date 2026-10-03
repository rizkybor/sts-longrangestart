# sts-longrangestart

Trigger start dari pistol **Seiko Electronic Flash Starter PS-77** di garis start yang jauh, dikirim lewat internet ke **Buffer-Timer-Start sts-timingsystem**.

```
Seiko PS-77 ─► relay/opto ─► antarmuka USB ─► HP/Laptop (aplikasi web, public/)
                                               │ POST /api/starts  (token starter, antrean offline)
                                               ▼
                                    server sts-longrangestart (server/index.mjs)
                                               │ socket.io "lrs:start"  (token timing + HMAC, di-ack)
                                               ▼
                                    sts-timingsystem (src/services/longrangeCore.js)
                                               │ jam server → jam laptop → jam RaceTime2
                                               ▼
                         Buffer-Timer-Start + baris "LR…" di live feed → operator tekan tombol BIB
```

## Komponen

| Bagian | Isi |
|---|---|
| `public/` | Aplikasi web (PWA) di garis start. Desainnya mengikuti sts-photofinish / sts-timingsystem. |
| `server/index.mjs` | Server perantara: menerima start dari HP, menyimpan (`data/starts.jsonl`), meneruskan ke sts-timingsystem, dan mengirim ulang bila timing sempat offline. |
| `firmware/ps77_trigger/` | Sketch Arduino Pro Micro: kontak PS-77 → tombol F9 (HID) + baris serial. |
| sts-timingsystem `feat/longrange-start` | Klien penerima: `longrangeCore.js`, `longrangeMain.js`, `longrange.js`, `LongrangeBadge.vue`, `serialPortMixin.js`. Lihat `app/LONGRANGE.md` di repo itu. |

## Menjalankan server

```bash
npm install
npm run secrets          # cetak token & HMAC untuk .env server dan sts-timingsystem
cp .env.example .env     # tempel nilai dari langkah sebelumnya
npm start                # http://localhost:4200
```

Aplikasi web disajikan oleh server yang sama. Buka `https://<domain>/` di HP/Laptop garis start, lalu di **Pengaturan** isi *URL server* dan *Token starter*.

### Deploy (VPS, harus HTTPS)

HTTPS wajib dipakai: Web Serial, wake lock, service worker, dan instalasi PWA di HP butuh secure context. Contoh Nginx (perhatikan header upgrade untuk socket.io):

```nginx
server {
  server_name start.domain.com;
  location / {
    proxy_pass http://127.0.0.1:4200;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
  }
}
```

Jalankan dengan `LRS_HOST=127.0.0.1`, lalu pasang sertifikat dengan certbot. Gunakan PM2/systemd agar server hidup lagi setelah reboot.

## Di sts-timingsystem

Isi `app/.env` (dev) atau `<userData>/longrange.json` (aplikasi terpasang):

```
LRS_API_URL=https://start.domain.com
LRS_TIMING_TOKEN=<sama dengan server>
LRS_HMAC_SECRET=<sama dengan server>
LRS_TRIM_MS=0
```

Di panel **Buffer-Timer-Start** akan muncul badge **Long Range Start Terhubung**. Setiap tembakan pistol:
- mengisi kolom *Get Time Start*,
- menambah baris `LR…` di live feed,
- memunculkan notifikasi berisi race/wave.

Operator lalu menekan **BIB** seperti biasa. RECALL mengosongkan kolom itu bila waktunya belum dipakai.

## Basis waktu (penting)

Waktu resmi di sts-timingsystem mengikuti **jam RaceTime2**. Konversinya:

1. **HP → server**: aplikasi menyinkronkan jam ke `GET /api/time` (8 sampel, dipilih RTT terkecil, diulang tiap 5 menit). Waktu start dikirim dalam jam server.
2. **Server → laptop timing**: klien timing melakukan ping-pong `clock:ping` (tiap 60 detik).
3. **Laptop → RaceTime2**:
   - Bila RaceTime2 mengirim frame START **berwaktu** (heartbeat), offsetnya dihitung otomatis. Badge menampilkan "jam RaceTime2".
   - Bila frame-nya *bare* (seperti di lapangan saat ini), dipakai **jam lokal laptop**. Badge menampilkan "jam laptop".
   - **Kalibrasi manual** (paling diutamakan): klik badge **Long Range Start** di sts-timingsystem. Kalibrasi ini **tersinkron dengan STS Photo Finish**: kalibrasi terbaru di salah satu aplikasi berlaku untuk keduanya (chip *Dari Photo Finish* bila asalnya dari sana). Ada jam berjalan untuk dibandingkan dengan RaceTime2, tombol **SET** ke waktu RaceTime2, trim ±ms, dan *Hitung ulang* start terakhir. Kalibrasi tersimpan setelah aplikasi dibuka ulang. Detailnya di `app/LONGRANGE.md`.

   sts-timingsystem mengirim status jam kalibrasinya ke server (`timing:clock-state`). Karena itu **semua waktu di aplikasi garis start memakai basis RaceTime2 hasil kalibrasi**:
   - **Panel Buffer-Timer-Start** menampilkan **Jam Long Range yang berjalan**, sama dengan jam di modal kalibrasi sts-timingsystem. Di bawahnya ada chip kalibrasi: basis, trim, selisih dengan server, waktu kalibrasi, dan ketelitian.
   - Saat pistol ditembakkan, angka **ditahan** di waktu start (latar merah) selama 10 detik, lalu jam berjalan lagi. Start terakhir tetap tertulis di bawah jam.
   - Jam navbar memakai tag **RT2**.

   Waktu di riwayat diberi label:
   - **RaceTime2**: waktu resmi yang sudah diterima timing. Ikut berubah bila timing menekan *Hitung ulang*.
   - **perkiraan**: start belum diterima timing, dihitung dengan kalibrasi terakhir yang diketahui.
   - **jam server**: kalibrasi timing belum pernah diterima (timing belum pernah tersambung).

   Jam server tetap ditampilkan kecil sebagai pembanding.

Ketelitian ≈ latensi USB (1–8 ms) + ±RTT/2 sinkron HP + ±RTT/2 sinkron timing. Angka RTT terlihat di aplikasi (kartu *Sinkron Jam*) dan di tooltip badge timing.

## Aplikasi di garis start

- **Mode input:**
  - **USB HID**: Pro Micro atau foot-switch. Jalan di Android lewat OTG dan di semua browser laptop.
  - **USB Serial sinyal**: kontak di DTR→CTS/DSR/DCD/RI.
  - **USB Serial data**: Arduino.
  - Kedua mode Serial hanya jalan di Chrome/Edge desktop.
- **ARM → tembak → otomatis DISARM.** Lockout default 3 detik untuk meredam pantulan relay.
- **Status tiap start**: *Antre di perangkat* → *Di server · menunggu timing* → *Diterima timing*.
- **Antrean offline**: start disimpan di perangkat dan dikirim ulang otomatis. Server juga menyimpan dan mengirim ulang ke timing saat tersambung lagi (maksimal `LRS_REDELIVER_HOURS` ke belakang). `startId` membuat kiriman ulang tidak pernah menggandakan start.
- **Kirim TEST**: memeriksa server dan token tanpa mengisi Buffer-Timer-Start, sekaligus menunjukkan apakah timing tersambung.
- **RECALL / false start**, **Wave berikutnya**, **Export CSV**, dan START MANUAL sebagai cadangan.

## API

| Endpoint | Auth | Keterangan |
|---|---|---|
| `GET /api/time` | – | `{ serverTime }` |
| `GET /api/status` | Bearer starter | `{ timingOnline }` |
| `POST /api/starts` | Bearer starter | Payload `sts.start.v1` (lihat `buildPayload()` di `public/app.js`). Wajib: `type` START/RECALL/TEST, `startId` (UUID), `startTimeMs` (jam server), `refStartId` untuk RECALL. Respons `{ delivered, timingOnline, duplicate }` |
| `GET /api/starts` | Bearer starter | 100 start terakhir beserta `deliveredAt` |
| socket.io `lrs:start` | `auth.token` timing | Server → timing, ditandatangani HMAC-SHA256 atas JSON kanonik (kunci terurut), field `sig`. Timing membalas ack `{ ok }`. |
| socket.io `clock:ping` | `auth.token` timing | Ack `{ serverTime }` |

## Perangkat keras

> ⚠️ Jangan menyambungkan rangkaian PS-77 langsung ke USB/mikrokontroler. Selalu lewat **relay atau optocoupler**, dan cocokkan dengan manual output PS-77.

- **Pro Micro (disarankan)**: flash `firmware/ps77_trigger/ps77_trigger.ino`, lalu sambungkan kontak relay/opto ke pin **2** dan **GND**.
- **Adapter USB-serial**: sambungkan kontak antara DTR (pin 4 DB9) dan DSR (pin 6) atau CTS (pin 8).

## Checklist lapangan

- [ ] Server HTTPS bisa dibuka dari HP di garis start (sinyal seluler)
- [ ] Badge **Long Range Start Terhubung** muncul di sts-timingsystem
- [ ] Klik badge Long Range Start → jam Long Range sama dengan layar RaceTime2 (bila tidak: SET + trim)
- [ ] **Kirim TEST** → "TEST OK", dan kartu Timing System menunjukkan *Tersambung*
- [ ] Tembakan uji → kolom *Get Time Start* terisi dan baris `LR…` muncul
- [ ] Matikan data HP, tembak, nyalakan lagi → start tetap sampai dengan waktu asli
- [ ] Export CSV di akhir sesi sebagai cadangan
