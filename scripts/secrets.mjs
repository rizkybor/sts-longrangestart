// Cetak secret acak untuk .env server + konfigurasi sts-timingsystem.
import crypto from 'node:crypto';
const r = () => crypto.randomBytes(24).toString('base64url');
const v = { LRS_STARTER_TOKEN: r(), LRS_TIMING_TOKEN: r(), LRS_HMAC_SECRET: r() };
console.log('# --- .env sts-longrangestart');
for (const [k, val] of Object.entries(v)) console.log(`${k}=${val}`);
console.log('\n# --- .env sts-timingsystem/app (atau longrange.json)');
console.log('LRS_API_URL=https://<domain-server-longrangestart>');
console.log(`LRS_TIMING_TOKEN=${v.LRS_TIMING_TOKEN}`);
console.log(`LRS_HMAC_SECRET=${v.LRS_HMAC_SECRET}`);
