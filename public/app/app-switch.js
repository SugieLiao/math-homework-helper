/* 应用切换器 —— kids.liaohao.cc 下三个小应用互跳
 *
 * 用法（一行，加到页面任意位置，建议 </body> 前）：
 *   <script src="https://kids.liaohao.cc/app/app-switch.js" data-app="math"></script>
 *
 * data-app    必填：当前应用 id（math / dictation / recitation），用来标「当前」并跳过自己
 * data-mount  可选：CSS 选择器，指定把哪个元素变成切换入口（默认自动找 header h1 / .brand / h1）
 * data-label  可选：覆盖入口文字（不给就用原元素里的文字）
 *
 * 脚本自带样式，不依赖宿主应用的 CSS；脚本加载失败时，原来的标题照常显示，页面不受影响。
 */
(function () {
  var APPS = [
    { id: 'math', emoji: '📐', name: '数学家', desc: '拍照批改 · 举一反三', url: 'https://kids.liaohao.cc/math/' },
    { id: 'dictation', emoji: '🎧', name: '听写小助手', desc: '语文生字词 · 英语单词', url: 'https://kids.liaohao.cc/dictation/' },
    { id: 'recitation', emoji: '🌱', name: '背书芽', desc: '课文 · 诗词跟读背诵', url: 'https://kids.liaohao.cc/recitation/' },
  ];

  // 允许宿主页面用 window.KIDS_APPS 覆盖（比如以后加第四个应用）
  if (window.KIDS_APPS && window.KIDS_APPS.length) APPS = window.KIDS_APPS;

  var script = document.currentScript;
  var conf = {
    app: (script && script.getAttribute('data-app')) || '',
    mount: (script && script.getAttribute('data-mount')) || '',
    label: (script && script.getAttribute('data-label')) || '',
  };

  /* ------------------------------------------------ 样式 */
  var CSS_ID = 'kids-apsw-style';
  function ensureCss() {
    if (document.getElementById(CSS_ID)) return;
    var css = [
      '.kids-apsw-btn{display:inline-flex;align-items:center;gap:5px;cursor:pointer;user-select:none;-webkit-tap-highlight-color:transparent;}',
      '.kids-apsw-btn:hover .kids-apsw-txt{opacity:.75}',
      '.kids-apsw-caret{font-size:10px;opacity:.55;transform:translateY(1px);transition:transform .15s;}',
      '.kids-apsw-btn.open .kids-apsw-caret{transform:rotate(180deg);}',
      '.kids-apsw-mask{position:fixed;inset:0;z-index:2147483000;}',
      '.kids-apsw-panel{position:fixed;z-index:2147483001;min-width:236px;max-width:calc(100vw - 24px);',
      'background:#fff;border:1px solid rgba(0,0,0,.08);border-radius:14px;',
      'box-shadow:0 12px 32px rgba(31,36,48,.18);padding:6px;',
      'font:15px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",Arial,sans-serif;',
      'animation:kids-apsw-in .13s ease-out;}',
      '@keyframes kids-apsw-in{from{opacity:0;transform:translateY(-4px);}to{opacity:1;transform:none;}}',
      '.kids-apsw-row{display:flex;align-items:center;gap:10px;width:100%;padding:9px 10px;border:0;border-radius:10px;',
      'background:transparent;text-align:left;font:inherit;color:#2b2f38;cursor:pointer;}',
      '.kids-apsw-row:hover{background:#f4f6fb;}',
      '.kids-apsw-row.cur{background:#eef3ff;}',
      '.kids-apsw-emo{font-size:20px;line-height:1;flex:0 0 auto;}',
      '.kids-apsw-body{flex:1;min-width:0;}',
      '.kids-apsw-name{display:block;font-weight:600;}',
      '.kids-apsw-desc{display:block;font-size:11px;color:#8a90a0;line-height:1.35;}',
      '.kids-apsw-tag{font-size:11px;font-weight:600;color:#3a6df0;flex:0 0 auto;}',
    ].join('');
    var st = document.createElement('style');
    st.id = CSS_ID;
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ------------------------------------------------ 找挂载点 */
  function findMount() {
    if (conf.mount) {
      var el = document.querySelector(conf.mount);
      if (el) return el;
    }
    var sels = ['header h1', 'header .brand', '.topbar h1', '.navbar h1', '.brand', 'h1'];
    for (var i = 0; i < sels.length; i++) {
      var n = document.querySelector(sels[i]);
      if (n && n.textContent.trim()) return n;
    }
    return null;
  }

  /* ------------------------------------------------ 渲染 */
  function build(host) {
    ensureCss();
    // 把原标题包成一个可点的按钮（保留原来的文字和样式，只加一个小三角）
    var btn = document.createElement('span');
    btn.className = 'kids-apsw-btn';
    btn.setAttribute('role', 'button');
    btn.setAttribute('aria-haspopup', 'true');
    btn.title = '切换应用';
    var txt = document.createElement('span');
    txt.className = 'kids-apsw-txt';
    txt.innerHTML = conf.label ? escHtml(conf.label) : host.innerHTML;
    var caret = document.createElement('span');
    caret.className = 'kids-apsw-caret';
    caret.textContent = '▼';
    btn.appendChild(txt);
    btn.appendChild(caret);
    host.innerHTML = '';
    host.appendChild(btn);

    var panel = null;
    var mask = null;

    function close() {
      if (mask) mask.remove();
      if (panel) panel.remove();
      mask = null;
      panel = null;
      btn.classList.remove('open');
      document.removeEventListener('keydown', onKey, true);
    }

    function onKey(e) {
      if (e.key === 'Escape') close();
    }

    function place() {
      var r = btn.getBoundingClientRect();
      var w = panel.offsetWidth;
      var left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - w - 8));
      var top = r.bottom + 8;
      // 下面放不下就翻到上面
      if (top + panel.offsetHeight > window.innerHeight - 8) {
        top = Math.max(8, r.top - panel.offsetHeight - 8);
      }
      panel.style.left = left + 'px';
      panel.style.top = top + 'px';
    }

    function open() {
      if (panel) {
        close();
        return;
      }
      mask = document.createElement('div');
      mask.className = 'kids-apsw-mask';
      mask.addEventListener('click', close);

      panel = document.createElement('div');
      panel.className = 'kids-apsw-panel';
      APPS.forEach(function (a) {
        var row = document.createElement('button');
        row.type = 'button';
        row.className = 'kids-apsw-row' + (a.id === conf.app ? ' cur' : '');
        row.innerHTML =
          '<span class="kids-apsw-emo">' + escHtml(a.emoji || '') + '</span>' +
          '<span class="kids-apsw-body">' +
          '<span class="kids-apsw-name">' + escHtml(a.name) + '</span>' +
          (a.desc ? '<span class="kids-apsw-desc">' + escHtml(a.desc) + '</span>' : '') +
          '</span>' +
          (a.id === conf.app ? '<span class="kids-apsw-tag">当前</span>' : '');
        row.addEventListener('click', function () {
          if (a.id === conf.app) {
            close();
            return;
          }
          // 直接整体跳转：新应用在同一个标签页里打开（等于「刷新出另一个应用」）
          window.location.href = a.url;
        });
        panel.appendChild(row);
      });
      document.body.appendChild(mask);
      document.body.appendChild(panel);
      place();
      btn.classList.add('open');
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('resize', place, { once: true });
      window.addEventListener('scroll', close, { once: true, passive: true });
    }

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      open();
    });
  }

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function start() {
    var host = findMount();
    if (!host) return;
    build(host);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
