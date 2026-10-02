// Dialog konfirmasi berbasis Promise — pengganti confirm() bawaan browser.
// Gaya mengikuti sts-photofinish (components/ui/Modal.vue + UiHost.vue).
//
//   const ok = await confirmDialog({
//     title: 'Kirim RECALL?', text: '…', variant: 'warning',
//     details: [['Waktu start', '10:00:00.123'], ['Race', 'DRR Putra']],
//     okText: 'Kirim RECALL', cancelText: 'Batal',
//   });
//
// variant: 'primary' | 'warning' | 'danger' — menentukan ikon & warna tombol OK.
// Esc / klik di luar / tombol Batal → false. Fokus dikunci di dalam dialog dan
// dikembalikan ke elemen sebelumnya setelah ditutup.
import { icon } from './icons.js';

const VARIANT_ICON = { primary: 'info', warning: 'warning', danger: 'del' };
let active = null;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function confirmDialog(opts) {
  if (active) active.close(false); // hanya satu dialog sekaligus
  const o = { variant: 'primary', okText: 'Ya, lanjutkan', cancelText: 'Batal', ...opts };
  const prevFocus = document.activeElement;
  const titleId = `mdl-title-${Date.now()}`;

  const root = document.createElement('div');
  root.className = 'mdl-backdrop';
  root.innerHTML = `
    <div class="mdl mdl--${esc(o.variant)}" role="alertdialog" aria-modal="true" aria-labelledby="${titleId}" aria-describedby="${titleId}-text">
      <header class="mdl-head">
        <span class="mdl-icon">${icon(o.icon || VARIANT_ICON[o.variant] || 'info', '24')}</span>
        <div class="mdl-head__text">
          <h3 id="${titleId}" class="mdl-title">${esc(o.title)}</h3>
          ${o.subtitle ? `<p class="mdl-subtitle">${esc(o.subtitle)}</p>` : ''}
        </div>
        <button type="button" class="mdl-x" data-act="cancel" aria-label="Tutup">${icon('close', '20')}</button>
      </header>
      <div class="mdl-body">
        <p id="${titleId}-text" class="mdl-text">${esc(o.text)}</p>
        ${o.details?.length ? `<dl class="mdl-details">${o.details.map(([k, v, mono]) => `<div><dt>${esc(k)}</dt><dd class="${mono ? 'mono' : ''}">${esc(v)}</dd></div>`).join('')}</dl>` : ''}
        ${o.note ? `<p class="mdl-note">${icon('info', '16')}<span>${esc(o.note)}</span></p>` : ''}
      </div>
      <footer class="mdl-foot">
        <button type="button" class="btn" data-act="cancel">${esc(o.cancelText)}</button>
        <button type="button" class="btn ${o.variant === 'danger' ? 'btn-danger-solid' : o.variant === 'warning' ? 'btn-warn-solid' : 'btn-primary'}" data-act="ok">
          ${o.okIcon ? icon(o.okIcon) : ''}${esc(o.okText)}
        </button>
      </footer>
    </div>`;

  return new Promise((resolve) => {
    const dialog = root.querySelector('.mdl');
    const focusables = () => [...dialog.querySelectorAll('button, [href], input, select, textarea')].filter((el) => !el.disabled);

    function close(result) {
      if (!active || active.root !== root) return;
      active = null;
      document.removeEventListener('keydown', onKey, true);
      root.classList.remove('is-open');
      setTimeout(() => root.remove(), 160);
      document.body.classList.remove('mdl-lock');
      if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
      resolve(result);
    }

    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(false); return; }
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }

    root.addEventListener('mousedown', (e) => { if (e.target === root) close(false); });
    root.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act) close(act === 'ok');
    });
    document.addEventListener('keydown', onKey, true);

    active = { root, close };
    document.body.append(root);
    document.body.classList.add('mdl-lock');
    requestAnimationFrame(() => root.classList.add('is-open'));
    // Aksi berbahaya: fokus awal di "Batal" agar Enter tidak langsung mengeksekusi.
    root.querySelector(o.variant === 'primary' ? '[data-act="ok"]' : '.mdl-foot [data-act="cancel"]').focus();
  });
}
