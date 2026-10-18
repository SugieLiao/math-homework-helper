import { api } from './api.js';
import { esc, toast, busy, idle } from './util.js';

const PRESETS = [
  {
    name: '火山方舟 · Agent Plan（ark- 开头专属 Key）',
    // Agent Plan 个人版专属 Key 必须走 /api/plan/v3，用 /api/v3 会 401（官方也会额外计费）
    base: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    models: ['ark-code-latest', 'doubao-seed-2-1-pro', 'doubao-seed-2-1-lite', 'doubao-seed-2-1-turbo', 'Auto'],
  },
  {
    name: '火山方舟 · 标准 Key（/api/v3）',
    base: 'https://ark.cn-beijing.volces.com/api/v3',
    // 前三个是「预置推理接入点」，填模型名即可用，无需自己建接入点
    models: [
      'doubao-seed-2-0-mini-260428',
      'doubao-seed-2-0-pro-260215',
      'doubao-seed-1-8-251228',
      'doubao-seed-1-6-vision-250815',
      'doubao-seed-1-6-251015',
      'doubao-1.5-vision-pro-32k-250115',
    ],
  },
  {
    name: '智谱 GLM（视觉模型免费）',
    base: 'https://open.bigmodel.cn/api/paas/v4',
    // 实测：glm-5.3-flash 能读图（视觉可用）；glm-5.3 是纯文本，只能出题/讲解。
    // glm-4.6v-flash / glm-4v-flash 是老一代视觉模型，也能读图。
    models: [
      'glm-4.6v-flash',
      'glm-4.6v',
      'glm-5v-turbo',
      'glm-4.1v-thinking-flash',
      'glm-5.3-flash',
      'glm-5.3',
    ],
  },
  {
    name: '阿里云百炼 · 通义千问',
    base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen3-vl-plus', 'qwen3-vl-flash', 'qwen-vl-max-latest', 'qwen2.5-vl-72b-instruct'],
  },
  {
    name: '硅基流动 SiliconFlow',
    base: 'https://api.siliconflow.cn/v1',
    models: [
      'Qwen/Qwen2.5-VL-72B-Instruct',
      'Qwen/Qwen3-VL-32B-Instruct',
      'Qwen/Qwen2.5-VL-32B-Instruct',
    ],
  },
  {
    name: '腾讯混元',
    base: 'https://api.hunyuan.cloud.tencent.com/v1',
    models: ['hunyuan-vision', 'hunyuan-turbo-vision'],
  },
  {
    name: 'OpenAI',
    base: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
  },
];

const GRADES = ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级'];

export async function renderSettings() {
  const view = document.getElementById('view');
  view.innerHTML = `<div class="empty">加载中…</div>`;
  let s;
  let profiles = [];
  try {
    const d = await api.get('/settings');
    s = d.settings;
    profiles = d.profiles || [];
  } catch (e) {
    view.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }

  const findProfile = (id) => profiles.find((x) => x.id === id);
  const activeBlock = (id, fallback) => {
    const p = findProfile(id);
    if (!p) return `<span class="hint">${fallback}</span>`;
    return `<b>${esc(p.name)}</b>（${esc(p.model)}）
      <div class="hint">${esc(p.base_url)} · ${p.api_key_set ? 'Key 已保存' : '缺 Key'}</div>`;
  };

  // 按服务商分组的完整模型下拉（datalist 会按输入框已有文字过滤，改用 select 才看得到全部）
  const modelGroups = PRESETS.map(
    (p) =>
      `<optgroup label="${esc(p.name)}">${p.models
        .map((m) => `<option value="${esc(m)}">${esc(m)}</option>`)
        .join('')}</optgroup>`,
  ).join('');

  view.innerHTML = `
    <h2>设置</h2>

    <div class="card">
      <h3>当前生效的模型</h3>
      <div class="field">
        <label>视觉模型（读照片批改、讲错题）</label>
        ${activeBlock(s.active_vision_profile, '还没启用视觉模型源 —— 在下面模型源库里加一条并启用')}
      </div>
      <div class="field">
        <label>文本 / 推理模型（出举一反三的题，可选）</label>
        ${activeBlock(s.active_text_profile, '未单独启用 —— 出题会自动用上面的视觉模型')}
      </div>
      <div class="hint">要换模型，直接在下面「模型源库」里点「启用」，不用在这里改。</div>
    </div>

    <div class="card">
      <h3>模型源库（保存过的都在这里，随时切换）</h3>
      <div class="hint">
        每家大模型单独存一条，<b>互不覆盖</b>。想比较哪家效果好就都存进来，用「启用」来回切换——
        切到哪家，批改和出题就用哪家，不用重填 Key。
      </div>
      <div id="profile-list"></div>

      <div class="field" style="margin-top:16px">
        <label id="pf_form_label">新增一条源（名字 + 接口 + Key + 模型）</label>
        <input type="hidden" id="pf_id" />
        <input type="text" id="pf_name" placeholder="名字，如「智谱免费视觉」「百炼出题」" />
      </div>
      <div class="field">
        <select id="pf_preset">
          <option value="">— 自定义 / 选个服务商自动填接口和模型 —</option>
          ${PRESETS.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field"><input type="text" id="pf_base" placeholder="接口地址（OpenAI 兼容）" /></div>
      <div class="field">
        <input type="password" id="pf_key" placeholder="API Key" />
        <div class="hint">Key 只保存在云端数据库里，不会出现在网页代码或 GitHub 仓库中。编辑已有源时，Key 留空表示不修改。</div>
      </div>
      <div class="field">
        <select id="pf_model_pick">
          ${modelGroups}
          <option value="__custom">✏️ 手动输入 / ep- 接入点…</option>
        </select>
        <input type="text" id="pf_model" placeholder="模型 / ep- 接入点" style="margin-top:6px" />
        <div class="hint">
          ⚠️ 视觉源必须填<b>能读图的模型</b>（名字里一般带 v / vision / vl）。
          <code>glm-5.3</code>（不带 flash）是纯文本模型，只能存成「文本」用途；
          <code>glm-5.3-flash</code> 实测能读图，可以做视觉源。
        </div>
      </div>
      <div class="field">
        <label>用途</label>
        <select id="pf_kind">
          <option value="vision">视觉模型（能读照片，用于批改作业）</option>
          <option value="text">文本模型（不能读图，只用于出题 / 讲解）</option>
        </select>
      </div>
      <div class="row-end">
        <button class="btn" id="btn-pf-cancel" style="display:none">取消编辑</button>
        <button class="btn primary" id="btn-pf-save">保存到模型源库</button>
      </div>
    </div>

    <div class="card">
      <h3>速度 / 质量</h3>
      <div class="field">
        <label>思考强度</label>
        <select id="thinking_mode">
          <option value="fast" ${s.thinking_mode !== 'deep' ? 'selected' : ''}>快速（推荐 · 一页 15~30 秒）</option>
          <option value="deep" ${s.thinking_mode === 'deep' ? 'selected' : ''}>深度思考（更细，但一页 90~120 秒，常常超时失败）</option>
        </select>
        <div class="hint">
          很多模型（豆包 seed-2-1、智谱 GLM-5.3 等）默认会先在心里打一大段草稿再作答，
          一页作业要 90~120 秒，容易撞上网关超时而失败——这就是之前「批改出错」的原因。
          选「快速」会关掉/压低这段草稿，实测同一页作业从 119 秒降到 18 秒，判题一样准。
        </div>
      </div>
      <div class="row-end"><button class="btn primary" id="btn-save3">保存</button></div>
    </div>

    <div class="card">
      <h3>学生</h3>
      <div class="field">
        <label>年级</label>
        <select id="grade">
          ${GRADES.map((g) => `<option value="${g}" ${s.grade === g ? 'selected' : ''}>${g}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>姓名（打印页会用到，可留空）</label>
        <input type="text" id="student_name" value="${esc(s.student_name)}" />
      </div>
    </div>

    <div class="card">
      <h3>家庭口令（可选）</h3>
      <div class="field">
        <label>口令</label>
        <input type="text" id="passcode" placeholder="留空表示不设口令" />
        <div class="hint">设了之后，打开这个网址需要输入口令才能看到作业照片，保护孩子隐私。</div>
      </div>
      <div class="row-end"><button class="btn primary" id="btn-save2">保存设置</button></div>
    </div>`;

  /* ------------------------------------------------------------ 模型下拉 ⇄ 输入框 */
  const allModels = PRESETS.flatMap((p) => p.models);
  function syncPick(pickId, value) {
    document.getElementById(pickId).value = allModels.includes(value) ? value : '__custom';
  }
  function wireModel(pickId, inputId) {
    syncPick(pickId, document.getElementById(inputId).value.trim());
    document.getElementById(pickId).onchange = (e) => {
      if (e.target.value !== '__custom') document.getElementById(inputId).value = e.target.value;
    };
    document.getElementById(inputId).oninput = (e) => syncPick(pickId, e.target.value.trim());
  }
  wireModel('pf_model_pick', 'pf_model');

  document.getElementById('pf_preset').onchange = (e) => {
    const i = e.target.value;
    if (i === '') return;
    const p = PRESETS[Number(i)];
    document.getElementById('pf_base').value = p.base;
    document.getElementById('pf_model').value = p.models[0];
    syncPick('pf_model_pick', p.models[0]);
    if (!document.getElementById('pf_name').value.trim()) {
      document.getElementById('pf_name').value = p.name.replace(/（.*?）/g, '').trim();
    }
  };

  /* ------------------------------------------------------------ 模型源库 */
  const resetProfileForm = () => {
    ['pf_id', 'pf_name', 'pf_base', 'pf_key', 'pf_model'].forEach((id) => {
      document.getElementById(id).value = '';
    });
    document.getElementById('pf_kind').value = 'vision';
    document.getElementById('pf_form_label').textContent = '新增一条源（名字 + 接口 + Key + 模型）';
    document.getElementById('btn-pf-cancel').style.display = 'none';
    document.getElementById('btn-pf-save').textContent = '保存到模型源库';
    syncPick('pf_model_pick', '');
  };

  document.getElementById('btn-pf-cancel').onclick = resetProfileForm;

  const startEdit = (id) => {
    const p = findProfile(id);
    if (!p) return;
    document.getElementById('pf_id').value = p.id;
    document.getElementById('pf_name').value = p.name;
    document.getElementById('pf_base').value = p.base_url;
    document.getElementById('pf_model').value = p.model;
    document.getElementById('pf_kind').value = p.kind === 'text' ? 'text' : 'vision';
    document.getElementById('pf_key').value = '';
    document.getElementById('pf_key').placeholder = p.api_key_set ? '已保存，留空则不修改' : 'API Key';
    syncPick('pf_model_pick', p.model);
    document.getElementById('pf_form_label').textContent = `编辑「${p.name}」`;
    document.getElementById('btn-pf-cancel').style.display = '';
    document.getElementById('btn-pf-save').textContent = '保存修改';
    window.scrollTo({ top: document.getElementById('profile-list').offsetTop, behavior: 'smooth' });
  };

  const renderProfiles = () => {
    const box = document.getElementById('profile-list');
    if (!box) return;
    if (!profiles.length) {
      box.innerHTML = `<div class="hint">还没有保存任何模型源。在下面填一条，点「保存到模型源库」。</div>`;
      return;
    }
    box.innerHTML = profiles
      .map((p) => {
        const isV = s.active_vision_profile === p.id;
        const isT = s.active_text_profile === p.id;
        return `<div class="pf-row">
          <div class="pf-main">
            <b>${esc(p.name)}</b>
            ${isV ? '<span class="tag ok">视觉·生效中</span>' : ''}
            ${isT ? '<span class="tag ok">文本·生效中</span>' : ''}
            <div class="hint">${esc(p.model)} · ${p.kind === 'text' ? '文本' : '视觉'} · ${p.api_key_set ? 'Key 已保存' : '<span style="color:#c0392b">缺 Key</span>'}</div>
            <div class="hint">${esc(p.base_url)}</div>
          </div>
          <div class="pf-ops">
            <button class="btn" data-act="test" data-id="${p.id}">测试</button>
            <button class="btn" data-act="vision" data-id="${p.id}">启用为视觉</button>
            <button class="btn" data-act="text" data-id="${p.id}">启用为文本</button>
            <button class="btn" data-act="edit" data-id="${p.id}">编辑</button>
            <button class="btn danger" data-act="del" data-id="${p.id}">删除</button>
          </div>
        </div>`;
      })
      .join('');
    box.querySelectorAll('button[data-act]').forEach((b) => {
      b.onclick = () => onProfileAction(b.dataset.act, b.dataset.id);
    });
  };

  const onProfileAction = async (act, id) => {
    const p = findProfile(id);
    if (act === 'edit') {
      startEdit(id);
      return;
    }
    if (act === 'del') {
      if (!confirm(`确定删除「${p ? p.name : id}」这条模型源？`)) return;
      busy('删除中…');
      try {
        await api.del(`/profiles/${id}`);
        await renderSettings();
        toast('已删除');
      } catch (e) {
        idle();
        toast('删除失败：' + e.message);
      }
      return;
    }
    if (act === 'test') {
      busy(`测试「${p ? p.name : ''}」…`);
      try {
        const r = await api.post(`/profiles/${id}/test`, {});
        idle();
        const name = p ? p.name : '';
        if (r.vision && r.vision.ok === false) {
          toast(`「${name}」文字通了，但<b>读图失败</b>：${r.vision.error}`, 9000);
        } else if (r.vision && r.vision.ok) {
          toast(`「${name}」正常：文字 ✓ · 读图 ✓（${r.ms}ms）`, 4000);
        } else {
          toast(`「${name}」连接正常：${r.reply || ''}（${r.ms}ms）`, 4000);
        }
      } catch (e) {
        idle();
        toast(`「${p ? p.name : ''}」测试失败：` + e.message, 6000);
      }
      return;
    }
    busy('切换中…');
    try {
      await api.post(`/profiles/${id}/activate`, { kind: act === 'text' ? 'text' : 'vision' });
      await renderSettings();
      idle();
      toast(`已启用「${p ? p.name : ''}」为${act === 'text' ? '文本模型' : '视觉模型'}`);
    } catch (e) {
      idle();
      toast('切换失败：' + e.message);
    }
  };

  document.getElementById('btn-pf-save').onclick = async () => {
    const base = document.getElementById('pf_base').value.trim();
    const model = document.getElementById('pf_model').value.trim();
    if (!base || !model) {
      toast('接口地址和模型名都要填');
      return;
    }
    const editId = document.getElementById('pf_id').value.trim();
    const body = {
      name: document.getElementById('pf_name').value.trim() || '未命名模型源',
      base_url: base,
      model,
      kind: document.getElementById('pf_kind').value,
    };
    if (editId) body.id = editId;
    const key = document.getElementById('pf_key').value.trim();
    if (key) body.api_key = key;
    busy('保存中…');
    try {
      if (editId) await api.post(`/profiles/${editId}`, body);
      else await api.post('/profiles', body);
      await renderSettings();
      idle();
      toast(editId ? '已保存修改' : '已保存到模型源库');
    } catch (e) {
      idle();
      toast('保存失败：' + e.message);
    }
  };

  renderProfiles();

  /* ------------------------------------------------------------ 学生 / 口令 */
  document.getElementById('btn-save3').onclick = async () => {
    try {
      busy('保存中…');
      await api.post('/settings', { thinking_mode: document.getElementById('thinking_mode').value });
      idle();
      toast('已保存');
    } catch (e) {
      idle();
      toast(e.message);
    }
  };

  document.getElementById('btn-save2').onclick = async () => {
    const body = {
      grade: document.getElementById('grade').value,
      student_name: document.getElementById('student_name').value.trim(),
    };
    const pass = document.getElementById('passcode').value.trim();
    if (pass) {
      body.passcode = pass;
      localStorage.setItem('mh_pass', pass);
    }
    try {
      busy('保存中…');
      await api.post('/settings', body);
      idle();
      toast('已保存');
    } catch (e) {
      idle();
      toast(e.message);
    }
  };
}
