import { api } from './api.js';
import { esc, toast, busy, idle, confirmDialog } from './util.js';

const TB_KEY = 'mh_textbook';

let textbooks = [];
let tree = []; // [{id,name,is_custom,lessons:[...]}]
let currentTb = '';

export async function renderTextbook() {
  const view = document.getElementById('view');
  view.innerHTML = `<div class="empty">加载中…</div>`;
  try {
    const tbs = await api.get('/textbooks');
    textbooks = tbs.textbooks || [];
  } catch (e) {
    view.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  const remember = localStorage.getItem(TB_KEY) || '';
  currentTb = textbooks.some((t) => t.id === remember) ? remember : textbooks[0]?.id || '';
  await loadTree();
  draw();
}

async function loadTree() {
  try {
    const d = await api.get(currentTb ? `/textbook?textbook=${encodeURIComponent(currentTb)}` : '/textbook');
    tree = d.units || [];
  } catch (e) {
    tree = [];
    toast(e.message);
  }
}

function unitOptions() {
  return tree.map((u) => `<option value="${esc(u.id)}">${esc(u.name)}</option>`).join('');
}

function draw() {
  const view = document.getElementById('view');
  view.innerHTML = `
    <h2>教材大纲</h2>

    <div class="card">
      <div class="row wrap">
        <label style="min-width:72px">教材</label>
        <select id="tb-pick" style="flex:1;min-width:150px">
          ${textbooks
            .map((t) => `<option value="${esc(t.id)}" ${t.id === currentTb ? 'selected' : ''}>${esc(t.name)}</option>`)
            .join('')}
        </select>
      </div>
      <div class="field" style="margin-top:10px">
        <label>新建教材（比如「北师大版 四年级下册」）</label>
        <input type="text" id="n-tb-name" placeholder="教材名称" />
      </div>
      <div class="row-end"><button class="btn" id="btn-new-tb">新建教材</button></div>
    </div>

    <div class="card">
      <h3>新建课文</h3>
      <div class="field">
        <label>放在哪个单元</label>
        <select id="n-unit">${unitOptions()}</select>
      </div>
      <div class="field">
        <label>课文名称</label>
        <input type="text" id="n-lesson" placeholder="如：一单元复习 / 邓老师题单二单元" />
      </div>
      <div class="row-end"><button class="btn primary" id="btn-new-lesson">新建课文</button></div>

      <div class="field" style="margin-top:14px">
        <label>或者在这个教材下新建一个单元</label>
        <input type="text" id="n-unit-name" placeholder="如：专项练习 / 期末冲刺" />
      </div>
      <div class="row-end"><button class="btn" id="btn-new-unit">新建单元</button></div>
    </div>

    <div id="tree"></div>`;

  document.getElementById('tb-pick').onchange = async (e) => {
    currentTb = e.target.value;
    localStorage.setItem(TB_KEY, currentTb);
    await loadTree();
    draw();
  };

  document.getElementById('btn-new-tb').onclick = async () => {
    const name = document.getElementById('n-tb-name').value.trim();
    if (!name) return toast('先填教材名称');
    busy('新建中…');
    try {
      const r = await api.post('/textbooks', { name });
      currentTb = r.id;
      localStorage.setItem(TB_KEY, currentTb);
      const tbs = await api.get('/textbooks');
      textbooks = tbs.textbooks || [];
      await loadTree();
      idle();
      draw();
      toast('已新建教材');
    } catch (e) {
      idle();
      toast(e.message);
    }
  };

  document.getElementById('btn-new-lesson').onclick = async () => {
    const name = document.getElementById('n-lesson').value.trim();
    if (!name) return toast('先填课文名称');
    busy('新建中…');
    try {
      await api.post('/lessons', { name, unit_id: document.getElementById('n-unit').value, textbook_id: currentTb });
      await loadTree();
      idle();
      draw();
      toast('已新建课文');
    } catch (e) {
      idle();
      toast(e.message);
    }
  };

  document.getElementById('btn-new-unit').onclick = async () => {
    const name = document.getElementById('n-unit-name').value.trim();
    if (!name) return toast('先填单元名称');
    busy('新建中…');
    try {
      await api.post('/units', { name, textbook_id: currentTb });
      await loadTree();
      idle();
      draw();
      toast('已新建单元');
    } catch (e) {
      idle();
      toast(e.message);
    }
  };

  drawTree();
}

function drawTree() {
  const box = document.getElementById('tree');
  if (!box) return;
  if (!tree.length) {
    box.innerHTML = `<div class="card"><div class="hint">这本教材还没有单元，在上面新建一个。</div></div>`;
    return;
  }
  box.innerHTML = tree
    .map(
      (u) => `
      <div class="card">
        <div class="row wrap">
          <h3 style="margin:0">${esc(u.name)}</h3>
          <span class="spacer"></span>
          ${u.is_custom ? `<button class="btn danger sm" data-del-unit="${esc(u.id)}">删除单元</button>` : '<span class="small muted">教材自带</span>'}
        </div>
        <div style="margin-top:10px">
          ${
            u.lessons.length
              ? u.lessons
                  .map(
                    (l) => `<div class="pf-row" style="padding:7px 0">
                      <div class="pf-main"><span>${l.sort ? `<span class="small muted" style="margin-right:6px">${esc(String(l.sort))}.</span>` : ''}${esc(l.name)}</span>
                        ${l.is_custom ? '<span class="tag">自建</span>' : ''}
                      </div>
                      <div class="pf-ops">
                        <a class="btn sm" href="#/textbook/l/${esc(l.id)}">看作业</a>
                        ${l.is_custom ? `<button class="btn danger" data-del-lesson="${esc(l.id)}">删除</button>` : ''}
                      </div>
                    </div>`,
                  )
                  .join('')
              : '<div class="hint">这个单元还没有课文，可以在上面新建。</div>'
          }
        </div>
      </div>`,
    )
    .join('');

  const refresh = async () => {
    await loadTree();
    draw();
  };

  box.querySelectorAll('[data-del-lesson]').forEach((b) => {
    b.onclick = async () => {
      const ok = await confirmDialog('关联的作业会变成「未归类」，作业本身不会被删。', {
        title: '删除这条自建课文？',
      });
      if (!ok) return;
      busy('删除中…');
      try {
        await api.del(`/lessons/${b.dataset.delLesson}`);
        await refresh();
        idle();
        toast('已删除');
      } catch (e) {
        idle();
        toast(e.message);
      }
    };
  });
  box.querySelectorAll('[data-del-unit]').forEach((b) => {
    b.onclick = async () => {
      const ok = await confirmDialog('这个单元和它下面的全部课文都会删掉；作业不会被删，只会变成未归类。', {
        title: '删除这个自建单元？',
      });
      if (!ok) return;
      busy('删除中…');
      try {
        await api.del(`/units/${b.dataset.delUnit}`);
        await refresh();
        idle();
        toast('已删除');
      } catch (e) {
        idle();
        toast(e.message);
      }
    };
  });
}
