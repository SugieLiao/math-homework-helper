import { api, setUnauthorizedHandler, setPasscode, getPasscode } from './api.js';
import { esc, nl2br, toast, busy, idle, fmtDate, cropBand, compressImage, isHeicFile, withTimeout } from './util.js';
import { renderQuestion, renderPrint } from './question.js';
import { renderSettings } from './settings.js';
import { renderTextbook } from './textbook.js';

const view = document.getElementById('view');

/* ------------------------------------------------ 口令 */
function showPassModal() {
  document.getElementById('pass-modal').classList.remove('hidden');
  document.getElementById('pass-input').focus();
}
setUnauthorizedHandler(showPassModal);
document.getElementById('pass-ok').addEventListener('click', async () => {
  const v = document.getElementById('pass-input').value.trim();
  try {
    await api.post('/unlock', { passcode: v });
    setPasscode(v);
    document.getElementById('pass-modal').classList.add('hidden');
    toast('已通过验证');
    route();
  } catch (e) {
    toast('口令不对，再试一次');
  }
});

/* ------------------------------------------------ 共享渲染 */
export function masteryBadge(m) {
  return `<span class="badge ${m.tone}">${esc(m.label)}</span>`;
}

export function masteryLine(m) {
  if (!m.variant_selected && !m.variant_done) {
    return `<div class="small muted">举一反三：还没选题 · 做对 ${m.variant_correct}/${m.need} 题即过关</div>`;
  }
  return `<div class="small muted">举一反三：选了 ${m.variant_selected} 题 · 做了 ${m.variant_done} 题 · 做对 ${m.variant_correct} 题（需 ${m.need} 题）</div>`;
}

function qCard(q) {
  const ok = Number(q.is_correct) === 1;
  return `
  <div class="card q-card ${ok ? 'correct' : 'wrong'}" data-q="${q.id}">
    <div class="row wrap">
      <span class="q-no">${esc(q.no)}.</span>
      <span class="badge ${ok ? 'pass' : 'wrong'}">${ok ? '做对了' : '做错了'}</span>
      ${q.knowledge ? `<span class="badge gray">${esc(q.knowledge)}</span>` : ''}
      <span class="spacer"></span>
      ${masteryBadge(q.mastery)}
    </div>
    <div class="stem">${nl2br(q.stem)}</div>
    <div class="answer-line">作答：<b>${esc(q.student_answer || '（空白）')}</b>${ok ? '' : ` &nbsp;·&nbsp; 正确答案：<b>${esc(q.correct_answer)}</b>`}</div>
    ${q.answer_image_key ? `<img class="ans-img" src="${api.imgUrl(q.answer_image_key)}" alt="作答图片" />` : ''}
    ${!ok && q.error_reason ? `<div class="solbox"><div class="t">错在哪里</div><pre class="sol">${esc(q.error_reason)}</pre></div>` : ''}
    ${!ok && q.solution ? `<div class="solbox"><div class="t">正确做法</div><pre class="sol">${esc(q.solution)}</pre></div>` : ''}
    ${masteryLine(q.mastery)}
    <div class="row-end noprint" style="margin-top:10px">
      <button class="btn sm" data-act="edit" data-id="${q.id}">改判</button>
      <button class="btn sm primary" data-act="open" data-id="${q.id}">举一反三</button>
    </div>
  </div>`;
}

/* ------------------------------------------------ 首页 */
const TB_KEY = 'mh_textbook';

async function home(opts = {}) {
  let textbooks = [];
  let units = [];
  try {
    const tbs = await api.get('/textbooks');
    textbooks = tbs.textbooks || [];
  } catch (e) { /* 忽略 */ }
  // 上次选过的教材优先，其次第一本教材
  const remember = localStorage.getItem(TB_KEY) || '';
  let tbId = opts.textbook || (textbooks.some((t) => t.id === remember) ? remember : textbooks[0]?.id || '');
  const lessonFilter = opts.lesson || '';
  try {
    const t = await api.get(tbId ? `/textbook?textbook=${encodeURIComponent(tbId)}` : '/textbook');
    units = t.units || [];
  } catch (e) { /* 大纲拉不到不影响主流程 */ }

  const lessonOptionsFor = (list) =>
    list
      .map(
        (u) =>
          `<optgroup label="${esc(u.name)}">${u.lessons
            .map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`)
            .join('')}</optgroup>`,
      )
      .join('');

  view.innerHTML = `
    <div class="hero">
      <button class="btn primary big" id="btn-shoot">📷 拍照交作业</button>
      <button class="btn primary big" id="btn-album">🖼 从相册选</button>
      <button class="btn big" id="btn-wrong">📕 错题本</button>
      <button class="btn big" id="btn-set">⚙️ 设置</button>
    </div>

    <div class="card">
      <div class="row wrap">
        <label style="min-width:72px">教材</label>
        <select id="tb-pick" style="flex:1;min-width:150px">
          ${textbooks.map((t) => `<option value="${esc(t.id)}" ${t.id === tbId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
        </select>
        <label style="min-width:52px">课文</label>
        <select id="filter-lesson" style="flex:1;min-width:150px">
          <option value="">全部（这本教材的所有课文）</option>
          ${lessonOptionsFor(units)}
        </select>
        <a class="btn sm" href="#/textbook">管理大纲</a>
      </div>
      <div class="hint">选教材和课文，可以只看某一课的作业；默认「全部」= 这本教材的所有课文。</div>
    </div>

    <div class="card">
      <div class="row wrap">
        <label style="min-width:92px">这次作业属于</label>
        <select id="lesson-pick" style="flex:1;min-width:180px">
          <option value="">— 先不选，批改后再归类 —</option>
          ${lessonOptionsFor(units)}
        </select>
      </div>
      <div class="hint">选了以后，这份作业会挂在对应单元/课文下，以后按单元复习时一筛就出来。</div>
    </div>

    <div id="stats" class="stat-grid" style="margin:12px 0"></div>
    <div class="row wrap" style="margin:12px 0">
      <div class="section-title" style="margin:0">作业记录</div>
      <span class="spacer"></span>
      <button class="btn sm" id="btn-select-all">全选</button>
      <button class="btn danger sm" id="btn-del-sel">删除所选</button>
    </div>
    <div id="list"></div>`;

  document.getElementById('btn-shoot').onclick = () => document.getElementById('file-homework').click();
  document.getElementById('btn-album').onclick = () => document.getElementById('file-homework-album').click();
  document.getElementById('btn-wrong').onclick = () => (location.hash = '#/wrong');
  document.getElementById('btn-set').onclick = () => (location.hash = '#/settings');

  // 记得住这次选的教材
  document.getElementById('tb-pick').onchange = async (e) => {
    localStorage.setItem(TB_KEY, e.target.value);
    await home({ textbook: e.target.value });
  };
  document.getElementById('filter-lesson').onchange = async (e) => {
    await home({ textbook: tbId, lesson: e.target.value });
  };

  let data;
  try {
    const qs = lessonFilter
      ? `?lesson=${encodeURIComponent(lessonFilter)}`
      : tbId
        ? `?textbook=${encodeURIComponent(tbId)}`
        : '';
    data = await api.get(`/submissions${qs}`);
  } catch (e) {
    document.getElementById('list').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  const subs = data.submissions || [];
  const total = subs.reduce((a, s) => a + (s.total || 0), 0);
  const wrong = subs.reduce((a, s) => a + (s.wrong || 0), 0);
  const passed = subs.reduce((a, s) => a + (s.passed || 0), 0);
  document.getElementById('stats').innerHTML = `
    <div class="stat"><b>${total}</b><span>累计题目</span></div>
    <div class="stat"><b style="color:var(--wrong)">${wrong}</b><span>做错</span></div>
    <div class="stat"><b style="color:var(--ok)">${passed}</b><span>已过关</span></div>`;

  const list = document.getElementById('list');
  if (!subs.length) {
    list.innerHTML = `<div class="card"><div class="empty">${
      lessonFilter ? '这一课还没有作业记录。' : '还没有作业记录。<br/>点上面「拍照交作业」开始吧。'
    }</div></div>`;
    return;
  }

  // 按「单元 → 课文」分块
  const blocks = [];
  const unitMap = new Map();
  subs.forEach((s) => {
    const uKey = s.unit_id || '__none';
    if (!unitMap.has(uKey)) unitMap.set(uKey, { name: s.unit_name || '未归类', lessons: new Map() });
    const u = unitMap.get(uKey);
    const lKey = s.lesson_id || '__none';
    if (!u.lessons.has(lKey)) u.lessons.set(lKey, { name: s.lesson_name || '未归类', items: [] });
    u.lessons.get(lKey).items.push(s);
  });
  unitMap.forEach((u, uKey) => {
    u.lessons.forEach((l, lKey) => blocks.push({ uKey, uName: u.name, lKey, lName: l.name, items: l.items }));
  });

  const rowHtml = (s, withTag) => `
    <div class="sub-item" style="border-bottom:1px solid var(--line)">
      <input type="checkbox" class="sub-check" data-id="${s.id}" style="width:20px;height:20px;flex:0 0 auto" />
      <a href="#/s/${s.id}" style="display:flex;flex:1;min-width:0;text-decoration:none;color:inherit">
        <img class="sub-thumb" src="${api.imgUrl(s.image_key)}" alt="" />
        <div style="flex:1;min-width:0">
          <div style="font-weight:600">${fmtDate(s.created_at)}</div>
          <div class="small muted">${s.total} 题 · 错 ${s.wrong} 题 · 过关 ${s.passed} 题</div>
          ${withTag && s.lesson_name ? `<div><span class="tag">${esc(s.lesson_name)}</span></div>` : ''}
        </div>
      </a>
      <span class="badge ${s.wrong ? 'wrong' : 'pass'}">${s.wrong ? '有错题' : '全对'}</span>
      <button class="btn danger sm" data-del="${s.id}">删除</button>
    </div>`;

  let html = '';
  let lastUnit = null;
  blocks.forEach((b) => {
    if (b.uKey !== lastUnit) {
      if (lastUnit !== null) html += `</div>`;
      html += `<div class="section-title" style="margin-top:16px">${esc(b.uName)}</div><div class="card" style="padding:0">`;
      lastUnit = b.uKey;
    }
    html += `<div class="row wrap" style="padding:8px 10px 4px;background:#f7f9ff;border-bottom:1px solid var(--line)">
        <b>${esc(b.lName)}</b><span class="small muted" style="margin-left:8px">${b.items.length} 份</span>
      </div>`;
    html += b.items.map((s) => rowHtml(s, false)).join('');
  });
  html += `</div>`;
  list.innerHTML = html;

  const selected = () => Array.from(list.querySelectorAll('.sub-check:checked')).map((c) => c.dataset.id);

  const doDelete = async (ids) => {
    if (!ids.length) return toast('先勾选要删除的作业');
    if (!confirm(`确定删除这 ${ids.length} 份作业？里面的题目、举一反三记录和图片会一起删掉，无法恢复。`)) return;
    busy('删除中…');
    try {
      await api.post('/submissions/batch-delete', { ids });
      idle();
      toast(`已删除 ${ids.length} 份作业`);
      await home(opts);
    } catch (e) {
      idle();
      toast(e.message);
    }
  };

  document.getElementById('btn-del-sel').onclick = () => doDelete(selected());
  document.getElementById('btn-select-all').onclick = () => {
    const boxes = list.querySelectorAll('.sub-check');
    const allChecked = Array.from(boxes).every((b) => b.checked);
    boxes.forEach((b) => (b.checked = !allChecked));
  };
  list.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = () => doDelete([b.dataset.del]);
  });
}

/* ------------------------------------------------ 作业详情 */
async function submission(id) {
  view.innerHTML = `<div class="empty">加载中…</div>`;
  let data;
  try {
    data = await api.get(`/submissions/${id}`);
  } catch (e) {
    view.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  const s = data.submission;
  const qs = data.questions || [];
  let units = [];
  try {
    const t = await api.get('/textbook');
    units = t.units || [];
  } catch (e) { /* 忽略 */ }

  view.innerHTML = `
    <div class="card">
      <div class="row wrap">
        <h2 style="margin:0">${fmtDate(s.created_at)} 的作业</h2>
        <span class="spacer"></span>
        <span class="badge info">${qs.length} 题</span>
        <span class="badge ${qs.filter((q) => !Number(q.is_correct)).length ? 'wrong' : 'pass'}">
          错 ${qs.filter((q) => !Number(q.is_correct)).length} 题</span>
      </div>
      ${s.image_key ? `<img class="ans-img" src="${api.imgUrl(s.image_key)}" alt="作业原图" style="max-height:420px" />` : ''}
      <div class="row wrap" style="margin-top:12px">
        <label style="min-width:92px">属于</label>
        <select id="s-lesson" style="flex:1;min-width:160px">
          <option value="">— 未归类 —</option>
          ${units
            .map(
              (u) =>
                `<optgroup label="${esc(u.name)}">${u.lessons
                  .map(
                    (l) => `<option value="${esc(l.id)}" ${s.lesson_id === l.id ? 'selected' : ''}>${esc(l.name)}</option>`,
                  )
                  .join('')}</optgroup>`,
            )
            .join('')}
        </select>
        <button class="btn sm" id="btn-save-lesson">保存归类</button>
        <span class="spacer"></span>
        <button class="btn danger sm" id="btn-del-sub">删除这份作业</button>
      </div>
    </div>
    <div class="section-title">逐题批改</div>
    ${
      qs.length
        ? ''
        : `<div class="card">
            ${
              s.status === 'error'
                ? `<div class="row wrap"><b style="color:#c0392b">这次没批改成功</b><span class="spacer"></span>
                   <button class="btn primary sm" id="btn-regrade">重新批改</button></div>
                   <div class="hint" style="margin-top:8px;white-space:pre-wrap">${esc(s.error_msg || '原因未知')}</div>`
                : `<div class="row"><span class="muted">${s.status === 'grading' ? '还在批改中…' : '这次没有识别出题目。'}</span>
                   <span class="spacer"></span><button class="btn primary sm" id="btn-regrade">重新批改</button></div>`
            }
          </div>`
    }
    <div id="qlist">${qs.map(qCard).join('')}</div>`;
  const lessonBtn = document.getElementById('btn-save-lesson');
  if (lessonBtn) {
    lessonBtn.onclick = async () => {
      busy('保存中…');
      try {
        await api.patch(`/submissions/${id}`, { lesson_id: document.getElementById('s-lesson').value });
        idle();
        toast('已归类');
      } catch (e) {
        idle();
        toast(e.message);
      }
    };
  }
  const delBtn = document.getElementById('btn-del-sub');
  if (delBtn) {
    delBtn.onclick = async () => {
      if (!confirm('删除这份作业？题目、举一反三记录和图片都会一起删掉，无法恢复。')) return;
      busy('删除中…');
      try {
        await api.del(`/submissions/${id}`);
        idle();
        toast('已删除');
        location.hash = '#/';
      } catch (e) {
        idle();
        toast(e.message);
      }
    };
  }

  const reBtn = document.getElementById('btn-regrade');
  if (reBtn) {
    reBtn.onclick = async () => {
      try {
        busy('老师正在批改…（快速模式约 15～40 秒）');
        await withTimeout(api.post(`/homework/${id}/grade`, {}), 180000);
        idle();
        toast('批改完成');
        await submission(id);
      } catch (e) {
        idle();
        toast(e.message, 8000);
        await submission(id);
      }
    };
  }
  bindCards();
}

/* ------------------------------------------------ 错题本 */
async function wrongBook() {
  view.innerHTML = `<div class="empty">加载中…</div>`;
  let data;
  try {
    data = await api.get('/questions');
  } catch (e) {
    view.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  const all = data.questions || [];
  const unpassed = all.filter((q) => !q.mastery.passed);
  const wrongOnly = all.filter((q) => q.mastery.base_wrong);
  view.innerHTML = `
    <h2>错题本</h2>
    <div class="section-title">还没过关（${unpassed.length}）</div>
    ${unpassed.length ? unpassed.map(qCard).join('') : '<div class="empty">全部过关啦 🎉</div>'}
    <div class="section-title">曾经做错（${wrongOnly.length}）</div>
    ${wrongOnly.length ? wrongOnly.map(qCard).join('') : '<div class="empty">没有错题记录</div>'}`;
  bindCards();
}

/* ------------------------------------------------ 改判弹窗 */
export function editDialog(q) {
  const wrap = document.createElement('div');
  wrap.className = 'modal';
  wrap.innerHTML = `
    <div class="modal-card">
      <h3>改判这道题</h3>
      <div class="field">
        <label>结果</label>
        <div class="row">
          <button class="btn ${Number(q.is_correct) === 1 ? 'ok' : ''}" data-set="1">✔ 判为正确</button>
          <button class="btn ${Number(q.is_correct) === 0 ? 'danger' : ''}" data-set="0">✘ 判为错误</button>
        </div>
      </div>
      <div class="field"><label>题干</label><textarea id="e-stem">${esc(q.stem)}</textarea></div>
      <div class="field"><label>学生作答</label><input type="text" id="e-sa" value="${esc(q.student_answer)}" /></div>
      <div class="field"><label>正确答案</label><input type="text" id="e-ca" value="${esc(q.correct_answer)}" /></div>
      <div class="field"><label>错因分析</label><textarea id="e-er">${esc(q.error_reason)}</textarea></div>
      <div class="field"><label>正确推导</label><textarea id="e-so">${esc(q.solution)}</textarea></div>
      <div class="field"><label>知识点</label><input type="text" id="e-kn" value="${esc(q.knowledge)}" /></div>
      <div class="row-end">
        <button class="btn" data-act="cancel">取消</button>
        <button class="btn primary" data-act="save">保存</button>
      </div>
    </div>`;
  let isCorrect = Number(q.is_correct);
  wrap.querySelectorAll('[data-set]').forEach((b) => {
    b.onclick = () => {
      isCorrect = Number(b.dataset.set);
      wrap.querySelectorAll('[data-set]').forEach((x) => x.classList.remove('ok', 'danger'));
      b.classList.add(isCorrect ? 'ok' : 'danger');
    };
  });
  wrap.querySelector('[data-act=cancel]').onclick = () => wrap.remove();
  wrap.querySelector('[data-act=save]').onclick = async () => {
    busy('保存中…');
    try {
      await api.patch(`/questions/${q.id}`, {
        is_correct: !!isCorrect,
        stem: wrap.querySelector('#e-stem').value,
        student_answer: wrap.querySelector('#e-sa').value,
        correct_answer: wrap.querySelector('#e-ca').value,
        error_reason: wrap.querySelector('#e-er').value,
        solution: wrap.querySelector('#e-so').value,
        knowledge: wrap.querySelector('#e-kn').value,
      });
      toast('已改判');
      wrap.remove();
      route();
    } catch (e) {
      toast(e.message);
    } finally {
      idle();
    }
  };
  document.body.appendChild(wrap);
}

function bindCards() {
  document.querySelectorAll('[data-act=open]').forEach((b) => {
    b.onclick = () => (location.hash = `#/q/${b.dataset.id}`);
  });
  document.querySelectorAll('[data-act=edit]').forEach((b) => {
    b.onclick = async () => {
      const d = await api.get(`/questions/${b.dataset.id}`);
      editDialog(d.question);
    };
  });
}

/* ------------------------------------------------ 上传作业 */
// 两个入口：直接拍照 capture=environment / 从相册选（不带 capture）
const fileInput = document.getElementById('file-homework');
const fileAlbum = document.getElementById('file-homework-album');

async function handleHomeworkFile(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  let subId = null;
  try {
    busy(isHeicFile(file) ? 'HEIC 照片正在转成 JPG…' : '上传中…');
    const small = await compressImage(file);
    const pickEl = document.getElementById('lesson-pick');
    const lessonId = pickEl ? pickEl.value : '';
    const up = await api.upload('/homework/upload', small, lessonId ? { lesson_id: lessonId } : {});
    subId = up.id;
    busy('老师正在批改…（快速模式约 15～40 秒，别关页面）');
    // 批改是长请求，加硬超时，避免界面无限转圈
    const graded = await withTimeout(api.post(`/homework/${up.id}/grade`, {}), 180000);
    // 裁剪每题的作答图（用转码后的 JPEG 裁，HEIC 浏览器解不开）
    const list = graded.questions || [];
    for (let i = 0; i < list.length; i++) {
      const q = list[i];
      if (!q.band) continue;
      const blob = await cropBand(small, q.band);
      if (blob) {
        try {
          await api.upload(`/questions/${q.id}/answer-image`, blob, {});
        } catch (e) { /* 裁剪图失败不影响主流程 */ }
      }
    }
    idle();
    toast(`批改完成，共 ${list.length} 题`);
    location.hash = `#/s/${up.id}`;
  } catch (e) {
    idle();
    toast(e.message, 8000);
    // 让用户能直接看到这次作业的状态和「重新批改」按钮
    if (subId) location.hash = `#/s/${subId}`;
  }
}

fileInput.addEventListener('change', () => handleHomeworkFile(fileInput));
fileAlbum.addEventListener('change', () => handleHomeworkFile(fileAlbum));

/* ------------------------------------------------ 路由 */
async function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  document.querySelectorAll('.topnav a').forEach((a) => {
    const nav = a.dataset.nav;
    const active = nav === '/' ? hash === '/' || hash.startsWith('/s/') || hash.startsWith('/q/') || hash.startsWith('/print/') : hash.startsWith(nav);
    a.classList.toggle('active', active);
  });

  try {
    if (hash === '/' || hash === '') return await home();
    if (hash.startsWith('/textbook/l/')) return await home({ lesson: hash.slice('/textbook/l/'.length) });
    if (hash.startsWith('/textbook')) return await renderTextbook();
    if (hash.startsWith('/s/')) return await submission(hash.slice(3));
    if (hash.startsWith('/q/')) return await renderQuestion(hash.slice(3));
    if (hash.startsWith('/print/')) return await renderPrint(hash.slice(7));
    if (hash.startsWith('/wrong')) return await wrongBook();
    if (hash.startsWith('/settings')) return await renderSettings();
    view.innerHTML = '<div class="empty">页面不存在</div>';
  } catch (e) {
    view.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

window.addEventListener('hashchange', route);
route();
