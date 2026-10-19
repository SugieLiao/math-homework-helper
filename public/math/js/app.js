import { api, setUnauthorizedHandler, setPasscode, getPasscode } from './api.js';
import { esc, nl2br, toast, busy, idle, fmtDate, cropBand, compressImage, isHeicFile, withTimeout, confirmDialog, choiceDialog, openImage } from './util.js';
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

function qCard(q, withCheck = false) {
  const ok = Number(q.is_correct) === 1;
  return `
  <div class="card q-card ${ok ? 'correct' : 'wrong'}" data-q="${q.id}">
    <div class="row wrap">
      ${withCheck ? `<input type="checkbox" class="pcheck" data-id="${q.id}" data-wrong="${ok ? 0 : 1}" title="勾上就放进卷子" style="width:20px;height:20px;flex:0 0 auto" />` : ''}
      <span class="q-no">${esc(q.no)}.</span>
      <span class="badge ${ok ? 'pass' : 'wrong'}">${ok ? '做对了' : '做错了'}</span>
      ${q.knowledge ? `<span class="badge gray">${esc(q.knowledge)}</span>` : ''}
      <span class="spacer"></span>
      ${masteryBadge(q.mastery)}
    </div>
    <div class="stem">${nl2br(q.stem)}</div>
    <div class="answer-line">作答：<b>${esc(q.student_answer || '（空白）')}</b>${ok ? '' : ` &nbsp;·&nbsp; 正确答案：<b>${esc(q.correct_answer)}</b>`}</div>
    ${q.answer_image_key ? `<img class="ans-img zoomable" src="${api.imgUrl(q.answer_image_key)}" alt="作答图片" />` : ''}
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
  trayFiles = []; // 每次新交作业都从第一页开始
  closeShotsTray();
  const kind = pendingKind;
  closeUploadModal();
  // 必须在用户手势里同步触发，否则 iOS 会拦住 file input
  const inputId = kind === 'album' ? 'file-homework-album' : 'file-homework';
  document.getElementById(inputId).click();
};

/* 列表骨架屏：数据没回来时先占位。
   之前列表区是纯空白，用户分不清「正在加载」还是「这份作业列表本来就空了」。 */
function listSkeleton(text = '正在加载…', rows = 4) {
  return `
    <div class="sk-tip"><span class="sk-spin"></span>${esc(text)}</div>
    <div class="card" style="padding:0">
      ${Array.from({ length: rows })
        .map(
          () => `
        <div class="sk-row">
          <div class="sk-thumb"></div>
          <div class="sk-body">
            <div class="sk-line" style="width:56%"></div>
            <div class="sk-line sm" style="width:38%"></div>
          </div>
          <div class="sk-pill"></div>
        </div>`,
        )
        .join('')}
    </div>`;
}

/* 首屏骨架：连按钮和筛选框一起占位，避免第一屏只剩几行灰条在跳 */
function homeSkeleton() {
  return `
    <div class="hero">
      <div class="sk-btn" style="width:132px"></div>
      <div class="sk-btn" style="width:124px"></div>
      <div class="sk-btn" style="width:112px"></div>
      <div class="sk-btn" style="width:96px"></div>
    </div>
    <div class="sk-bar"></div>
    ${listSkeleton('正在加载作业记录…', 4)}`;
}

/* 每次切页自增。慢接口回来时如果期间又切过页，这一次渲染就该作废——
   否则旧页面会把新页面顶掉，甚至因为找不到自己的节点（#list/#stats）而报错。
   典型场景：网速慢，刚进首页就点「组卷」，首页的请求晚到一步把组卷页盖掉。 */
let routeEpoch = 0;
const stalePage = (epoch) => epoch !== routeEpoch;

async function home(opts = {}) {
  const epoch = routeEpoch;
  // 先把加载态放上去：进首页要连拉教材、大纲、作业三个接口，中间不能一片空白
  // （切教材/课文时旧列表还在，就地换成骨架，用户能看出正在重新查）
  const oldList = document.getElementById('list');
  if (oldList) oldList.innerHTML = listSkeleton('正在加载作业记录…', 4);
  else view.innerHTML = homeSkeleton();

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

  if (stalePage(epoch)) return;

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

    <div id="stats" class="stat-grid" style="margin:12px 0">
      <div class="stat"><b class="sk-num">–</b><span>累计题目</span></div>
      <div class="stat"><b class="sk-num">–</b><span>做错</span></div>
      <div class="stat"><b class="sk-num">–</b><span>已过关</span></div>
    </div>
    <div class="row wrap" style="margin:12px 0">
      <div class="section-title" style="margin:0">作业记录</div>
      <span class="spacer"></span>
      <button class="btn sm" id="btn-trash">🗑 删除作业</button>
      <span id="del-ops" class="row wrap hidden">
        <button class="btn sm" id="btn-select-all">全选</button>
        <button class="btn danger sm" id="btn-del-sel">删除所选（0）</button>
        <button class="btn sm" id="btn-del-cancel">取消</button>
      </span>
    </div>
    <div id="list">${listSkeleton('正在加载作业记录…')}</div>`;

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
    if (stalePage(epoch)) return;
    const errList = document.getElementById('list');
    if (errList) errList.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  if (stalePage(epoch)) return;
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
    document.getElementById('btn-trash').classList.add('hidden');
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
    // 组卷可能只选了教材没选单元课文，那也别混进笼统的「未归类」，单独挂在该教材名下
    const uKey = s.unit_id || (s.paper_id && s.textbook_id ? `tb:${s.textbook_id}` : '__none');
    if (!unitMap.has(uKey)) {
      unitMap.set(uKey, {
        name: s.unit_name || (s.paper_textbook_name ? `${s.paper_textbook_name}（未指定单元）` : '未归类'),
        lessons: new Map(),
      });
    }
    const u = unitMap.get(uKey);
    const lKey = s.lesson_id || '__none';
    if (!u.lessons.has(lKey)) u.lessons.set(lKey, { name: s.lesson_name || '未归类', items: [] });
    u.lessons.get(lKey).items.push(s);
  });
  unitMap.forEach((u, uKey) => {
    u.lessons.forEach((l, lKey) => blocks.push({ uKey, uName: u.name, lKey, lName: l.name, items: l.items }));
  });

  // 组卷也是一份作业：有「组卷」标签，点进去看的是卷子本身。
  // 作答状态不看是不是组卷，只看有没有题目——没做的都显示「未作答」，批改失败的显示「批改失败」。
  const stateBadge = (s) => {
    if (s.state === 'pending') return `<span class="badge info">未作答</span>`;
    if (s.state === 'grading') return `<span class="badge gray">批改中</span>`;
    if (s.state === 'error') return `<span class="badge wrong">批改失败</span>`;
    return `<span class="badge ${s.wrong ? 'wrong' : 'pass'}">${s.wrong ? `错 ${s.wrong} 题` : '全对'}</span>`;
  };
  const rowHtml = (s) => {
    const isPaper = !!s.paper_id;
    const href = isPaper ? `#/paper/${s.paper_id}` : `#/s/${s.id}`;
    const thumb = s.image_key
      ? `<img class="sub-thumb zoomable" src="${api.imgUrl(s.image_key)}" alt="作业原图" />`
      : `<div class="sub-thumb sub-thumb-ph">📄</div>`;
    const title = isPaper ? `📝 ${esc(s.paper_title || '练习卷')}` : fmtDate(s.created_at);
    const pageTag = Number(s.pages) > 1 ? ` · ${s.pages} 页` : '';
    const meta = isPaper
      ? `${fmtDate(s.created_at)} · ${s.total} 题${pageTag}`
      : s.state === 'pending'
        ? `${s.total} 题（还没做）${pageTag}`
        : `${s.total} 题${pageTag} · 错 ${s.wrong} 题 · 过关 ${s.passed} 题`;
    return `
    <div class="sub-item" style="border-bottom:1px solid var(--line)">
      <input type="checkbox" class="sub-check" data-id="${s.id}" style="width:20px;height:20px;flex:0 0 auto" />
      <a href="${href}" style="display:flex;flex:1;min-width:0;text-decoration:none;color:inherit">
        ${thumb}
        <div style="flex:1;min-width:0">
          <div style="font-weight:600">${title}${isPaper ? ' <span class="tag">组卷</span>' : ''}</div>
          <div class="small muted">${meta}</div>
        </div>
      </a>
      ${stateBadge(s)}
    </div>`;
  };

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
    html += b.items.map(rowHtml).join('');
  });
  html += `</div>`;
  list.innerHTML = html;

  /* 删除：默认不显示勾选框，点顶部垃圾桶才进入删除模式 */
  const delOps = document.getElementById('del-ops');
  const trashBtn = document.getElementById('btn-trash');
  const boxes = () => Array.from(list.querySelectorAll('.sub-check'));
  const selected = () => boxes().filter((c) => c.checked).map((c) => c.dataset.id);
  const refreshDel = () => {
    document.getElementById('btn-del-sel').textContent = `删除所选（${selected().length}）`;
  };
  const setDelMode = (on) => {
    list.classList.toggle('del-mode', on);
    trashBtn.classList.toggle('hidden', on);
    delOps.classList.toggle('hidden', !on);
    if (!on) boxes().forEach((b) => (b.checked = false));
    refreshDel();
  };
  trashBtn.onclick = () => {
    setDelMode(true);
    toast('勾选要删除的作业，然后点「删除所选」');
  };
  document.getElementById('btn-del-cancel').onclick = () => setDelMode(false);
  boxes().forEach((b) => (b.onchange = refreshDel));

  const doDelete = async (ids) => {
    if (!ids.length) return toast('先勾选要删除的作业');
    const okDel = await confirmDialog('里面的题目、举一反三记录和图片会一起删掉，无法恢复。', {
      title: `删除这 ${ids.length} 份作业？`,
    });
    if (!okDel) return;
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
    const bs = boxes();
    const allChecked = bs.every((b) => b.checked);
    bs.forEach((b) => (b.checked = !allChecked));
    refreshDel();
  };
  refreshDel();
}

/* ------------------------------------------------ 作业详情 */
async function submission(id) {
  const epoch = routeEpoch;
  view.innerHTML = listSkeleton('正在打开这份作业…', 3);
  let data;
  try {
    data = await api.get(`/submissions/${id}`);
  } catch (e) {
    if (stalePage(epoch)) return;
    view.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  const s = data.submission;
  const qs = data.questions || [];
  const pages = (data.pages || []).filter((p) => p.image_key);
  let units = [];
  try {
    const t = await api.get('/textbook');
    units = t.units || [];
  } catch (e) { /* 忽略 */ }

  if (stalePage(epoch)) return;
  view.innerHTML = `
    <div class="card">
      <div class="row wrap">
        <h2 style="margin:0">${fmtDate(s.created_at)} 的作业</h2>
        <span class="spacer"></span>
        <span class="badge info">${qs.length} 题</span>
        ${pages.length > 1 ? `<span class="badge gray">${pages.length} 页</span>` : ''}
        <span class="badge ${qs.filter((q) => !Number(q.is_correct)).length ? 'wrong' : 'pass'}">
          错 ${qs.filter((q) => !Number(q.is_correct)).length} 题</span>
      </div>
      <div class="page-list">
        ${pages
          .map((p, i) => {
            const cnt = qs.filter((q) => Number(q.page) === i + 1).length;
            return `<div class="page-item">
              <img class="ans-img zoomable" src="${api.imgUrl(p.image_key)}" alt="作业原图 第${i + 1}页${
                pages.length > 1 ? `（共${pages.length}页）` : ''
              }" />
              <div class="row wrap page-bar noprint">
                <span class="small muted">第 ${i + 1} 页${pages.length > 1 ? ` / ${pages.length}` : ''}${
                  cnt ? ` · ${cnt} 题` : ' · 还没批改'
                }</span>
                <span class="spacer"></span>
                <button class="btn sm" data-replace="${esc(p.id)}">🔄 换一张</button>
                ${
                  pages.length > 1
                    ? `<button class="btn sm danger" data-delpage="${esc(p.id)}">删除这页</button>`
                    : ''
                }
              </div>
            </div>`;
          })
          .join('')}
      </div>
      <div class="row wrap noprint" style="margin-top:10px">
        <button class="btn sm" id="btn-add-page">＋ 加一页</button>
        <span class="small muted">照片拍糊了可以换一张；漏拍了一页可以加进来，只批改新加的这一页。</span>
      </div>
      ${
        s.paper_id
          ? `<div class="row wrap" style="margin-top:8px"><span class="tag">组卷</span>
               <a class="btn sm" href="#/paper/${esc(s.paper_id)}">看这张卷子</a></div>`
          : ''
      }
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
    ${
      qs.length
        ? `<div class="card noprint" id="sp-bar">
      <div class="row wrap">
        <b>待组卷：已选 <span id="sp-sel">0</span> 题</b>
        <span class="spacer"></span>
        <button class="btn sm" id="btn-sp-wrong">只选错题</button>
        <button class="btn sm" id="btn-sp-all">全选</button>
        <button class="btn sm" id="btn-sp-none">清空</button>
        <button class="btn primary" id="btn-sp-paper">＋ 加入组卷</button>
      </div>
      <div class="hint">勾选要练的题目（进来时已经帮你把做错的都选上了），点「加入组卷」放进待组卷；攒够了去顶部「组卷」页统一出卷。</div>
    </div>`
        : ''
    }
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
    <div id="qlist">${qs.map((q) => qCard(q, true)).join('')}</div>`;
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
      const ok = await confirmDialog('题目、举一反三记录和图片都会一起删掉，无法恢复。', {
        title: '删除这份作业？',
      });
      if (!ok) return;
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

  /* 组卷：勾选题目 → 出卷（和错题本走的同一套流程） */
  if (qs.length) {
    const pboxes = () => Array.from(view.querySelectorAll('.pcheck'));
    const refreshSel = () => {
      const el = document.getElementById('sp-sel');
      if (el) el.textContent = String(pboxes().filter((b) => b.checked).length);
    };
    const setSel = (on, onlyWrong) => {
      pboxes().forEach((b) => {
        b.checked = on && (!onlyWrong || b.dataset.wrong === '1');
      });
      refreshSel();
    };
    pboxes().forEach((b) => {
      b.onchange = refreshSel;
      b.checked = b.dataset.wrong === '1'; // 默认选上做错的
    });
    refreshSel();
    document.getElementById('btn-sp-wrong').onclick = () => setSel(true, true);
    document.getElementById('btn-sp-all').onclick = () => setSel(true, false);
    document.getElementById('btn-sp-none').onclick = () => setSel(false, false);
    document.getElementById('btn-sp-paper').onclick = () => {
      const ids = pboxes()
        .filter((b) => b.checked)
        .map((b) => b.dataset.id);
      if (!ids.length) return toast('先勾选要加入的题目');
      addToQueue(ids);
    };
  }

  /* 图片编辑：换一张 / 加一页 / 删除这页 */
  const addPageBtn = document.getElementById('btn-add-page');
  if (addPageBtn) {
    addPageBtn.onclick = () => {
      pendingAddSubId = id;
      filePageAdd.value = '';
      // 同步调起（multiple 且不设 capture，系统会同时给「拍照 / 照片图库 / 选取文件」）
      filePageAdd.click();
    };
  }
  view.querySelectorAll('[data-replace]').forEach((b) => {
    b.onclick = () => {
      const pageId = b.dataset.replace;
      const idx = pages.findIndex((p) => p.id === pageId);
      if (idx < 0) return;
      pendingReplace = {
        subId: id,
        pageId,
        pageNo: idx + 1,
        qCount: qs.filter((q) => Number(q.page) === idx + 1).length,
      };
      filePageReplace.value = '';
      // 关键：必须在点击的这一刻同步调起选图。先 await 弹个确认框再 click() 会被 iOS 拦掉。
      filePageReplace.click();
    };
  });
  view.querySelectorAll('[data-delpage]').forEach((b) => {
    b.onclick = () => {
      const pageId = b.dataset.delpage;
      const idx = pages.findIndex((p) => p.id === pageId);
      if (idx < 0) return;
      deletePageFlow(id, pageId, idx + 1, qs.filter((q) => Number(q.page) === idx + 1).length);
    };
  });

  bindCards();
}

/* ------------------------------------------------ 作业图片编辑 */

let pendingReplace = null; // { subId, pageId, pageNo, qCount }
let pendingAddSubId = null;
const filePageReplace = document.getElementById('file-page-replace');
const filePageAdd = document.getElementById('file-page-add');

/** 只批改一页，并把每题的作答区域从这一页的图上裁出来 */
async function gradeOnePage(subId, pageId, blob, label) {
  busy(`${label} 老师正在批改…（约 15～40 秒，别关页面）`);
  const graded = await withTimeout(api.post(`/submissions/${subId}/pages/${pageId}/grade`, {}), 180000);
  const list = graded.questions || [];
  for (const q of list) {
    if (!q.band) continue;
    const b = await cropBand(blob, q.band);
    if (b) {
      try {
        await api.upload(`/questions/${q.id}/answer-image`, b, {});
      } catch (e) { /* 裁剪图失败不影响批改结果 */ }
    }
  }
  return list;
}

/** 换掉某一页的图片。先把图选好（用户手势里调起），再问旧题怎么处理，避免 iOS 拦截 */
filePageReplace.addEventListener('change', async () => {
  const info = pendingReplace;
  pendingReplace = null;
  const file = filePageReplace.files && filePageReplace.files[0];
  filePageReplace.value = '';
  if (!file || !info) return;

  let keep = false;
  if (info.qCount > 0) {
    const pick = await choiceDialog({
      title: `换掉第 ${info.pageNo} 页的照片`,
      message: `这一页已经批改出 ${info.qCount} 道题。换图之后这些题怎么处理？`,
      options: [
        {
          value: 'keep',
          label: '保留旧题，只换图',
          hint: '题目、对错判定、举一反三记录都留着，不再重新批改这一页',
          style: 'primary',
        },
        {
          value: 'regrade',
          label: '删掉旧题，按新图重批',
          hint: `这一页的 ${info.qCount} 道题和它们的举一反三记录会被删掉，重新识别`,
          style: 'danger',
        },
      ],
    });
    if (!pick) return;
    keep = pick === 'keep';
  }

  try {
    busy(isHeicFile(file) ? 'HEIC 照片正在转成 JPG…' : '上传中…');
    const small = await compressImage(file);
    await api.upload(`/submissions/${info.subId}/pages/${info.pageId}`, small, {}, 'PUT');
    if (keep) {
      idle();
      toast(`第 ${info.pageNo} 页已换好，题目没动`);
    } else {
      const list = await gradeOnePage(info.subId, info.pageId, small, `第 ${info.pageNo} 页`);
      idle();
      toast(`第 ${info.pageNo} 页重新批改完成，识别出 ${list.length} 题`);
    }
    await submission(info.subId);
  } catch (e) {
    idle();
    toast(e.message, 8000);
    await submission(info.subId);
  }
});

/** 加页：分两步——先把选中的几张全部传上去（快），再逐页批改。
    这样选 3 张不用「传一张→等批改→再传下一张」，用户只等一次。 */
filePageAdd.addEventListener('change', async () => {
  const files = Array.from(filePageAdd.files || []);
  filePageAdd.value = '';
  const subId = pendingAddSubId;
  pendingAddSubId = null;
  if (!files.length || !subId) return;

  const uploaded = []; // { pageId, pos, blob }
  const failed = [];

  // 阶段一：全部上传（每张 1～2 秒）
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    try {
      busy(
        files.length > 1
          ? `正在上传第 ${i + 1}/${files.length} 张…`
          : isHeicFile(f)
            ? 'HEIC 照片正在转成 JPG…'
            : '上传中…',
      );
      const small = await compressImage(f);
      const up = await api.upload(`/submissions/${subId}/pages`, small, {});
      uploaded.push({ pageId: up.page.id, pos: up.page.pos, blob: small });
    } catch (e) {
      // 一张失败不要拖累其它几张（多选时经常混着一张特殊格式的）
      failed.push(`第 ${i + 1} 张：${e.message}`);
    }
  }

  // 阶段二：逐页批改（每页一次模型调用）
  let total = 0;
  let okPages = 0;
  for (let i = 0; i < uploaded.length; i++) {
    const u = uploaded[i];
    try {
      const label =
        uploaded.length > 1 ? `第 ${u.pos + 1} 页（${i + 1}/${uploaded.length}）` : `第 ${u.pos + 1} 页`;
      const list = await gradeOnePage(subId, u.pageId, u.blob, label);
      total += list.length;
      okPages += 1;
    } catch (e) {
      failed.push(`第 ${u.pos + 1} 页批改失败：${e.message}`);
    }
  }

  idle();
  if (uploaded.length) await submission(subId);
  if (failed.length) {
    toast(
      `上传 ${uploaded.length} 页、批改 ${okPages} 页${total ? `（${total} 题）` : ''}，有 ${failed.length} 项没成功。${failed[0]}`,
      10000,
    );
  } else {
    toast(`已加上 ${uploaded.length} 页，共识别出 ${total} 题`);
  }
});

/** 删除某一页。有题就问用户：题目一起删，还是把题目留下 */
async function deletePageFlow(subId, pageId, pageNo, qCount) {
  let keep = false;
  if (qCount > 0) {
    const pick = await choiceDialog({
      title: `删除第 ${pageNo} 页`,
      message: `这一页已经批改出 ${qCount} 道题。删掉这张照片后，这些题怎么办？`,
      options: [
        {
          value: 'keep',
          label: '保留题目',
          hint: '题目、作答图和举一反三记录都留着，只是不再有这一页的原图',
          style: 'primary',
        },
        {
          value: 'drop',
          label: '连题目一起删掉',
          hint: `这一页的 ${qCount} 道题和它们的举一反三记录会被删除，无法恢复`,
          style: 'danger',
        },
      ],
    });
    if (!pick) return;
    keep = pick === 'keep';
  } else {
    const ok = await confirmDialog('这一页还没有批改出题目，删掉只是去掉这张照片。', {
      title: `删掉第 ${pageNo} 页？`,
      okText: '删除',
    });
    if (!ok) return;
  }
  busy('删除中…');
  try {
    await api.del(`/submissions/${subId}/pages/${pageId}?keep=${keep ? 1 : 0}`);
    idle();
    toast(keep ? '已删除这一页，题目保留' : '已删除这一页和它的题目');
    await submission(subId);
  } catch (e) {
    idle();
    toast(e.message, 6000);
    await submission(subId);
  }
}

/* ------------------------------------------------ 错题本 */
/* 错题本：按「教材 → 单元 → 课文」分组，组标题上带全选框（可整课 / 整单元选中组卷） */
async function wrongBook() {
  const epoch = routeEpoch;
  view.innerHTML = listSkeleton('正在加载错题本…', 4);
  let data;
  let textbooks = [];
  let units = [];
  try {
    [data] = await Promise.all([api.get('/questions')]);
  } catch (e) {
    if (stalePage(epoch)) return;
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

  if (stalePage(epoch)) return;
  view.innerHTML = `
    <h2>错题本</h2>
    <div class="card noprint">
      <div class="row wrap">
        <b>已选 <span id="sel-count">0</span> 道错题</b>
        <span class="spacer"></span>
        <button class="btn sm" id="btn-w-all">全选</button>
        <button class="btn sm" id="btn-w-none">清空</button>
        <button class="btn primary" id="btn-make-paper">＋ 加入组卷</button>
        <button class="btn danger sm" id="btn-w-del">🗑 删除所选</button>
      </div>
      <div class="hint">勾选题目（可以按课文或整个单元批量选），点「加入组卷」先放进待组卷；攒够了去顶部「组卷」页，选母题、选方式，一次出卷。点「删除所选」把不再需要的错题清掉。</div>
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
    if (!ids.length) return toast('先勾选要加入的错题');
    addToQueue(ids);
  };

  const doDeleteWrong = async (ids) => {
    if (!ids.length) return toast('先勾选要删除的错题');
    const okDel = await confirmDialog(
      '它们下面已有的举一反三记录、掌握度进度会一起删掉；如果某份作业的题被删光，那份作业也会一并清掉。删了无法恢复。',
      { title: `删除这 ${ids.length} 道错题？` },
    );
    if (!okDel) return;
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

/* 把勾选的题目加入「待组卷」。
   改版后不再当场组卷：作业详情页 / 错题本只负责往纸篓里丢题，
   攒够了一次去「组卷」页统一选母题、选方式、选归属，再出卷。 */
async function addToQueue(questionIds) {
  const ids = (questionIds || []).filter(Boolean);
  if (!ids.length) return toast('先勾选要加入的题目');
  try {
    busy('加入待组卷…');
    const r = await api.post('/paper-queue', { question_ids: ids });
    idle();
    if (!r.added) toast(`这 ${ids.length} 道题都已在待组卷里了`);
    else toast(`已加入待组卷 ${r.added} 道${r.skipped ? `（${r.skipped} 道本来就在）` : ''}，共 ${r.total} 道`);
    showQueueTip(r.total);
  } catch (e) {
    idle();
    toast(e.message);
  }
}

/* 加完题后在底部浮一条，给个直达「组卷」的入口，不用自己去找 */
function showQueueTip(total) {
  let el = document.getElementById('queue-tip');
  if (!el) {
    el = document.createElement('div');
    el.id = 'queue-tip';
    el.className = 'queue-tip';
    document.body.appendChild(el);
  }
  el.innerHTML = `
    <span class="qt-text">📝 待组卷 <b>${total}</b> 道</span>
    <a class="btn sm primary" href="#/compose" id="qt-go">去组卷</a>
    <button class="btn sm" id="qt-close">知道了</button>`;
  el.classList.add('on');
  el.querySelector('#qt-close').onclick = () => el.classList.remove('on');
  el.querySelector('#qt-go').onclick = () => el.classList.remove('on');
}
function hideQueueTip() {
  const el = document.getElementById('queue-tip');
  if (el) el.classList.remove('on');
}

/* ------------------------------------------------ 组卷页 */
/* 组卷 = 三步：① 待组卷题目里勾母题 ② 选组卷方式/顺序 ③ 选教材单元课文 → 出卷。
   出完的卷子立刻变成一份「未作答」的作业，所以它同时出现在这里和作业列表里。 */
async function composePage() {
  const epoch = routeEpoch;
  view.innerHTML = listSkeleton('正在加载待组卷题目…', 4);
  let textbooks = [];
  let queue = [];
  let papers = [];
  let units = [];
  try {
    const [tbRes, qRes, pRes] = await Promise.all([api.get('/textbooks'), api.get('/paper-queue'), api.get('/papers')]);
    textbooks = tbRes.textbooks || [];
    queue = qRes.items || [];
    papers = pRes.papers || [];
  } catch (e) {
    if (stalePage(epoch)) return;
    view.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }

  const stored = localStorage.getItem(TB_KEY);
  const tbId0 = stored && textbooks.some((t) => t.id === stored) ? stored : textbooks[0]?.id || '';
  if (tbId0) {
    try {
      units = (await api.get(`/textbook?textbook=${encodeURIComponent(tbId0)}`)).units || [];
    } catch (e) {
      units = [];
    }
  }

  const d = new Date();
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const srcOf = (q) => {
    const when = q.sub_created_at ? `${fmtDate(q.sub_created_at)} 的作业` : '来源不明';
    const where = q.lesson_name || q.unit_name || '未归类';
    return `${when} · ${where}`;
  };

  const itemHtml = (q) => `
    <div class="wrong-item" data-row="${esc(q.id)}">
      <input type="checkbox" class="qcheck" data-id="${esc(q.id)}" style="width:20px;height:20px;flex:0 0 auto;margin-top:2px" />
      <div style="flex:1;min-width:0">
        <div class="row wrap">
          <span class="q-no">${esc(q.no || '')}.</span>
          <span class="badge ${Number(q.is_correct) === 1 ? 'pass' : 'wrong'}">${
            Number(q.is_correct) === 1 ? '做对了' : '做错了'
          }</span>
          ${q.knowledge ? `<span class="badge gray">${esc(q.knowledge)}</span>` : ''}
        </div>
        <div class="stem" style="margin:4px 0">${nl2br(q.stem)}</div>
        <div class="small muted">来源：${esc(srcOf(q))}</div>
      </div>
    </div>`;

  const paperRow = (p) => {
    const place = [p.textbook_name, p.unit_name, p.lesson_name].filter(Boolean).join(' › ');
    const state =
      p.status !== 'final'
        ? '<span class="badge gray">草稿</span>'
        : p.sub_status === 'graded'
          ? '<span class="badge pass">已批改</span>'
          : p.sub_status === 'grading'
            ? '<span class="badge gray">批改中</span>'
            : '<span class="badge info">未作答</span>';
    return `<a class="paper-row" href="#/paper/${esc(p.id)}">
      <div style="flex:1;min-width:0">
        <div style="font-weight:600">📝 ${esc(p.title)} ${state}</div>
        <div class="small muted">${fmtDate(p.created_at)} · ${p.item_count} 题${place ? ` · ${esc(place)}` : ''}</div>
      </div>
      <span class="muted" style="flex:0 0 auto">›</span>
    </a>`;
  };

  const unitOpts = (list) =>
    `<option value="">— 不选，只归到教材 —</option>` +
    list.map((u) => `<option value="${esc(u.id)}">${esc(u.name)}</option>`).join('');
  const lessonOpts = (u) =>
    `<option value="">— 不选 —</option>` + ((u?.lessons || []).map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('') || '');

  if (stalePage(epoch)) return;
  view.innerHTML = `
    <h2 style="margin-top:0">组卷</h2>
    <div class="card noprint">
      <div class="row wrap">
        <b>待组卷题目</b>
        <span class="badge info" id="q-count">${queue.length} 道</span>
        <span class="spacer"></span>
        <button class="btn sm" id="btn-q-all">全选</button>
        <button class="btn sm" id="btn-q-none">清空选择</button>
        <button class="btn sm" id="btn-q-remove" disabled>移除</button>
        <button class="btn danger sm" id="btn-q-clear">🗑 清空待组卷</button>
      </div>
      <div class="hint">在「作业」详情页或「错题本」里勾选题目，点「加入组卷」就攒到这里。勾选后点「移除」批量移出（题目本身不会删），「清空待组卷」一次清光。勾好这次要用的母题，再点下面的「组卷」设置出卷方式。</div>
    </div>
    ${
      queue.length
        ? `<div class="card ${queue.length > 8 ? 'q-scroll' : ''}" style="padding:0" id="q-list">${queue
            .map(itemHtml)
            .join('')}</div>`
        : `<div class="card"><div class="empty">还没有待组卷的题目。<br/>去「作业」详情页或「错题本」勾选题目，点「加入组卷」。</div>
             <div class="row" style="justify-content:center"><a class="btn" href="#/wrong">去错题本挑题</a></div></div>`
    }
    ${
      queue.length
        ? `<div class="card noprint" id="compose-bar">
             <div class="row wrap">
               <span class="small">本次已选 <b id="q-sel">0</b> 道母题</span>
               <span class="spacer"></span>
               <button class="btn primary" id="cm-open" disabled>📝 组卷</button>
             </div>
             ${
               textbooks.length
                 ? ''
                 : '<div class="hint" style="color:var(--wrong)">还没有教材，先去<a href="#/textbook">大纲</a>里建一本。</div>'
             }
           </div>`
        : ''
    }

    <div class="section-title">我的试卷</div>
    ${
      papers.length
        ? `<div class="card" style="padding:0">${papers.map(paperRow).join('')}</div>`
        : `<div class="card"><div class="empty">还没有组过卷。上面挑好母题就能出第一张。</div></div>`
    }`;

  /* ---- 勾选与计数 ---- */
  const boxes = () => Array.from(view.querySelectorAll('.qcheck'));
  const checkedIds = () => boxes().filter((b) => b.checked).map((b) => b.dataset.id);
  const refresh = () => {
    const n = checkedIds().length;
    const selEl = document.getElementById('q-sel');
    if (selEl) selEl.textContent = String(n);
    const rmBtn = document.getElementById('btn-q-remove');
    if (rmBtn) {
      rmBtn.disabled = !n;
      rmBtn.textContent = n ? `移除（${n}）` : '移除';
    }
    const openBtn = document.getElementById('cm-open');
    if (openBtn) {
      openBtn.disabled = !n || !textbooks.length;
      openBtn.textContent = n ? `📝 组卷（${n} 道母题）` : '📝 组卷';
    }
  };
  boxes().forEach((b) => (b.onchange = refresh));
  // 手机上点整行就能勾选，不用精准点那个小方框
  view.querySelectorAll('[data-row]').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('button') || e.target.closest('a') || e.target.tagName === 'INPUT') return;
      const cb = row.querySelector('.qcheck');
      if (!cb) return;
      cb.checked = !cb.checked;
      refresh();
    });
  });
  document.getElementById('btn-q-all').onclick = () => {
    boxes().forEach((b) => (b.checked = true));
    refresh();
  };
  document.getElementById('btn-q-none').onclick = () => {
    boxes().forEach((b) => (b.checked = false));
    refresh();
  };
  document.getElementById('btn-q-clear').onclick = async () => {
    const total = view.querySelectorAll('[data-row]').length;
    if (!total) return toast('待组卷已经是空的');
    const ok = await confirmDialog('待组卷里的题目会被全部移出（题目本身不会删）。', {
      title: `清空这 ${total} 道待组卷题目？`,
      okText: '清空',
    });
    if (!ok) return;
    try {
      busy('清空中…');
      await api.del('/paper-queue', { all: true });
      idle();
      toast('已清空');
      await composePage();
    } catch (e) {
      idle();
      toast(e.message);
    }
  };
  // 批量移出：勾哪几道就移哪几道（题目本身不删，随时能再加回来）
  document.getElementById('btn-q-remove').onclick = async () => {
    const ids = checkedIds();
    if (!ids.length) return toast('先勾选要移出的题目');
    const ok = await confirmDialog(`这 ${ids.length} 道题会从待组卷里移出，题目本身不会删，之后还能再「加入组卷」。`, {
      title: `移出这 ${ids.length} 道题？`,
      okText: '移出',
    });
    if (!ok) return;
    try {
      busy('移出中…');
      await api.del('/paper-queue', { question_ids: ids });
      idle();
      toast(`已移出 ${ids.length} 道`);
      // 就地删行，不整页重渲染：否则刚勾的其它题也被清掉，看起来像「白选了」
      ids.forEach((id) => {
        view.querySelector(`[data-row="${id}"]`)?.remove();
      });
      const left = view.querySelectorAll('[data-row]').length;
      if (!left) return await composePage();
      const cnt = document.getElementById('q-count');
      if (cnt) cnt.textContent = `${left} 道`;
      refresh();
    } catch (e) {
      idle();
      toast(e.message);
    }
  };

  /* ---- 组卷：点按钮才弹设置弹窗 ---- */
  const openBtn = document.getElementById('cm-open');
  if (openBtn) {
    openBtn.onclick = () => {
      const ids = checkedIds();
      if (!ids.length) return toast('先勾选要做卷的母题');
      composeDialog({ ids, textbooks, md });
    };
  }
  refresh();
}

/* 组卷设置弹窗：点「组卷」后弹出来，选方式 / 每道几道 / 顺序 / 教材单元课文 / 标题，
   确认后直接出卷并跳到卷子页。出卷过程就在弹窗里显示进度，不关弹窗也不让重复点。 */
async function composeDialog(opts) {
  const ids = (opts.ids || []).slice();
  const textbooks = opts.textbooks || [];
  const md = opts.md || '';
  if (!ids.length) return toast('先勾选要做卷的母题');
  if (!textbooks.length) {
    toast('还没有教材，先去「大纲」里建一本');
    return;
  }

  const stored = localStorage.getItem(TB_KEY);
  const tbId0 = stored && textbooks.some((t) => t.id === stored) ? stored : textbooks[0].id;
  let units = [];
  try {
    units = (await api.get(`/textbook?textbook=${encodeURIComponent(tbId0)}`)).units || [];
  } catch (e) {
    units = [];
  }

  const unitOpts = (list) =>
    `<option value="">— 不选，只归到教材 —</option>` +
    list.map((u) => `<option value="${esc(u.id)}">${esc(u.name)}</option>`).join('');
  const lessonOpts = (u) =>
    `<option value="">— 不选 —</option>` +
    ((u?.lessons || []).map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('') || '');

  const wrap = document.createElement('div');
  wrap.className = 'modal';
  wrap.innerHTML = `
    <div class="modal-card wide">
      <h3 style="margin-bottom:2px">组卷设置</h3>
      <p class="small muted" style="margin:0 0 12px">本次用 <b>${ids.length}</b> 道母题组卷</p>
      <div class="field">
        <label>组卷方式</label>
        <label class="opt-line"><input type="radio" name="cd-mode" value="original" />
          <span><b>只用原题</b><span class="small muted">　原样拼成一张卷，马上出</span></span></label>
        <label class="opt-line"><input type="radio" name="cd-mode" value="variant" checked />
          <span><b>举一反三</b><span class="small muted">　每道母题再出几道同类新题</span></span></label>
      </div>
      <div id="cd-variant">
        <div class="field">
          <label>每道母题出几道类似题</label>
          <select id="cd-per">
            ${[1, 2, 3, 4, 5].map((n) => `<option value="${n}">${n} 道</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label class="opt-line"><input type="checkbox" id="cd-orig" checked />
            <span>卷子里也带上原题<span class="small muted">　原题排在它自己的类似题前面</span></span></label>
        </div>
      </div>
      <div class="field">
        <label>题目顺序</label>
        <select id="cd-order">
          <option value="1">顺序（按母题顺序排）</option>
          <option value="0">乱序（打乱后排出）</option>
        </select>
      </div>
      <div class="field">
        <label>教材（必选）</label>
        <select id="cd-tb">
          ${textbooks
            .map((t) => `<option value="${esc(t.id)}" ${t.id === tbId0 ? 'selected' : ''}>${esc(t.name)}</option>`)
            .join('')}
        </select>
      </div>
      <div class="field">
        <label>单元（可不选）</label>
        <select id="cd-unit">${unitOpts(units)}</select>
      </div>
      <div class="field">
        <label>课文（可不选）</label>
        <select id="cd-lesson">${lessonOpts(null)}</select>
        <div class="hint">教材必选；单元 / 课文可以不选。选了以后这张卷子就挂在对应的单元、课文下面，作业列表里一筛就出来。</div>
      </div>
      <div class="field">
        <label>卷子标题</label>
        <input type="text" id="cd-title" value="练习卷 ${md}" />
      </div>
      <div class="modal-foot">
        <div class="small muted" id="cd-est"></div>
        <div class="row-end" style="margin-top:8px">
          <button class="btn" id="cd-cancel">取消</button>
          <button class="btn primary" id="cd-go">📝 开始组卷</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  const $ = (sel) => wrap.querySelector(sel);
  const mode = () => wrap.querySelector('input[name=cd-mode]:checked')?.value || 'variant';
  const per = () => Number($('#cd-per').value || 1);
  const withOrig = () => !!$('#cd-orig').checked;
  const estimate = () => (mode() === 'original' ? ids.length : ids.length * per() + (withOrig() ? ids.length : 0));
  const refresh = () => {
    const est = estimate();
    $('#cd-est').innerHTML =
      est > 60
        ? `<span style="color:var(--wrong)">这一卷会出 ${est} 道题，超过 60 道上限，少选几道母题或调小数量。</span>`
        : mode() === 'original'
          ? `这一卷 ${est} 道原题`
          : `这一卷大约 ${est} 道题${withOrig() ? `（含 ${ids.length} 道原题）` : ''}`;
  };

  wrap.querySelectorAll('input[name=cd-mode]').forEach((r) => {
    r.onchange = () => {
      const variant = mode() === 'variant';
      $('#cd-variant').classList.toggle('hidden', !variant);
      const titleEl = $('#cd-title');
      // 标题还是默认值时才跟着换，用户自己改过就别动
      if (/^(练习卷|原题练习卷) \d\d-\d\d$/.test(titleEl.value.trim())) {
        titleEl.value = `${variant ? '练习卷' : '原题练习卷'} ${md}`;
      }
      refresh();
    };
  });
  $('#cd-per').onchange = refresh;
  $('#cd-orig').onchange = refresh;

  let curUnits = units;
  $('#cd-tb').onchange = async () => {
    localStorage.setItem(TB_KEY, $('#cd-tb').value);
    try {
      curUnits = (await api.get(`/textbook?textbook=${encodeURIComponent($('#cd-tb').value)}`)).units || [];
    } catch (e) {
      curUnits = [];
    }
    $('#cd-unit').innerHTML = unitOpts(curUnits);
    // 单元没选就只留「不选」：避免出现「单元：不选 / 课文却列着第一单元的课」这种自相矛盾的界面
    $('#cd-lesson').innerHTML = lessonOpts(null);
  };
  $('#cd-unit').onchange = () => {
    $('#cd-lesson').innerHTML = lessonOpts(curUnits.find((x) => x.id === $('#cd-unit').value));
  };

  const close = () => wrap.remove();
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) close();
  });
  $('#cd-cancel').onclick = close;

  $('#cd-go').onclick = async () => {
    const tb = $('#cd-tb').value;
    if (!tb) return toast('先选一本教材');
    const m = mode();
    const total = estimate();
    if (total > 60) {
      return toast(`这次会出 ${total} 道题，一张卷最多 60 道。少选几道母题，或把每道出的数量调小一点。`, 7000);
    }
    const body = {
      question_ids: ids,
      mode: m,
      per: m === 'variant' ? per() : 1,
      include_original: m === 'variant' ? withOrig() : false,
      ordered: Number($('#cd-order').value),
      textbook_id: tb,
      unit_id: $('#cd-unit').value,
      lesson_id: $('#cd-lesson').value,
      title: $('#cd-title').value.trim(),
    };
    const goBtn = $('#cd-go');
    goBtn.disabled = true;
    goBtn.textContent = '出卷中…';
    $('#cd-est').textContent =
      m === 'original' ? '正在把原题拼成卷子…' : `老师在出卷…（约 ${Math.min(120, 20 + total * 2)} 秒，别关页面）`;
    try {
      const r = await withTimeout(api.post('/papers', body), 240000);
      close();
      toast(`出了 ${r.count} 道题${r.removed_from_queue ? '，已从待组卷移出' : ''}`, 6000);
      location.hash = `#/paper/${r.id}`;
    } catch (e) {
      goBtn.disabled = false;
      goBtn.textContent = '📝 开始组卷';
      refresh();
      toast(e.message, 8000);
    }
  };
  refresh();
}

/* 归类弹窗：教材必选，单元 / 课文可选。用于「确认组卷」时决定这张卷子挂在作业列表的哪儿。
   返回 { textbook_id, unit_id, lesson_id }，取消返回 null。 */
async function classifyDialog(defaults = {}) {
  const textbooks = (await api.get('/textbooks')).textbooks || [];
  if (!textbooks.length) {
    toast('还没有教材，先去「大纲」里建一本');
    return null;
  }
  const tbId0 = defaults.textbook_id && textbooks.some((t) => t.id === defaults.textbook_id)
    ? defaults.textbook_id
    : textbooks[0].id;
  let units = [];
  try {
    units = (await api.get(`/textbook?textbook=${encodeURIComponent(tbId0)}`)).units || [];
  } catch (e) { /* 大纲拉不到也能选教材 */ }

  // 从 lesson_id 反推它属于哪个单元，好在下拉里默认选中
  let unitId0 = '';
  if (defaults.lesson_id) {
    const hit = units.find((u) => (u.lessons || []).some((l) => l.id === defaults.lesson_id));
    if (hit) unitId0 = hit.id;
  }

  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.innerHTML = `
      <div class="modal-card">
        <h3>这张卷子归到哪儿</h3>
        <div class="field">
          <label>教材（必选）</label>
          <select id="cl-tb">
            ${textbooks
              .map((t) => `<option value="${esc(t.id)}" ${t.id === tbId0 ? 'selected' : ''}>${esc(t.name)}</option>`)
              .join('')}
          </select>
        </div>
        <div class="field">
          <label>单元（可不选）</label>
          <select id="cl-unit">
            <option value="">— 不选，只归到教材 —</option>
            ${units.map((u) => `<option value="${esc(u.id)}" ${u.id === unitId0 ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>课文（可不选）</label>
          <select id="cl-lesson">
            <option value="">— 不选 —</option>
            ${(units.find((u) => u.id === unitId0)?.lessons || [])
              .map(
                (l) => `<option value="${esc(l.id)}" ${l.id === defaults.lesson_id ? 'selected' : ''}>${esc(l.name)}</option>`,
              )
              .join('')}
          </select>
          <div class="hint">选了以后，这张卷子就挂在对应单元/课文下面，作业列表里一筛就出来。</div>
        </div>
        <div class="row-end">
          <button class="btn" id="cl-cancel">取消</button>
          <button class="btn primary" id="cl-go">确定</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    let curUnits = units;
    const tbSel = wrap.querySelector('#cl-tb');
    const unSel = wrap.querySelector('#cl-unit');
    const lsSel = wrap.querySelector('#cl-lesson');
    const fillLessons = () => {
      const u = curUnits.find((x) => x.id === unSel.value);
      lsSel.innerHTML =
        `<option value="">— 不选 —</option>` +
        ((u?.lessons || []).map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('') || '');
    };
    tbSel.onchange = async () => {
      try {
        curUnits = (await api.get(`/textbook?textbook=${encodeURIComponent(tbSel.value)}`)).units || [];
      } catch (e) {
        curUnits = [];
      }
      unSel.innerHTML =
        `<option value="">— 不选，只归到教材 —</option>` +
        curUnits.map((u) => `<option value="${esc(u.id)}">${esc(u.name)}</option>`).join('');
      fillLessons();
    };
    unSel.onchange = fillLessons;

    const close = (v) => {
      wrap.remove();
      resolve(v);
    };
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap) close(null);
    });
    wrap.querySelector('#cl-cancel').onclick = () => close(null);
    wrap.querySelector('#cl-go').onclick = () => {
      if (!tbSel.value) return toast('先选一本教材');
      close({ textbook_id: tbSel.value, unit_id: unSel.value || '', lesson_id: lsSel.value || '' });
    };
  });
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
  const epoch = routeEpoch;
  view.innerHTML = listSkeleton('正在打开卷子…', 3);
  let d;
  try {
    d = await api.get(`/papers/${id}`);
  } catch (e) {
    if (stalePage(epoch)) return;
    view.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  const paper = d.paper;
  let items = d.items || [];
  const sub = d.submission || null;
  const answered = !!(sub && sub.status === 'graded');
  const place = [d.textbook?.name, d.unit?.name, d.lesson?.name].filter(Boolean).join(' › ');

  const itemHtml = (it, i) => `
    <div class="paper-item" data-id="${it.id}" draggable="true">
      <div class="pi-head">
        <span class="drag-handle" title="按住拖动改顺序">⋮⋮</span>
        <input type="checkbox" class="pcheck" data-id="${it.id}" style="width:20px;height:20px" />
        <b>${i + 1}.</b>
        <span class="badge gray">${esc(it.difficulty || '同等')}</span>
        ${it.knowledge ? `<span class="badge gray">${esc(it.knowledge)}</span>` : ''}
        <span class="spacer"></span>
        <span class="small muted">来自第 ${esc(it.source_no || '')} 题</span>
      </div>
      <div class="stem" style="margin:4px 0">${nl2br(it.stem)}</div>
      <div class="small muted">答案：${esc(it.answer)}</div>
    </div>`;

  const isFinal = paper.status === 'final';
  if (stalePage(epoch)) return;
  view.innerHTML = `
    <div class="card noprint">
      <div class="row wrap">
        <h2 style="margin:0">${esc(paper.title)}</h2>
        <span class="tag">组卷</span>
        <span class="badge ${isFinal ? 'pass' : 'gray'}">${isFinal ? '已组卷' : '草稿'}</span>
        ${isFinal && !answered ? `<span class="badge info">未作答</span>` : ''}
        <span class="spacer"></span>
        <span class="small muted">共 <b id="pi-count">${items.length}</b> 题 · 已选 <span id="pi-sel">0</span></span>
      </div>
      ${
        isFinal
          ? `<div class="small muted" style="margin-top:6px">归类：${esc(place || '未归类')}
             <button class="btn sm" id="pi-reclass" style="margin-left:8px">改归类</button></div>
             <div class="row wrap" style="margin-top:10px">
               <button class="btn primary sm" id="pi-shoot">📷 ${answered ? '重新提交答案' : '拍照交答案'}</button>
               <button class="btn primary sm" id="pi-album">🖼 从相册选</button>
               ${answered && sub ? `<a class="btn sm" href="#/s/${sub.id}">看批改结果</a>` : ''}
             </div>`
          : ''
      }
      <div class="row wrap" style="margin-top:10px">
        <button class="btn sm" id="pi-all">全选</button>
        <button class="btn sm" id="pi-none">清空</button>
        <button class="btn danger sm" id="pi-del">删除所选</button>
        <span class="spacer"></span>
        <button class="btn sm" id="pi-shuffle">🔀 一键乱序</button>
        <button class="btn sm" id="pi-answer">👁 显示/隐藏答案</button>
        ${isFinal ? '' : '<button class="btn primary" id="pi-final">✔ 确认组卷</button>'}
        <button class="btn primary" id="pi-print">🖨 打印试卷</button>
      </div>
      <div class="hint">${
        isFinal
          ? '这张卷子已经进作业记录了。打印出来给孩子做，做完拍照交回来就能自动批改。'
          : '按住左侧的 ⋮⋮ 可以拖动改题目顺序；勾选题目可删掉不要的；确认组卷后它会变成一份作业。'
      }</div>
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
    const okDel = await confirmDialog('删掉后这张卷子就没有这些题了，可以再重新组卷。', {
      title: `删掉这 ${ids.length} 道题？`,
    });
    if (!okDel) return;
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

  // 确认组卷：先问清归到哪本教材（必选）/ 哪个单元 / 哪篇课文（可选），
  // 然后后端生成一条作业记录，这张卷子就以「未作答」出现在作业列表里。
  const doFinalize = async () => {
    const picked = await classifyDialog({ textbook_id: paper.textbook_id || '', lesson_id: paper.lesson_id || '' });
    if (!picked) return;
    try {
      busy('保存中…');
      await api.post(`/papers/${id}/finalize`, { title: paper.title, ...picked });
      idle();
      toast('已确认组卷，它已经进作业记录了，可以打印');
      await renderPaper(id);
    } catch (e) {
      idle();
      toast(e.message);
    }
  };
  const finalBtn = document.getElementById('pi-final');
  if (finalBtn) finalBtn.onclick = doFinalize;
  const reBtn2 = document.getElementById('pi-reclass');
  if (reBtn2) {
    reBtn2.onclick = async () => {
      const picked = await classifyDialog({ textbook_id: paper.textbook_id || '', lesson_id: paper.lesson_id || '' });
      if (!picked) return;
      try {
        busy('保存中…');
        await api.post(`/papers/${id}/finalize`, { ...picked });
        idle();
        toast('归类已更新');
        await renderPaper(id);
      } catch (e) {
        idle();
        toast(e.message);
      }
    };
  }
  const shootBtn = document.getElementById('pi-shoot');
  const albumBtn = document.getElementById('pi-album');
  if (shootBtn) shootBtn.onclick = () => {
    pendingPaperId = id;
    document.getElementById('file-paper').click();
  };
  if (albumBtn) albumBtn.onclick = () => {
    pendingPaperId = id;
    document.getElementById('file-paper-album').click();
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
  const epoch = routeEpoch;
  view.innerHTML = `<div class="empty">加载中…</div>`;
  let d;
  try {
    d = await api.get(`/papers/${id}`);
  } catch (e) {
    if (stalePage(epoch)) return;
    view.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  if (stalePage(epoch)) return;
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

/**
 * 把（一张或多张）照片当同一份作业上传：第一张建作业，后面几张追加成第 2、3… 页，
 * 全部到齐后只批改一次。多页作业在详情页按页显示。
 */
async function uploadHomeworkFiles(files) {
  const list0 = Array.from(files || []).filter(Boolean);
  if (!list0.length) return;
  if (list0.length > 8) return toast('一次最多 8 页，多了分成两次交吧', 6000);
  let subId = null;
  const blobs = []; // 每页压缩后的图，裁作答图时按页取
  try {
    for (let i = 0; i < list0.length; i++) {
      const prefix = list0.length > 1 ? `第 ${i + 1}/${list0.length} 页 · ` : '';
      busy(isHeicFile(list0[i]) ? `${prefix}HEIC 照片正在转成 JPG…` : `${prefix}上传中…`);
      const small = await compressImage(list0[i]);
      blobs.push(small);
      // 归类选的是弹窗里那一课，不是首页筛选；第二页起带 submission_id 追加到同一份作业
      const extra = { lesson_id: pendingLessonId || '' };
      if (subId) extra.submission_id = subId;
      const up = await api.upload('/homework/upload', small, extra);
      subId = up.id;
    }
    busy(
      list0.length > 1
        ? `老师正在批改 ${list0.length} 页…（大约 30～70 秒，别关页面）`
        : '老师正在批改…（快速模式约 15～40 秒，别关页面）',
    );
    // 批改是长请求，加硬超时，避免界面无限转圈
    const graded = await withTimeout(api.post(`/homework/${subId}/grade`, {}), 240000);
    // 裁剪每题的作答图（用转码后的 JPEG 裁，HEIC 浏览器解不开）；多页要按题目所在页裁
    const list = graded.questions || [];
    for (const q of list) {
      if (!q.band) continue;
      const idx = Math.max(0, Math.min(blobs.length - 1, (Number(q.page) || 1) - 1));
      const blob = await cropBand(blobs[idx] || blobs[0], q.band);
      if (blob) {
        try {
          await api.upload(`/questions/${q.id}/answer-image`, blob, {});
        } catch (e) { /* 裁剪图失败不影响主流程 */ }
      }
    }
    idle();
    toast(`批改完成，共 ${list.length} 题${list0.length > 1 ? `（${list0.length} 页）` : ''}`);
    location.hash = `#/s/${subId}`;
  } catch (e) {
    idle();
    toast(e.message, 8000);
    // 让用户能直接看到这次作业的状态和「重新批改」按钮
    if (subId) location.hash = `#/s/${subId}`;
  }
}

/* ------------------------------------------------ 待上传照片托盘 */
// 手机系统一次往往只肯给一张（拍照必然如此，部分机型/内置浏览器的相册也只让单选）。
// 所以先把照片攒进这个托盘：可以反复「再拍一张 / 再选几张」，攒够了再一次性上传、一次批改。
let trayFiles = [];
let trayKind = 'album'; // 'shoot' | 'album'
let trayUrls = [];
const MAX_PAGES = 8;

function revokeTrayUrls() {
  for (const u of trayUrls) {
    try {
      URL.revokeObjectURL(u);
    } catch (e) {
      /* 忽略 */
    }
  }
  trayUrls = [];
}

function closeShotsTray() {
  const w = document.getElementById('shot-tray');
  if (w) w.remove();
  revokeTrayUrls();
}

function renderShotsTray() {
  if (!trayFiles.length) return closeShotsTray();
  let wrap = document.getElementById('shot-tray');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'shot-tray';
    wrap.className = 'modal';
    document.body.appendChild(wrap);
  }
  revokeTrayUrls();
  const cells = trayFiles
    .map((f, i) => {
      const url = URL.createObjectURL(f);
      trayUrls.push(url);
      return `<div class="tray-item">
        <img class="tray-img" src="${url}" alt="第 ${i + 1} 页" />
        <span class="tray-no">${i + 1}</span>
        <button class="tray-del" data-del="${i}" title="删掉这一张">×</button>
      </div>`;
    })
    .join('');
  const canAdd = trayFiles.length < MAX_PAGES;
  const verb = trayKind === 'shoot' ? '拍' : '选';
  const other =
    trayKind === 'shoot'
      ? `<button class="btn sm" id="tray-add-album">🖼 从相册再选几张</button>`
      : `<button class="btn sm" id="tray-add-camera">📷 现拍一张</button>`;
  wrap.innerHTML = `
    <div class="modal-card tray-card">
      <h3>已经凑了 ${trayFiles.length} 页</h3>
      <p class="small muted tray-sub">还能继续${verb}，攒够了一次性上传、一次批改。</p>
      <div class="tray-grid">
        ${cells}
        ${canAdd ? `<button class="tray-add" id="tray-add"><span>＋</span><em>再${verb}一张</em></button>` : ''}
      </div>
      <div class="hint">${canAdd ? '每张照片算这份作业的一页，选错的点 × 删掉。' : `一次最多 ${MAX_PAGES} 页，多的分两次交。`}</div>
      ${canAdd ? `<div class="tray-other">${other}</div>` : ''}
      <div class="row-end" style="margin-top:14px">
        <button class="btn" id="tray-cancel">取消</button>
        <button class="btn primary" id="tray-go">开始批改（${trayFiles.length} 页）</button>
      </div>
    </div>`;
}

function addToTray(files, kind) {
  if (kind) trayKind = kind;
  const room = MAX_PAGES - trayFiles.length;
  if (room <= 0) {
    toast(`一次最多 ${MAX_PAGES} 页，这批先上传吧`, 6000);
    return;
  }
  trayFiles.push(...files.slice(0, room));
  if (files.length > room) toast(`一次最多 ${MAX_PAGES} 页，多出的 ${files.length - room} 张没加进来`, 6000);
  renderShotsTray();
}

// 托盘里的按钮都用事件委托，重渲染后不用重新绑
document.addEventListener('click', (e) => {
  const t = e.target;
  if (!t || !t.closest || !t.closest('#shot-tray')) return;

  const del = t.closest('.tray-del');
  if (del) {
    trayFiles.splice(Number(del.dataset.del), 1);
    renderShotsTray();
    return;
  }
  if (t.classList && t.classList.contains('tray-img')) {
    openImage(t.getAttribute('src'), t.getAttribute('alt'));
    return;
  }
  if (t.closest('#tray-add')) {
    // 必须在这次点击的用户手势里同步调起，iOS 才肯弹相机/相册
    document.getElementById(trayKind === 'shoot' ? 'file-homework' : 'file-homework-album').click();
    return;
  }
  if (t.closest('#tray-add-camera')) {
    document.getElementById('file-homework').click();
    return;
  }
  if (t.closest('#tray-add-album')) {
    document.getElementById('file-homework-album').click();
    return;
  }
  if (t.closest('#tray-cancel')) {
    trayFiles = [];
    closeShotsTray();
    return;
  }
  if (t.closest('#tray-go')) {
    const shots = trayFiles.slice();
    trayFiles = [];
    closeShotsTray();
    uploadHomeworkFiles(shots);
  }
});

fileInput.addEventListener('change', () => {
  const files = Array.from(fileInput.files || []);
  fileInput.value = '';
  if (files.length) addToTray(files, 'shoot');
});

fileAlbum.addEventListener('change', () => {
  const files = Array.from(fileAlbum.files || []);
  fileAlbum.value = '';
  if (files.length) addToTray(files, 'album');
});

/* 组卷的答卷：拍做好的卷子交回来，挂到确认组卷时生成的那条作业记录上再批改 */
const filePaper = document.getElementById('file-paper');
const filePaperAlbum = document.getElementById('file-paper-album');
let pendingPaperId = '';

async function handlePaperFile(input) {
  const pid = pendingPaperId;
  const file = input.files && input.files[0];
  input.value = '';
  if (!file || !pid) return;
  let subId = null;
  try {
    busy(isHeicFile(file) ? 'HEIC 照片正在转成 JPG…' : '上传中…');
    const small = await compressImage(file);
    const up = await api.upload(`/papers/${pid}/answer`, small, {});
    subId = up.id;
    busy('老师正在批改…（快速模式约 15～40 秒，别关页面）');
    await withTimeout(api.post(`/homework/${up.id}/grade`, {}), 180000);
    idle();
    toast('批改完成');
    location.hash = `#/s/${up.id}`;
  } catch (e) {
    idle();
    toast(e.message, 8000);
    if (subId) location.hash = `#/s/${subId}`;
    else location.hash = `#/paper/${pid}`;
  }
}

filePaper.addEventListener('change', () => handlePaperFile(filePaper));
filePaperAlbum.addEventListener('change', () => handlePaperFile(filePaperAlbum));

/* ------------------------------------------------ 路由 */
/* 切页时的顶部进度条：渲染要等接口，期间没有任何变化会让人以为卡住了 */
let routeSeq = 0;
function showRouteBar() {
  let bar = document.getElementById('route-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'route-bar';
    document.body.appendChild(bar);
  }
  bar.classList.add('on');
}
function hideRouteBar() {
  const bar = document.getElementById('route-bar');
  if (bar) bar.classList.remove('on');
}

async function route() {
  const seq = ++routeSeq;
  routeEpoch += 1; // 让上一页还在飞的请求作废
  showRouteBar();
  hideQueueTip();
  const hash = location.hash.replace(/^#/, '') || '/';
  document.querySelectorAll('.topnav a').forEach((a) => {
    const nav = a.dataset.nav;
    const active =
      nav === '/'
        ? hash === '/' || hash.startsWith('/s/') || hash.startsWith('/q/') || hash.startsWith('/print/')
        : nav === '/compose'
          ? hash.startsWith('/compose') || hash.startsWith('/paper')
          : hash.startsWith(nav);
    a.classList.toggle('active', active);
  });

  try {
    if (hash === '/' || hash === '') return await home();
    if (hash.startsWith('/compose')) return await composePage();
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
    // 控制台留一份完整堆栈：页面上只显示一句话，排查时得有原始错误
    console.error('[route]', hash, e);
    view.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  } finally {
    // 只有最后一次路由算数，避免快速切页时前一次把进度条提前关掉
    if (seq === routeSeq) hideRouteBar();
  }
}

window.addEventListener('hashchange', route);

/* 图片点击放大：统一事件委托，动态渲染的内容无需逐个绑定 */
document.addEventListener(
  'click',
  (e) => {
    const img = e.target instanceof Element ? e.target.closest('img.zoomable') : null;
    if (!img) return;
    e.preventDefault();
    e.stopPropagation();
    openImage(img.getAttribute('src') || '', img.getAttribute('alt') || '');
  },
  false,
);

route();
