// 通用小工具
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function nl2br(s) {
  return esc(s).replace(/\n/g, '<br/>');
}

let toastTimer = null;
export function toast(msg, ms = 2600) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

export function busy(text = '处理中…') {
  const m = document.getElementById('mask');
  document.getElementById('mask-text').textContent = text;
  m.classList.remove('hidden');
}
export function idle() {
  document.getElementById('mask').classList.add('hidden');
}

/**
 * 居中的确认弹窗，替代浏览器的原生 confirm()。
 * 原生 confirm 的位置由浏览器决定（Edge/Chrome 会贴在地址栏下方），CSS 管不了，
 * 所以全部换成自己的弹窗，保证在屏幕正中间。返回 Promise<boolean>。
 */
export function confirmDialog(message, opts = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    const danger = opts.danger !== false;
    wrap.innerHTML = `
      <div class="modal-card confirm-card" role="dialog" aria-modal="true">
        <h3>${esc(opts.title || '请确认')}</h3>
        <div class="confirm-msg">${esc(message).replace(/\n/g, '<br/>')}</div>
        <div class="row-end">
          <button class="btn" data-act="no">${esc(opts.cancelText || '取消')}</button>
          <button class="btn ${danger ? 'danger' : 'primary'}" data-act="yes">${esc(opts.okText || '确定')}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    let closed = false;
    const done = (v) => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      wrap.remove();
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') done(false);
      else if (e.key === 'Enter') done(true);
    };
    wrap.querySelector('[data-act=no]').onclick = () => done(false);
    wrap.querySelector('[data-act=yes]').onclick = () => done(true);
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap) done(false);
    });
    document.addEventListener('keydown', onKey);
    // 焦点放到主按钮上，回车就能确认
    setTimeout(() => {
      const y = wrap.querySelector('[data-act=yes]');
      if (y) y.focus();
    }, 0);
  });
}

export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z'));
  if (isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `今天 ${hh}:${mm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

/** 把图片按纵向百分比区间裁剪出答案区域，返回 Blob */
export function cropBand(file, band) {
  return new Promise((resolve, reject) => {
    if (!band || !Array.isArray(band) || band.length < 2) return resolve(null);
    let y1 = Number(band[0]);
    let y2 = Number(band[1]);
    if (!isFinite(y1) || !isFinite(y2) || y2 <= y1) return resolve(null);
    y1 = Math.max(0, Math.min(100, y1));
    y2 = Math.max(0, Math.min(100, y2));
    if (y2 - y1 < 2) return resolve(null);

    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      try {
        const pad = Math.max(0, Math.round(img.height * 0.012));
        const top = Math.max(0, Math.round((img.height * y1) / 100) - pad);
        const bottom = Math.min(img.height, Math.round((img.height * y2) / 100) + pad);
        const h = bottom - top;
        if (h < 8) { URL.revokeObjectURL(url); return resolve(null); }
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, top, img.width, h, 0, 0, img.width, h);
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(url);
          resolve(blob);
        }, 'image/jpeg', 0.9);
      } catch (e) {
        URL.revokeObjectURL(url);
        resolve(null);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

/* ------------------------------------------------ HEIC 自动转 JPEG */
// iPhone 默认拍的是 HEIC，大模型读不了。这里用 libheif（WASM）在浏览器里解码成 JPEG。
// 库有 1.3MB，只在真遇到 HEIC 时才动态加载，不影响其它场景。

let heicLoader = null;

function loadHeic2Any() {
  if (window.heic2any) return Promise.resolve(window.heic2any);
  if (heicLoader) return heicLoader;
  heicLoader = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/math/vendor/heic2any.min.js';
    s.onload = () =>
      window.heic2any
        ? resolve(window.heic2any)
        : reject(new Error('转换库加载后没生效，请把照片截图后再上传。'));
    s.onerror = () => reject(new Error('转换库没下载下来（网络问题），请把照片截图后再上传。'));
    document.head.appendChild(s);
  }).catch((e) => {
    heicLoader = null; // 允许下次重试
    throw e;
  });
  return heicLoader;
}

export function isHeicFile(file) {
  const name = (file.name || '').toLowerCase();
  const type = (file.type || '').toLowerCase();
  return /\.(heic|heif)$/.test(name) || /hei[cf]/.test(type);
}

async function convertHeicToJpeg(file) {
  const heic2any = await loadHeic2Any();
  const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
  const blob = Array.isArray(out) ? out[0] : out;
  if (!blob) throw new Error('转换结果为空');
  return new File([blob], 'converted.jpg', { type: 'image/jpeg' });
}

/**
 * 客户端压缩 + 统一转成 JPEG；遇到 HEIC 先自动转码。
 */
export function compressImage(file, maxSide = 1600, quality = 0.85) {
  return (async () => {
    let f = file;
    if (isHeicFile(f)) {
      try {
        f = await convertHeicToJpeg(f);
      } catch (e) {
        throw new Error(`没能自动把 HEIC 转成 JPG：${e && e.message ? e.message : e}。请把照片截图后再上传。`);
      }
    }
    return compressToJpeg(f, maxSide, quality);
  })();
}

function compressToJpeg(file, maxSide, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    const fail = () => {
      URL.revokeObjectURL(url);
      reject(
        new Error('这张图片浏览器解码不了（可能已损坏或格式不支持）。换成 JPG / PNG 再试，或者先截图上传。'),
      );
    };
    img.onload = () => {
      try {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(
          (b) => {
            URL.revokeObjectURL(url);
            if (!b) return fail();
            resolve(new File([b], 'homework.jpg', { type: 'image/jpeg' }));
          },
          'image/jpeg',
          quality,
        );
      } catch {
        fail();
      }
    };
    img.onerror = fail;
    img.src = url;
  });
}

/** 给 Promise 加超时，避免长请求把界面卡在「加载中」 */
export function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(message || `等了 ${Math.round(ms / 1000)} 秒还没结果，请稍后点「重新批改」再试一次。`)), ms),
    ),
  ]);
}

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
