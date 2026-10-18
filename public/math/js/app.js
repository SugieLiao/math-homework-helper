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

/* 交作业弹窗：点「拍照 / 相册」时先弹出来，让用户选这次作业归到哪一课，再调起相机 */
let pendingKind = null; // 'shoot' | 'album'
let pendingLessonId = ''; // 弹窗里选定的课文，上传时带给后端

const lessonGroupsHtml = (units) =>
  units
    .map(
      (u) =>
        `<optgroup label="${esc(u.name)}">${u.lessons
          .map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`)
          .join('')}</optgroup>`,
    )
    .join('');

async function fillUploadLessons(tbId, prefer) {
  const sel = document.getElementById('up-lesson');
  const keep = prefer !== undefined ? prefer : sel.value;
  sel.innerHTML = `<option value="">— 先不选，批改后再归类 —</option>`;
  if (!tbId) return;
  try {
    const t = await api.get(`/textbook?textbook=${encodeURIComponent(tbId)}`);
    sel.innerHTML =
      `<option value="">— 先不选，批改后再归类 —</option>` + lessonGroupsHtml(t.units || []);
    if (keep) sel.value = keep;
  } catch (e) {
    /* 大纲拉不到也不影响交作业 */
  }
}

async function openUploadModal(kind, textbooks, tbId, preferLesson) {
  pendingKind = kind;
  const tbSel = document.getElementById('up-tb');
  tbSel.innerHTML = (textbooks || [])
    .map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`)
    .join('');
  if (tbId) tbSel.value = tbId;
  document.getElementById('up-title').textContent = kind === 'shoot' ? '拍照交作业' : '从相册选照片';
  document.getElementById('up-go').textContent = kind === 'shoot' ? '开始拍照' : '去相册选';
  document.getElementById('up-lesson').innerHTML = `<option value="">加载中…</option>`;
  document.getElementById('up-modal').classList.remove('hidden');
  await fillUploadLessons(tbSel.value, preferLesson || '');
}

function closeUploadModal() {
  document.getElementById('up-modal').classList.add('hidden');
}

document.getElementById('up-cancel').onclick = closeUploadModal;
document.getElementById('up-modal').addEventListener('click', (e) => {
  if (e.target.id === 'up-modal') closeUploadModal();
});
document.getElementById('up-tb').onchange = async (e) => {
  localStorage.setItem(TB_KEY, e.target.value);
  await fillUploadLessons(e.target.value, '');
};
document.getElementById('up-go').onclick = () => {
  pendingLessonId = document.getElementById('up-lesson').value || '';
  const kind = pendingKind;
  closeUploadModal();
  // 必须在用户手势里同步触发，否则 iOS 会拦住 file input
  const inputId = kind === 'album' ? 'file-homework-album' : 'file-homework';
  document.getElementById(inputId).click();
};

async function home(opts = {}) {
  let textbooks = [];
  let units = [];
  try {
    const tbs = await api.get('/textbooks');
    textbooks = tbs.textbooks || [];
  } catch (e) { /* 忽略 */ }
  // 上次选过的教材优先，其次第一本教材。
  // 注意要区分「没传 textbook」和「传了空串 = 全部教材」，否则选「全部教材」会被打回第一本。
  const stored = localStorage.getItem(TB_KEY);
  let tbId;
  if ('textbook' in opts) {
    tbId = opts.textbook;
  } else if (stored === '') {
    tbId = '';
  } else if (stored && textbooks.some((t) => t.id === stored)) {
    tbId = stored;
  } else {
    tbId = textbooks[0]?.id || '';
  }
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

    <div class="filter-bar">
      <select id="tb-pick" title="教材">
        <option value="" ${tbId ? '' : 'selected'}>全部教材</option>
        ${textbooks.map((t) => `<option value="${esc(t.id)}" ${t.id === tbId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
      </select>
      <select id="filter-lesson" title="课文">
        <option value="">全部课文</option>
        <option value="__none" ${lessonFilter === '__none' ? 'selected' : ''}>只看未归类</option>
        ${lessonOptionsFor(units)}
      </select>
    </div>

    <div id="stats" class="stat-grid" style="margin:12px 0"></div>
    <div class="row wrap" style="margin:12px 0">
      <div class="section-title" style="margin:0">作业记录</div>
      <span class="spacer"></span>
      <button class="btn sm" id="btn-select-all">全选</button>
      <button class="btn danger sm" id="btn-del-sel">删除所选</button>
    </div>
    <div id="list"></div>`;

  // 正在看某一课（或「未归类」）时，弹窗里默认就带到那一课
  const preferLesson = lessonFilter && lessonFilter !== '__none' ? lessonFilter : '';
  document.getElementById('btn-shoot').onclick = () => openUploadModal('shoot', textbooks, tbId, preferLesson);
  document.getElementById('btn-album').onclick = () => openUploadModal('album', textbooks, tbId, preferLesson);
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
      lessonFilter === '__none' ? '没有未归类的作业，都归好啦。'
        : lessonFilter ? '这一课还没有作业记录。'
        : '还没有作业记录。<br/>点上面「拍照交作业」开始吧。'
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
/* 错题本：按「教材 → 单元 → 课文」分组，组标题上带全选框（可整课 / 整单元选中组卷） */
async function wrongBook() {
  view.innerHTML = `<div class="empty">加载中…</div>`;
  let data;
  let textbooks = [];
  let units = [];
  try {
    [data] = await Promise.all([api.get('/questions')]);
  } catch (e) {
    view.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  try {
    textbooks = (await api.get('/textbooks')).textbooks || [];
    const remember = localStorage.getItem(TB_KEY);
    const tbId = remember && textbooks.some((t) => t.id === remember) ? remember : textbooks[0]?.id || '';
    units = (await api.get(tbId ? `/textbook?textbook=${encodeURIComponent(tbId)}` : '/textbook')).units || [];
  } catch (e) { /* 大纲拉不到也能用 */ }

  const all = (data.questions || []).map((q) => ({ ...q, wrong: !!q.mastery.base_wrong }));
  const wrongs = all.filter((q) => q.wrong);

  // 课文 / 单元 id → 名字（未归类的单独一块）
  const lessonName = new Map();
  const unitName = new Map();
  units.forEach((u) => {
    unitName.set(u.id, u.name);
    u.lessons.forEach((l) => lessonName.set(l.id, l.name));
  });
  const groupOf = (q) => ({
    uKey: q.unit_id || '__none',
    uName: q.unit_name || '未归类',
    lKey: q.lesson_id || '__none',
    lName: q.lesson_name || '未归类',
  });

  const blocks = [];
  const seen = new Map();
  wrongs.forEach((q) => {
    const g = groupOf(q);
    const key = `${g.uKey}||${g.lKey}`;
    if (!seen.has(key)) {
      seen.set(key, { ...g, items: [] });
      blocks.push(seen.get(key));
    }
    seen.get(key).items.push(q);
  });

  const wrongQCard = (q) => `
    <div class="wrong-item" data-q="${q.id}">
      <input type="checkbox" class="wcheck" data-id="${q.id}" style="width:20px;height:20px;flex:0 0 auto" />
      <div style="flex:1;min-width:0">
        <div class="row wrap">
          <span class="q-no">${esc(q.no)}.</span>
          <span class="badge wrong">做错了</span>
          ${q.knowledge ? `<span class="badge gray">${esc(q.knowledge)}</span>` : ''}
          <span class="spacer"></span>
          ${masteryBadge(q.mastery)}
        </div>
        <div class="stem" style="margin:4px 0">${nl2br(q.stem)}</div>
        <div class="answer-line">作答：<b>${esc(q.student_answer || '（空白）')}</b> · 正确答案：<b>${esc(q.correct_answer)}</b></div>
        ${q.error_reason ? `<div class="solbox"><div class="t">错在哪里</div><pre class="sol">${esc(q.error_reason)}</pre></div>` : ''}
        <div class="row wrap">
          <span class="small muted">来源：${fmtDate(q.sub_created_at)} 的作业${q.lesson_name ? ` · ${esc(q.lesson_name)}` : q.unit_name ? ` · ${esc(q.unit_name)}` : ' · 未归类'}</span>
          <span class="spacer"></span>
          <a class="btn sm" href="#/q/${q.id}">举一反三</a>
          <button class="btn sm danger" data-delq="${q.id}">删除</button>
        </div>
      </div>
    </div>`;

  let html = '';
  let lastUnit = null;
  blocks.forEach((b) => {
    if (b.uKey !== lastUnit) {
      if (lastUnit !== null) html += `</div>`;
      const unitIds = blocks.filter((x) => x.uKey === b.uKey).flatMap((x) => x.items.map((i) => i.id));
      html += `<div class="row wrap" style="margin-top:16px">
          <div class="section-title" style="margin:0">${esc(b.uName)}</div>
          <span class="spacer"></span>
          <label class="pick-all">全选本单元（${unitIds.length}）<input type="checkbox" class="ucheck" data-ids="${unitIds.join(',')}" style="margin-left:6px;width:18px;height:18px;vertical-align:-3px" /></label>
        </div><div class="card" style="padding:0">`;
      lastUnit = b.uKey;
    }
    html += `<div class="row wrap" style="padding:8px 10px;background:#f7f9ff;border-bottom:1px solid var(--line)">
        <b>${esc(b.lName)}</b>
        <span class="small muted">${b.items.length} 道错题</span>
        <span class="spacer"></span>
        <label class="pick-all">全选本课<input type="checkbox" class="lcheck" data-ids="${b.items.map((i) => i.id).join(',')}" style="margin-left:6px;width:18px;height:18px;vertical-align:-3px" /></label>
      </div>`;
    html += b.items.map(wrongQCard).join('');
  });
  if (blocks.length) html += `</div>`;

  view.innerHTML = `
    <h2>错题本</h2>
    <div class="card noprint">
      <div class="row wrap">
        <b>已选 <span id="sel-count">0</span> 道错题</b>
        <span class="spacer"></span>
        <button class="btn sm" id="btn-w-all">全选</button>
        <button class="btn sm" id="btn-w-none">清空</button>
        <button class="btn primary" id="btn-make-paper">📝 错题组卷</button>
        <button class="btn danger sm" id="btn-w-del">🗑 删除所选</button>
      </div>
      <div class="hint">勾选题目（可以按课文或整个单元批量选），点「错题组卷」凑成一张可打印的练习卷；点「删除所选」把不再需要的错题清掉。</div>
    </div>
    ${wrongs.length ? html : '<div class="empty">还没有错题记录</div>'}`;

  const boxes = () => Array.from(view.querySelectorAll('.wcheck'));
  const refreshCount = () => {
    document.getElementById('sel-count').textContent = String(boxes().filter((b) => b.checked).length);
  };
  boxes().forEach((cb) => (cb.onchange = refreshCount));
  const setIds = (ids, on) => {
    boxes().forEach((b) => {
      if (ids.includes(b.dataset.id)) b.checked = on;
    });
    refreshCount();
  };
  view.querySelectorAll('.lcheck').forEach((cb) => {
    cb.onchange = () => setIds((cb.dataset.ids || '').split(',').filter(Boolean), cb.checked);
  });
  view.querySelectorAll('.ucheck').forEach((cb) => {
    cb.onchange = () => setIds((cb.dataset.ids || '').split(',').filter(Boolean), cb.checked);
  });
  document.getElementById('btn-w-all').onclick = () => {
    boxes().forEach((b) => (b.checked = true));
    view.querySelectorAll('.lcheck,.ucheck').forEach((c) => (c.checked = true));
    refreshCount();
  };
  document.getElementById('btn-w-none').onclick = () => {
    boxes().forEach((b) => (b.checked = false));
    view.querySelectorAll('.lcheck,.ucheck').forEach((c) => (c.checked = false));
    refreshCount();
  };
  refreshCount();
  document.getElementById('btn-make-paper').onclick = () => {
    const ids = boxes().filter((b) => b.checked).map((b) => b.dataset.id);
    if (!ids.length) return toast('先勾选要做卷的错题');
    paperDialog(ids);
  };

  const doDeleteWrong = async (ids) => {
    if (!ids.length) return toast('先勾选要删除的错题');
    if (
      !confirm(
        `删除这 ${ids.length} 道错题？\n\n它们下面已有的举一反三记录、掌握度进度会一起删掉；如果某份作业的题被删光，那份作业也会一并清掉。删了无法恢复。`,
      )
    )
      return;
    try {
      busy('删除中…');
      await api.post('/questions/batch-delete', { ids });
      idle();
      toast(`已删除 ${ids.length} 道错题`);
      await wrongBook();
    } catch (e) {
      idle();
      toast(e.message);
    }
  };
  document.getElementById('btn-w-del').onclick = () =>
    doDeleteWrong(boxes().filter((b) => b.checked).map((b) => b.dataset.id));
  view.querySelectorAll('[data-delq]').forEach((b) => {
    b.onclick = () => doDeleteWrong([b.dataset.delq]);
  });
}

/* 组卷设置弹窗：每道错题出几道 + 顺序/乱序 + 标题 */
function paperDialog(questionIds) {
  const wrap = document.createElement('div');
  wrap.className = 'modal';
  const d = new Date();
  const defTitle = `错题练习卷 ${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  wrap.innerHTML = `
    <div class="modal-card">
      <h3>错题组卷</h3>
      <p class="small muted" style="margin-top:-6px">已选 ${questionIds.length} 道错题</p>
      <div class="field">
        <label>每道错题出几道类似题</label>
        <select id="pp-per">
          <option value="1">1 道</option>
          <option value="2" selected>2 道</option>
          <option value="3">3 道</option>
          <option value="4">4 道</option>
          <option value="5">5 道</option>
        </select>
        <div class="hint">卷子一共大约 ${questionIds.length * 2} 道题</div>
      </div>
      <div class="field">
        <label>题目顺序</label>
        <select id="pp-order">
          <option value="1">顺序（按错题原顺序排）</option>
          <option value="0">乱序（打乱后排出）</option>
        </select>
      </div>
      <div class="field">
        <label>卷子标题</label>
        <input type="text" id="pp-title" value="${esc(defTitle)}" />
      </div>
      <div class="row-end">
        <button class="btn" id="pp-cancel">取消</button>
        <button class="btn primary" id="pp-go">开始组卷</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) close();
  });
  wrap.querySelector('#pp-cancel').onclick = close;
  wrap.querySelector('#pp-per').onchange = (e) => {
    wrap.querySelector('.hint').textContent = `卷子一共大约 ${questionIds.length * Number(e.target.value)} 道题`;
  };
  wrap.querySelector('#pp-go').onclick = async () => {
    const body = {
      question_ids: questionIds,
      per: Number(wrap.querySelector('#pp-per').value),
      ordered: Number(wrap.querySelector('#pp-order').value),
      title: wrap.querySelector('#pp-title').value.trim(),
    };
    close();
    try {
      busy(`老师在出卷…（${questionIds.length} 道错题，大约 30 秒）`);
      const r = await withTimeout(api.post('/papers', body), 150000);
      idle();
      toast(`出了 ${r.count} 道题`);
      location.hash = `#/paper/${r.id}`;
    } catch (e) {
      idle();
      toast(e.message, 6000);
    }
  };
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

/* ------------------------------------------------ 试卷（错题组卷） */
async function renderPaper(id) {
  view.innerHTML = `<div class="empty">加载中…</div>`;
  let d;
  try {
    d = await api.get(`/papers/${id}`);
  } catch (e) {
    view.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  const paper = d.paper;
  let items = d.items || [];

  const itemHtml = (it, i) => `
    <div class="paper-item" data-id="${it.id}" draggable="true">
      <div class="pi-head">
        <span class="drag-handle" title="按住拖动改顺序">⋮⋮</span>
        <input type="checkbox" class="pcheck" data-id="${it.id}" style="width:20px;height:20px" />
        <b>${i + 1}.</b>
        <span class="badge gray">${esc(it.difficulty || '同等')}</span>
        ${it.knowledge ? `<span class="badge gray">${esc(it.knowledge)}</span>` : ''}
        <span class="spacer"></span>
        <span class="small muted">来自错题 ${esc(it.source_no || '')}</span>
      </div>
      <div class="stem" style="margin:4px 0">${nl2br(it.stem)}</div>
      <div class="small muted">答案：${esc(it.answer)}</div>
    </div>`;

  view.innerHTML = `
    <div class="card noprint">
      <div class="row wrap">
        <h2 style="margin:0">${esc(paper.title)}</h2>
        <span class="badge ${paper.status === 'final' ? 'pass' : 'gray'}">${paper.status === 'final' ? '已组卷' : '草稿'}</span>
        <span class="spacer"></span>
        <span class="small muted">共 <b id="pi-count">${items.length}</b> 题 · 已选 <span id="pi-sel">0</span></span>
      </div>
      <div class="row wrap" style="margin-top:10px">
        <button class="btn sm" id="pi-all">全选</button>
        <button class="btn sm" id="pi-none">清空</button>
        <button class="btn danger sm" id="pi-del">删除所选</button>
        <span class="spacer"></span>
        <button class="btn sm" id="pi-shuffle">🔀 一键乱序</button>
        <button class="btn sm" id="pi-answer">👁 显示/隐藏答案</button>
        <button class="btn primary" id="pi-final">✔ 确认组卷</button>
        <button class="btn primary" id="pi-print">🖨 打印试卷</button>
      </div>
      <div class="hint">按住左侧的 ⋮⋮ 可以拖动改题目顺序；勾选题目可删掉不要的；确认组卷后再打印。</div>
    </div>
    <div id="pi-list">${items.length ? items.map(itemHtml).join('') : '<div class="empty">这张卷子一道题都没有了</div>'}</div>`;

  const boxes = () => Array.from(view.querySelectorAll('.pcheck'));
  const refreshSel = () => {
    document.getElementById('pi-sel').textContent = String(boxes().filter((b) => b.checked).length);
  };
  boxes().forEach((b) => (b.onchange = refreshSel));
  document.getElementById('pi-all').onclick = () => {
    boxes().forEach((b) => (b.checked = true));
    refreshSel();
  };
  document.getElementById('pi-none').onclick = () => {
    boxes().forEach((b) => (b.checked = false));
    refreshSel();
  };
  document.getElementById('pi-answer').onclick = () => {
    view.querySelectorAll('.paper-item').forEach((el) => el.classList.toggle('hide-answer'));
  };

  const reload = async () => {
    const nd = await api.get(`/papers/${id}`);
    items = nd.items || [];
    document.getElementById('pi-list').innerHTML = items.length
      ? items.map(itemHtml).join('')
      : '<div class="empty">这张卷子一道题都没有了</div>';
    document.getElementById('pi-count').textContent = String(items.length);
    boxes().forEach((b) => (b.onchange = refreshSel));
    refreshSel();
    bindDrag();
  };

  document.getElementById('pi-del').onclick = async () => {
    const ids = boxes().filter((b) => b.checked).map((b) => b.dataset.id);
    if (!ids.length) return toast('先勾选要删掉的题');
    if (!confirm(`删掉这 ${ids.length} 道题？`)) return;
    try {
      busy('删除中…');
      await api.del(`/papers/${id}/items`, { ids });
      idle();
      await reload();
    } catch (e) {
      idle();
      toast(e.message);
    }
  };

  document.getElementById('pi-shuffle').onclick = async () => {
    try {
      busy('打乱中…');
      await api.post(`/papers/${id}/shuffle`, {});
      idle();
      await reload();
    } catch (e) {
      idle();
      toast(e.message);
    }
  };

  document.getElementById('pi-final').onclick = async () => {
    try {
      busy('保存中…');
      await api.post(`/papers/${id}/finalize`, { title: paper.title });
      idle();
      toast('已确认组卷，可以打印了');
      await renderPaper(id);
    } catch (e) {
      idle();
      toast(e.message);
    }
  };

  document.getElementById('pi-print').onclick = () => (location.hash = `#/paper-print/${id}`);

  /* 拖拽排序 */
  function bindDrag() {
    const list = document.getElementById('pi-list');
    let dragEl = null;
    list.querySelectorAll('.paper-item').forEach((el) => {
      el.addEventListener('dragstart', () => {
        dragEl = el;
        el.classList.add('dragging');
      });
      el.addEventListener('dragend', () => {
        el.classList.remove('dragging');
        dragEl = null;
        // 拖完按 DOM 顺序落库
        const ids = Array.from(list.querySelectorAll('.paper-item')).map((x) => x.dataset.id);
        api.post(`/papers/${id}/reorder`, { ids }).then(() => {
          Array.from(list.querySelectorAll('.paper-item')).forEach((x, i) => {
            const b = x.querySelector('b');
            if (b) b.textContent = `${i + 1}.`;
          });
        });
      });
      el.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!dragEl || dragEl === el) return;
        const rect = el.getBoundingClientRect();
        const after = e.clientY - rect.top > rect.height / 2;
        list.insertBefore(dragEl, after ? el.nextSibling : el);
      });
    });
  }
  bindDrag();
}

/* 打印试卷：每题留答题空白，答案不给（避免孩子直接抄） */
async function renderPaperPrint(id) {
  view.innerHTML = `<div class="empty">加载中…</div>`;
  let d;
  try {
    d = await api.get(`/papers/${id}`);
  } catch (e) {
    view.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  const paper = d.paper;
  const items = d.items || [];
  if (!items.length) {
    view.innerHTML = `<div class="empty">这张卷子还没有题目<br/><a class="btn" href="#/paper/${id}" style="margin-top:12px">回去加题</a></div>`;
    return;
  }
  const lines = (it) => (String(it.difficulty || '').includes('略难') ? 5 : 3);
  view.innerHTML = `
    <div class="card noprint">
      <div class="row wrap">
        <h3 style="margin:0">共 ${items.length} 题，确认后打印</h3>
        <span class="spacer"></span>
        <button class="btn primary" onclick="window.print()">🖨 打印</button>
        <a class="btn" href="#/paper/${id}">返回编辑</a>
      </div>
      <div class="hint">试卷只印题干和空白，答案不会出现在纸上。做完拍照上传批改，或家长对照网页上的答案看。</div>
    </div>
    <div class="card">
      <div class="print-head">
        <div class="ph-title">${esc(paper.title)}</div>
        <div class="row" style="font-size:14px;margin-top:6px">
          <span>姓名：<u>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</u></span>
          <span class="spacer"></span>
          <span>日期：<u>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</u></span>
          <span class="spacer"></span>
          <span>用时：<u>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</u> 分钟</span>
        </div>
      </div>
      ${items
        .map(
          (it, i) => `
        <div class="p-item">
          <div><b>${i + 1}.</b> <span class="p-stem">${nl2br(it.stem)}</span></div>
          <div class="p-blank p-blank-${lines(it)}"></div>
        </div>`,
        )
        .join('')}
    </div>`;
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
    // 归类选的是弹窗里那一课，不是首页筛选
    const lessonId = pendingLessonId || '';
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
    const active =
      nav === '/'
        ? hash === '/' || hash.startsWith('/s/') || hash.startsWith('/q/') || hash.startsWith('/print/') || hash.startsWith('/paper')
        : hash.startsWith(nav);
    a.classList.toggle('active', active);
  });

  try {
    if (hash === '/' || hash === '') return await home();
    if (hash.startsWith('/textbook/l/')) return await home({ lesson: hash.slice('/textbook/l/'.length) });
    if (hash.startsWith('/textbook')) return await renderTextbook();
    if (hash.startsWith('/s/')) return await submission(hash.slice(3));
    if (hash.startsWith('/q/')) return await renderQuestion(hash.slice(3));
    if (hash.startsWith('/print/')) return await renderPrint(hash.slice(7));
    if (hash.startsWith('/paper-print/')) return await renderPaperPrint(hash.slice('/paper-print/'.length));
    if (hash.startsWith('/paper/')) return await renderPaper(hash.slice('/paper/'.length));
    if (hash.startsWith('/wrong')) return await wrongBook();
    if (hash.startsWith('/settings')) return await renderSettings();
    view.innerHTML = '<div class="empty">页面不存在</div>';
  } catch (e) {
    view.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

window.addEventListener('hashchange', route);
route();
