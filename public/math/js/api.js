// 与后端 /math/api 通信
const BASE = '/math/api';

export function getPasscode() {
  return localStorage.getItem('mh_pass') || '';
}
export function setPasscode(v) {
  if (v) localStorage.setItem('mh_pass', v);
  else localStorage.removeItem('mh_pass');
}

/* 当前用户：存在本机 localStorage 里，每台设备各记各的。
   所有请求都带 X-User-Id，后端据此隔离作业/错题/大纲/模型设置。 */
export function getUserId() {
  return localStorage.getItem('mh_uid') || '';
}
export function setUserId(v) {
  if (v) localStorage.setItem('mh_uid', v);
  else localStorage.removeItem('mh_uid');
}

// 请求头和上传都要带，抽出来避免两处写漏
function userHeader(headers) {
  const uid = getUserId();
  if (uid) headers['X-User-Id'] = uid;
  return headers;
}

let onUnauthorized = null;
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

async function request(path, options = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
  const pass = getPasscode();
  if (pass) headers['X-Passcode'] = pass;
  userHeader(headers);
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
    userHeader(headers);
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
