import { api } from './api.js';
import { esc, nl2br, toast, busy, idle, fmtDate, compressImage } from './util.js';
import { masteryBadge, editDialog, showQueueTip } from './app.js';

const view = () => document.getElementById('view');

function variantRow(v, parent) {
  const statusBadge =
    v.status === 'correct'
      ? '<span class="badge pass">做对了</span>'
      : v.status === 'wrong'
      ? '<span class="badge wrong">做错了</span>'
      : '<span class="badge gray">待完成</span>';
  return `
  <div class="variant-item" data-v="${v.id}">
    <input type="checkbox" class="vcheck" data-act="sel" data-id="${v.id}" ${Number(v.selected) ? 'checked' : ''} />
    <div class="variant-body">
      <div class="row wrap">
        <b>变式 ${v.seq}</b>
        ${statusBadge}
        <span class="badge gray">${esc(v.difficulty || '同等')}</span>
        <span class="spacer"></span>
        <span class="small muted">${v.done_at ? fmtDate(v.done_at) : ''}</span>
      </div>
      <div class="stem" style="font-size:15px;margin:4px 0">${nl2br(v.stem)}</div>
      ${v.student_answer ? `<div class="small">作答：<b>${esc(v.student_answer)}</b></div>` : ''}
      ${v.comment ? `<div class="small muted">${esc(v.comment)}</div>` : ''}
      <div class="row wrap" style="margin-top:6px">
        <button class="btn sm" data-act="toggle-ans" data-id="${v.id}">看答案</button>
        <button class="btn sm ok" data-act="mark" data-id="${v.id}" data-st="correct">标为做对</button>
        <button class="btn sm danger" data-act="mark" data-id="${v.id}" data-st="wrong">标为做错</button>
        <button class="btn sm ghost" data-act="mark" data-id="${v.id}" data-st="pending">重置</button>
      </div>
      <div class="solbox hidden" data-ans="${v.id}">
        <div class="t">标准答案</div><pre class="sol">${esc(v.answer)}</pre>
        <div class="t" style="margin-top:6px">讲解</div><pre class="sol">${esc(v.solution)}</pre>
      </div>
    </div>
  </div>`;
}

export async function renderQuestion(id) {
  view().innerHTML = `<div class="empty">加载中…</div>`;
  let data;
  try {
    data = await api.get(`/questions/${id}`);
  } catch (e) {
    view().innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  const q = data.question;
  const m = q.mastery;
  const vs = q.variants || [];
  const ok = Number(q.is_correct) === 1;

  const ratio = Math.min(1, m.need ? m.correct_after_last_wrong / m.need : 1);
  view().innerHTML = `
    <div class="card q-card ${ok ? 'correct' : 'wrong'}">
      <div class="row wrap">
        <h2 style="margin:0">母题 ${esc(q.no)}</h2>
        <span class="badge ${ok ? 'pass' : 'wrong'}">${ok ? '做对了' : '做错了'}</span>
        ${q.knowledge ? `<span class="badge gray">${esc(q.knowledge)}</span>` : ''}
        <span class="spacer"></span>
        ${masteryBadge(m)}
      </div>
      <div class="stem" style="font-size:17px">${nl2br(q.stem)}</div>
      <div class="answer-line">作答：<b>${esc(q.student_answer || '（空白）')}</b> · 正确答案：<b>${esc(q.correct_answer)}</b></div>
      ${q.answer_image_key ? `<img class="ans-img zoomable" src="${api.imgUrl(q.answer_image_key)}" alt="作答图片" />` : ''}
      ${!ok && q.error_reason ? `<div class="solbox"><div class="t">错在哪里</div><pre class="sol">${esc(q.error_reason)}</pre></div>` : ''}
      ${!ok && q.solution ? `<div class="solbox"><div class="t">正确做法</div><pre class="sol">${esc(q.solution)}</pre></div>` : ''}
      <div class="row-end noprint" style="margin-top:10px">
        <button class="btn sm" id="btn-edit-mother">改判母题</button>
      </div>
    </div>

    <div class="card">
      <div class="row wrap">
        <h3 style="margin:0">举一反三</h3>
        <span class="spacer"></span>
        <span class="small muted">选了 ${m.variant_selected} 题 · 做了 ${m.variant_done} 题 · 做对 ${m.variant_correct} 题</span>
      </div>
      <div class="progress ${m.passed ? '' : 'warn'}"><i style="width:${Math.round(ratio * 100)}%"></i></div>
      <div class="small muted">${m.passed ? '已完全过关 🎉' : `再做对 ${Math.max(0, m.need - m.correct_after_last_wrong)} 道同类题就过关`}</div>
      <div class="row wrap noprint" style="margin-top:12px">
        <button class="btn primary" id="btn-gen">✨ 生成类似题</button>
        <button class="btn" id="btn-to-queue">＋ 加入组卷</button>
        <button class="btn ok" id="btn-vphoto">📷 拍照交答案</button>
        <button class="btn" id="btn-valbum">🖼 从相册选</button>
      </div>
      <div id="vlist" style="margin-top:8px">
        ${vs.length ? vs.map((v) => variantRow(v, q)).join('') : '<div class="empty">还没有类似题，点「生成类似题」试试</div>'}
      </div>
    </div>
    <div class="noprint" style="margin-top:10px"><a class="btn ghost" href="#/s/${q.submission_id}">← 返回作业</a></div>`;

  bindVariantActions(q);
  document.getElementById('btn-edit-mother').onclick = () => editDialog(q);
}

function bindVariantActions(q) {
  document.querySelectorAll('[data-act=toggle-ans]').forEach((b) => {
    b.onclick = () => {
      const box = document.querySelector(`[data-ans="${b.dataset.id}"]`);
      box.classList.toggle('hidden');
    };
  });
  document.querySelectorAll('[data-act=mark]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api.patch(`/variants/${b.dataset.id}`, { status: b.dataset.st });
        toast('已更新');
        await renderQuestion(q.id);
      } catch (e) {
        toast(e.message);
      }
    };
  });
  document.querySelectorAll('[data-act=sel]').forEach((cb) => {
    cb.onchange = async () => {
      const ids = Array.from(document.querySelectorAll('[data-act=sel]'))
        .filter((x) => x.checked)
        .map((x) => x.dataset.id);
      try {
        await api.post('/variants/select', { parent_id: q.id, ids });
      } catch (e) {
        toast(e.message);
      }
    };
  });

  document.getElementById('btn-gen').onclick = async () => {
    busy('老师在出题…');
    try {
      const r = await api.post(`/questions/${q.id}/variants/generate`, { count: 6 });
      toast(`出了 ${r.variants.length} 道类似题，勾选要练的吧`);
      await renderQuestion(q.id);
    } catch (e) {
      toast(e.message, 4000);
    } finally {
      idle();
    }
  };

  // 勾选的变式题加入「待组卷」，出卷 / 打印统一去组卷模块做
  document.getElementById('btn-to-queue').onclick = async () => {
    const ids = Array.from(document.querySelectorAll('[data-act=sel]'))
      .filter((x) => x.checked)
      .map((x) => x.dataset.id);
    if (!ids.length) return toast('先勾选要加入组卷的题目');
    try {
      // 先记住勾选状态，下次进来还能看到选了哪几道
      await api.post('/variants/select', { parent_id: q.id, ids });
      const r = await api.post('/paper-queue', { variant_ids: ids });
      if (r.added === 0 && r.skipped) toast(`这 ${r.skipped} 道本来就在待组卷里，共 ${r.total} 道`);
      else toast(`已加入待组卷 ${r.added} 道${r.skipped ? `（${r.skipped} 道本来就在）` : ''}，共 ${r.total} 道`);
      showQueueTip(r.total);
    } catch (e) {
      toast(e.message);
    }
  };

  const fi = document.getElementById('file-variant');
  const fiAlbum = document.getElementById('file-variant-album');
  const openPicker = (input) => {
    input.dataset.parent = q.id;
    input.click();
  };
  document.getElementById('btn-vphoto').onclick = () => openPicker(fi);
  document.getElementById('btn-valbum').onclick = () => openPicker(fiAlbum);
}

/* 拍照 / 从相册选 上传举一反三答案 */
async function handleVariantFile(input) {
  const file = input.files && input.files[0];
  const parentId = input.dataset.parent;
  input.value = '';
  if (!file || !parentId) return;
  try {
    busy('老师在批改…');
    const small = await compressImage(file);
    const r = await api.upload(`/questions/${parentId}/variant-answer`, small, {});
    idle();
    const n = (r.graded || []).length;
    toast(`批改完成，识别到 ${n} 道`);
    await renderQuestion(parentId);
  } catch (e) {
    idle();
    toast(e.message, 4000);
  }
}
document.getElementById('file-variant').addEventListener('change', (ev) => handleVariantFile(ev.target));
document.getElementById('file-variant-album').addEventListener('change', (ev) => handleVariantFile(ev.target));

/* ------------------------------------------------ 打印页 */
export async function renderPrint(parentId) {
  view().innerHTML = `<div class="empty">加载中…</div>`;
  let data;
  try {
    data = await api.get(`/questions/${parentId}`);
  } catch (e) {
    view().innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  const q = data.question;
  const vs = (q.variants || []).filter((v) => Number(v.selected) === 1);
  if (!vs.length) {
    view().innerHTML = `<div class="empty">还没有勾选要打印的题目<br/><a class="btn" href="#/q/${parentId}" style="margin-top:12px">回去勾选</a></div>`;
    return;
  }
  view().innerHTML = `
    <div class="card noprint">
      <div class="row wrap">
        <h3 style="margin:0">共 ${vs.length} 题，确认后打印</h3>
        <span class="spacer"></span>
        <button class="btn primary" onclick="window.print()">🖨 打印</button>
        <a class="btn" href="#/q/${parentId}">返回</a>
      </div>
      <div class="hint">打印后让孩子把答案写在空白格里，做完拍照上传到母题页的「拍照交答案」。</div>
    </div>
    <div class="card">
      <div class="print-head" style="margin-bottom:10px">
        <div class="row" style="font-size:15px">
          <b>举一反三练习</b><span class="spacer"></span>
          <span>姓名：<u>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</u></span>
          <span>日期：<u>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</u></span>
        </div>
      </div>
      <div style="font-size:13px;color:var(--ink-3);margin-bottom:10px">母题 ${esc(q.no)}：${esc(q.stem)}</div>
      ${vs
        .map(
          (v, i) => `
        <div class="p-item">
          <div><b>${i + 1}.</b> <span class="small muted">（母题${esc(q.no)}-变式${v.seq}）</span>
          <span class="p-stem" style="display:inline">${nl2br(v.stem)}</span></div>
          <div class="p-blank"></div>
        </div>`,
        )
        .join('')}
    </div>`;
}
