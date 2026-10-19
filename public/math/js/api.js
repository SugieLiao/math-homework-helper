// 与后端 /math/api 通信
const BASE = '/math/api';

export function getPasscode() {
  return localStorage.getItem('mh_pass') || '';
}
export function setPasscode(v) {
  if (v) localStorage.setItem('mh_pass', v);
  else localStorage.removeItem('mh_pass');
}

let onUnauthorized = null;
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

async function request(path, options = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
  const pass = getPasscode();
  if (pass) headers['X-Passcode'] = pass;
  let res;
  try {
    res = await fetch(BASE + path, { ...options, headers });
  } catch (e) {
    throw new Error('网络请求失败，检查一下网络');
  }
  if (res.status === 401) {
    if (onUnauthorized) onUnauthorized();
    throw new Error('需要家庭口令');
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw new Error((data && data.error) || `请求失败(${res.status})`);
  return data;
}

export const api = {
  get: (p) => request(p),
  post: (p, body) => request(p, { method: 'POST', body: JSON.stringify(body || {}) }),
  patch: (p, body) => request(p, { method: 'PATCH', body: JSON.stringify(body || {}) }),
  del: (p, body) => request(p, { method: 'DELETE', body: JSON.stringify(body || {}) }),

  async upload(path, file, extra = {}, method = 'POST') {
    const fd = new FormData();
    fd.append('file', file);
    Object.entries(extra).forEach(([k, v]) => fd.append(k, v));
    const headers = {};
    const pass = getPasscode();
    if (pass) headers['X-Passcode'] = pass;
    const res = await fetch(BASE + path, { method, body: fd, headers });
    if (res.status === 401) {
      if (onUnauthorized) onUnauthorized();
      throw new Error('需要家庭口令');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `上传失败(${res.status})`);
    return data;
  },

  imgUrl: (key) => (key ? `${BASE}/img?key=${encodeURIComponent(key)}` : ''),
};
