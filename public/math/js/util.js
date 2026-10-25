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

/* ------------------------------------------------ 图片放大查看 */
let lightboxEl = null;

/** 关闭大图 */
export function closeImage() {
  if (lightboxEl) {
    lightboxEl.remove();
    lightboxEl = null;
    document.removeEventListener('keydown', onImageKey);
  }
}

function onImageKey(e) {
  if (e.key === 'Escape') closeImage();
}

/** 点作业照片看原图：默认适应屏幕，可切到 1:1 原图并拖动查看 */
export function openImage(src, alt) {
  closeImage();
  const wrap = document.createElement('div');
  wrap.className = 'lightbox';
  wrap.innerHTML = `
    <div class="lb-bar">
      <button class="lb-btn" data-act="zoom">原图 1:1</button>
      <button class="lb-btn" data-act="close">关闭 ✕</button>
    </div>
    <div class="lb-wrap">
      <div class="lb-loading">加载中…</div>
      <img class="lb-img" src="${esc(src)}" alt="${esc(alt || '')}" />
    </div>`;
  document.body.appendChild(wrap);
  lightboxEl = wrap;

  const img = wrap.querySelector('.lb-img');
  const loading = wrap.querySelector('.lb-loading');
  const zoomBtn = wrap.querySelector('[data-act=zoom]');
  let actual = false;

  const finish = () => loading.remove();
  if (img.complete && img.naturalWidth) finish();
  else {
    img.onload = finish;
    img.onerror = () => {
      loading.textContent = '图片加载失败';
    };
  }

  const toggle = () => {
    actual = !actual;
    wrap.classList.toggle('actual', actual);
    zoomBtn.textContent = actual ? '适应屏幕' : '原图 1:1';
    wrap.querySelector('.lb-wrap').scrollTo(0, 0);
  };
  zoomBtn.onclick = (e) => {
    e.stopPropagation();
    toggle();
  };
  wrap.querySelector('[data-act=close]').onclick = (e) => {
    e.stopPropagation();
    closeImage();
  };
  // 点图片切换缩放；点图片以外的空白区关闭
  img.onclick = (e) => {
    e.stopPropagation();
    toggle();
  };
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap || e.target.classList.contains('lb-wrap')) closeImage();
  });
  document.addEventListener('keydown', onImageKey);
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

/**
 * 单行输入弹窗，替代原生 prompt()（原生 prompt 在 iOS 上样式不可控、还会被弹窗拦截）。
 * 返回 Promise<string | null>：点确定返回去空格后的文本，取消/Esc/点遮罩返回 null。
 */
export function promptDialog(opts = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.innerHTML = `
      <div class="modal-card confirm-card" role="dialog" aria-modal="true">
        <h3>${esc(opts.title || '请输入')}</h3>
        ${opts.message ? `<div class="confirm-msg">${esc(opts.message).replace(/\n/g, '<br/>')}</div>` : ''}
        <input type="text" data-act="input" maxlength="${opts.maxlength || 20}"
          placeholder="${esc(opts.placeholder || '')}" value="${esc(opts.value || '')}" />
        <div class="row-end">
          <button class="btn" data-act="no">${esc(opts.cancelText || '取消')}</button>
          <button class="btn primary" data-act="yes">${esc(opts.okText || '确定')}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const input = wrap.querySelector('[data-act=input]');
    let closed = false;
    const done = (v) => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      wrap.remove();
      resolve(v);
    };
    const submit = () => {
      const v = input.value.trim();
      if (!v) {
        input.focus();
        return;
      }
      done(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') done(null);
      else if (e.key === 'Enter') submit();
    };
    wrap.querySelector('[data-act=no]').onclick = () => done(null);
    wrap.querySelector('[data-act=yes]').onclick = submit;
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap) done(null);
    });
    document.addEventListener('keydown', onKey);
    setTimeout(() => {
      input.focus();
      input.select();
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
// iPhone 默认拍的是 HEIC，大模型读不了，得先转成 JPEG。
//
// 两条路，顺序很重要：
//   1. 先让浏览器自己解（Safari / iOS 原生支持 HEIC，连 10-bit HDR 也能解）
//   2. 浏览器解不了（Chrome / Firefox）再用 libheif WASM（1.3MB，按需加载）
//
// 反过来先上 WASM 会踩坑：iPhone 的 HDR 照片是 HEVC Main10，libheif 常常
// 直接抛 ERR_LIBHEIF format not supported —— 但同一张图 Safari 本身能正常显示。

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
        : reject(new Error('转换库加载后没生效'));
    s.onerror = () => reject(new Error('转换库没下载下来（网络问题）'));
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

let heicToLoader = null;

/** 新版 libheif（heic-to，libheif 1.23）。体积大，只有前两层都失败时才加载 */
function loadHeicTo() {
  if (window.HeicTo) return Promise.resolve(window.HeicTo);
  if (heicToLoader) return heicToLoader;
  heicToLoader = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/math/vendor/heic-to.js';
    s.onload = () =>
      window.HeicTo ? resolve(window.HeicTo) : reject(new Error('备用转换库加载后没生效'));
    s.onerror = () => reject(new Error('备用转换库没下载下来（网络问题）'));
    document.head.appendChild(s);
  }).catch((e) => {
    heicToLoader = null;
    throw e;
  });
  return heicToLoader;
}

async function convertHeicToJpegNew(file) {
  const heicTo = await loadHeicTo();
  const blob = await heicTo({ blob: file, type: 'image/jpeg', quality: 0.92 });
  if (!blob) throw new Error('转换结果为空');
  return new File([blob], 'converted.jpg', { type: 'image/jpeg' });
}

/**
 * 客户端压缩 + 统一转成 JPEG；遇到 HEIC 先自动转码。
 */
export function compressImage(file, maxSide = 1600, quality = 0.85) {
  return (async () => {
    if (!isHeicFile(file)) return compressToJpeg(file, maxSide, quality);

    // 1) 浏览器原生解码（Safari 能直接读 HEIC）。补一个 image/heic 的 MIME：
    //    有些相册导出的 File.type 是空的，blob URL 没类型时 Safari 可能不解码。
    try {
      const typed = file.type ? file : new Blob([file], { type: 'image/heic' });
      return await compressToJpeg(typed, maxSide, quality);
    } catch (e) {
      /* 浏览器解不了，走 WASM */
    }

    // 2) libheif WASM（heic2any，1.2MB）。绝大多数 HEIC 到这里就解决了。
    let lastErr = null;
    try {
      const jpg = await convertHeicToJpeg(file);
      return await compressToJpeg(jpg, maxSide, quality);
    } catch (e2) {
      lastErr = e2;
    }

    // 3) 新版 libheif（heic-to，3MB，跟到 libheif 1.23）。
    //    专门兜 iPhone 的 10-bit HDR 这类老版本 libheif 不认的变体。
    try {
      const jpg = await convertHeicToJpegNew(file);
      return await compressToJpeg(jpg, maxSide, quality);
    } catch (e3) {
      lastErr = e3;
    }

    const detail = lastErr && lastErr.message ? lastErr.message : String(lastErr);
    throw new Error(
      `这张 HEIC 照片解不开（${detail}），多半是 iPhone 的 HDR 格式。两个办法：① 在相册里把照片截图一下再传；② iPhone「设置 → 相机 → 格式」改成「兼容性最佳」，以后拍照直接就是 JPG。`,
    );
  })();
}

/**
 * 生成首页列表用的缩略图（320px 小 JPEG）。
 * 复用 compressImage 的 HEIC 转码 + 压缩管线，只是把最长边压到 320、画质更低。
 * 失败返回 null（列表退回用原图），不打断主上传流程。
 */
export async function makeThumb(file) {
  try {
    const jpg = await compressImage(file, 320, 0.6);
    return new File([jpg], 'thumb.jpg', { type: 'image/jpeg' });
  } catch (e) {
    return null;
  }
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

/* ------------------------------------------------ 选范围裁剪（交作业前） */
/**
 * 拍完 / 选完照片后，让用户自己框出要上传的那部分。
 * 只有系统给的这一个框：拖框内移动、拖四角四边改大小；框外拖不动（不会另画一个框，避免手一歪就换框）。
 * 默认框比图片小一圈（四周留一点边），看得出来这是个可以拖的框。
 * 「全选整张」回到整张；「用原图」跳过裁剪；「不用这张」放弃。
 * 返回 Promise<File|null>：null 表示用户放弃这张照片。
 * opts: { title?, index?, total?, skipLabel?, onSkip?, more?, onMore?, raw?, okLabel?, initial? }
 *   skipLabel：「不用这张」的自定义文案（单张上传时用来显示「↻ 重拍 / ↻ 重选」）
 *   onSkip：点「不用这张」时同步回调（还在用户手势里，可以在里面直接调起相机）
 *   more：非空时多显示一个按钮（如「＋ 再拍一张」）——收下这张并继续添加
 *   onMore：点那个按钮时同步回调（只做标记，真正的调起由调用方负责）
 *   raw：传 false 就藏掉「用原图」（重框题目图时不需要「整页当题目图」这种选项）
 *   okLabel：「确定」按钮的文案（重框题目图时显示「保存这张」）
 *   initial：{x,y,w,h} 相对整张图的比例（0~1）。打开时先框出这个范围，
 *           让用户在这个基础上微调，而不是每次都从「整张」开始。
 */
export function cropDialog(file, opts = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal crop-modal';
    const autoTitle =
      opts.total && opts.total > 1
        ? `第 ${opts.index || 1}/${opts.total} 张 · 选要上传的范围`
        : '选要上传的范围';
    const showRaw = opts.raw !== false;
    wrap.innerHTML = `
      <div class="modal-card crop-card" role="dialog" aria-modal="true">
        <h3>${esc(opts.title || autoTitle)}</h3>
        <p class="small muted crop-sub" data-act="sub">${esc(
          opts.hint || '拖这个框可以移动，拖四角或四边改大小，只框住要批改的部分；点「全选整张」恢复整张。',
        )}</p>
        <div class="crop-stage">
          <div class="crop-loading">正在准备图片…</div>
        </div>
        <div class="row wrap crop-ops">
          <button class="btn sm" data-act="full">全选整张</button>
          ${opts.more ? `<button class="btn sm" data-act="more">${esc(opts.more)}</button>` : ''}
          <span class="small muted" data-act="size"></span>
        </div>
        <div class="row-end">
          <button class="btn" data-act="skip">${esc(opts.skipLabel || '不用这张')}</button>
          ${showRaw ? `<button class="btn" data-act="raw">用原图</button>` : ''}
          <button class="btn primary" data-act="ok">${esc(opts.okLabel || '确定')}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    const MIN = 24; // 选区最小边长（屏幕像素）
    const stage = wrap.querySelector('.crop-stage');
    const sizeLabel = wrap.querySelector('[data-act=size]');
    const box = document.createElement('div');
    box.className = 'crop-box hidden';
    box.innerHTML = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
      .map((h) => `<span class="crop-h" data-h="${h}"></span>`)
      .join('');
    stage.appendChild(box);

    let url = null;
    let decoded = null; // 解出来的 JPEG（HEIC 已转好），「用原图」就返回它
    let img = null;
    let W = 0;
    let H = 0;
    let OX = 0;
    let OY = 0; // 图片在舞台里的偏移（图片居中时不为 0）
    let sel = null;
    let drag = null;
    let closed = false;
    let lastRect = null; // 这次框到的范围（相对整张图的比例），挂在返回的 File 上给调用方存起来

    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

    /** 当前选区换算成「相对整张图的比例」{x,y,w,h}，图片等比缩放所以横竖用同一个比例 */
    function rectFrac() {
      if (!img || !sel || !W || !H) return null;
      return { x: sel.x / W, y: sel.y / H, w: sel.w / W, h: sel.h / H };
    }

    function done(v) {
      if (closed) return;
      closed = true;
      if (v && lastRect) {
        try {
          v.__rect = lastRect;
        } catch (e) { /* 挂不上去也不影响裁剪结果 */ }
      }
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      document.removeEventListener('keydown', onKey);
      if (url) {
        try {
          URL.revokeObjectURL(url);
        } catch (e) {
          /* 忽略 */
        }
      }
      wrap.remove();
      resolve(v);
    }

    /** 量出图片实际显示的位置和尺寸（图片居中 / 等比缩放时，和舞台不重合） */
    function measure() {
      if (!img) return;
      const ir = img.getBoundingClientRect();
      const sr = stage.getBoundingClientRect();
      W = ir.width;
      H = ir.height;
      OX = ir.left - sr.left;
      OY = ir.top - sr.top;
    }

    function apply() {
      if (!sel || !W) return;
      box.classList.remove('hidden');
      box.style.left = `${OX + sel.x}px`;
      box.style.top = `${OY + sel.y}px`;
      box.style.width = `${sel.w}px`;
      box.style.height = `${sel.h}px`;
      const sc = (img && img.naturalWidth ? img.naturalWidth : W) / (W || 1);
      sizeLabel.textContent = `选中 ${Math.round(sel.w * sc)} × ${Math.round(sel.h * sc)}`;
    }

    function selectAll() {
      sel = { x: 0, y: 0, w: W, h: H };
      apply();
    }

    /**
     * 默认框：比图片小一圈（四周留一点边）。
     * 铺满整张的话，框边和图片边重合，看不出有个框、也拖不动，用户会以为不能调。
     */
    function defaultSel() {
      // 短边的 4%，最小 6px、最大 24px：手机上不会太窄，电脑上也不会缩太多
      const m = Math.round(clamp(Math.min(W, H) * 0.04, 6, 24));
      sel = { x: m, y: m, w: Math.max(MIN, W - m * 2), h: Math.max(MIN, H - m * 2) };
      apply();
    }

    /**
     * 打开时先框出指定范围（相对整张图的比例），让用户在此基础上微调。
     * 重框题目图时用：系统原来猜的那块先框出来，不对再拖，比从「整张」开始省事。
     */
    function initialSel() {
      const i = opts.initial || {};
      const w = clamp(Math.round((i.w == null ? 1 : i.w) * W), MIN, W);
      const h = clamp(Math.round((i.h == null ? 1 : i.h) * H), MIN, H);
      const x = clamp(Math.round((i.x || 0) * W), 0, W - w);
      const y = clamp(Math.round((i.y || 0) * H), 0, H - h);
      sel = { x, y, w, h };
      apply();
    }

    function onDown(e) {
      if (!img || !W) return;
      if (e.button && e.button !== 0) return;
      measure();
      const h = e.target && e.target.dataset ? e.target.dataset.h : null;
      if (h && sel) {
        drag = { mode: 'resize', h, sx: e.clientX, sy: e.clientY, orig: { ...sel } };
      } else if (e.target === box && sel) {
        drag = { mode: 'move', sx: e.clientX, sy: e.clientY, orig: { ...sel } };
      } else {
        // 框以外的地方不动它：只允许拖系统给的这一个框，
        // 免得拖框时没点准就变成另画一个框（之前这样很容易搞混）
        if (e.preventDefault) e.preventDefault();
        return;
      }
      if (e.preventDefault) e.preventDefault();
    }

    function onMove(e) {
      if (!drag) return;
      const dx = e.clientX - drag.sx;
      const dy = e.clientY - drag.sy;
      if (drag.mode === 'move') {
        sel = {
          ...drag.orig,
          x: clamp(drag.orig.x + dx, 0, W - drag.orig.w),
          y: clamp(drag.orig.y + dy, 0, H - drag.orig.h),
        };
      } else if (drag.mode === 'resize') {
        let { x, y, w, h } = drag.orig;
        const hh = drag.h;
        if (hh.indexOf('w') >= 0) {
          const nx = clamp(x + dx, 0, x + w - MIN);
          w = x + w - nx;
          x = nx;
        }
        if (hh.indexOf('e') >= 0) w = clamp(w + dx, MIN, W - x);
        if (hh.indexOf('n') >= 0) {
          const ny = clamp(y + dy, 0, y + h - MIN);
          h = y + h - ny;
          y = ny;
        }
        if (hh.indexOf('s') >= 0) h = clamp(h + dy, MIN, H - y);
        sel = { x, y, w, h };
      }
      apply();
    }

    function onUp() {
      if (!drag) return;
      drag = null;
      // 拖得太小（比如把手拖过头）就退回整张，别留下一个没法用的小框
      if (!sel || sel.w < MIN || sel.h < MIN) selectAll();
      apply();
    }

    function onKey(e) {
      if (e.key === 'Escape') done(null);
      else if (e.key === 'Enter') doCrop();
    }

    function doCrop() {
      if (!img || !sel) return done(decoded || null);
      lastRect = rectFrac();
      try {
        measure();
        const sc = (img.naturalWidth || W) / (W || 1);
        const sx = Math.round(sel.x * sc);
        const sy = Math.round(sel.y * sc);
        const sw = Math.max(1, Math.round(sel.w * sc));
        const sh = Math.max(1, Math.round(sel.h * sc));
        if (sw >= (img.naturalWidth || sw) - 2 && sh >= (img.naturalHeight || sh) - 2) {
          lastRect = { x: 0, y: 0, w: 1, h: 1 };
          return done(decoded); // 整张就别再压一遍
        }
        const c = document.createElement('canvas');
        c.width = sw;
        c.height = sh;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, sw, sh);
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
        c.toBlob(
          (b) => {
            if (!b) return done(decoded);
            done(new File([b], 'crop.jpg', { type: 'image/jpeg' }));
          },
          'image/jpeg',
          0.92,
        );
      } catch (e) {
        done(decoded);
      }
    }

    wrap.querySelector('[data-act=full]').onclick = selectAll;
    // 「不用这张」：单张上传时这里其实是「重拍 / 重选」，同步回调还在用户手势里，
    // 调用方可以在里面立刻重新调起相机或相册
    wrap.querySelector('[data-act=skip]').onclick = () => {
      if (typeof opts.onSkip === 'function') {
        try {
          opts.onSkip();
        } catch (e) {
          /* 调起失败也不影响关闭 */
        }
      }
      done(null);
    };
    const moreBtn = wrap.querySelector('[data-act=more]');
    if (moreBtn) {
      moreBtn.onclick = () => {
        if (typeof opts.onMore === 'function') {
          try {
            opts.onMore();
          } catch (e) {
            /* 忽略 */
          }
        }
        doCrop();
      };
    }
    const rawBtn = wrap.querySelector('[data-act=raw]');
    if (rawBtn) {
      rawBtn.onclick = () => {
        lastRect = { x: 0, y: 0, w: 1, h: 1 };
        done(decoded);
      };
    }
    wrap.querySelector('[data-act=ok]').onclick = doCrop;
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap) done(null);
    });
    stage.addEventListener('pointerdown', onDown);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    document.addEventListener('keydown', onKey);

    // 先解码（HEIC 会自动转 JPEG），再显示出来让用户框选
    compressImage(file, 1800, 0.92)
      .then((jpg) => {
        decoded = jpg;
        url = URL.createObjectURL(jpg);
        img = new Image();
        img.className = 'crop-img';
        img.onload = () => {
          stage.appendChild(img);
          stage.appendChild(box);
          const ld = stage.querySelector('.crop-loading');
          if (ld) ld.remove();
          measure();
          // 指定了初始范围就按它框（重框题目图），否则默认留一点边，看得出来这是个能拖的框
          if (opts.initial) initialSel();
          else defaultSel();
          box.classList.remove('hidden');
          const okBtn = wrap.querySelector('[data-act=ok]');
          if (okBtn && okBtn.focus) okBtn.focus();
        };
        img.onerror = () => {
          toast('这张图片打不开，换一张试试', 5000);
          done(null);
        };
        img.src = url;
      })
      .catch((e) => {
        toast(e && e.message ? e.message : '这张图片处理失败', 6000);
        done(null);
      });
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

/**
 * 多选项确认框：每个选项是一个带说明的大按钮。
 * options: [{ value, label, hint?, style?: 'primary' | 'danger' }]
 * 返回 Promise<value | null>；点取消 / 点遮罩 / Esc → null。
 */
export function choiceDialog(opts = {}) {
  const options = opts.options || [];
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.innerHTML = `
      <div class="modal-card confirm-card" role="dialog" aria-modal="true">
        <h3>${esc(opts.title || '请确认')}</h3>
        <div class="confirm-msg">${esc(opts.message || '').replace(/\n/g, '<br/>')}</div>
        <div class="choice-list">
          ${options
            .map(
              (o, i) => `<button class="btn choice-btn ${o.style || ''}" data-i="${i}">
                <span class="choice-label">${esc(o.label)}</span>
                ${o.hint ? `<span class="choice-hint">${esc(o.hint)}</span>` : ''}
              </button>`,
            )
            .join('')}
        </div>
        <div class="row-end"><button class="btn" data-act="cancel">${esc(opts.cancelText || '取消')}</button></div>
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
      if (e.key === 'Escape') done(null);
    };
    wrap.querySelectorAll('[data-i]').forEach((b) => {
      b.onclick = () => done(options[Number(b.dataset.i)].value);
    });
    wrap.querySelector('[data-act=cancel]').onclick = () => done(null);
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap) done(null);
    });
    document.addEventListener('keydown', onKey);
  });
}
