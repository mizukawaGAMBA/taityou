/* くまの記録 — app.js
 * ビルド不要の素のJavaScript。画面は1ファイルで完結する。
 * 方針: 押した瞬間に画面を更新し(楽観的更新)、送信はキューで裏側に行う。
 *       通信が遅い・切れている時でも「記録できた」体験を途切れさせない。 */
(function () {
  'use strict';

  /* ========== 保存(localStorage) ========== */
  const KEYS = { cfg: 'kuma.cfg', state: 'kuma.state', queue: 'kuma.queue', idmap: 'kuma.idmap' };
  function load(k, def) { try { const v = localStorage.getItem(k); return v === null ? def : JSON.parse(v); } catch (e) { return def; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 保存できない環境でも動かす */ } }

  const isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const cfg = Object.assign({ apiUrl: isLocal ? location.origin + '/api' : '', token: '', role: '', name: '' }, load(KEYS.cfg, {}));
  // 配布設定(config.js)に URL があればそれを優先。URL に ?api=… が付いていれば取り込む(家族に送るリンク用)
  // ただし PC のローカル確認(localhost)では使わない。試しの操作が本番のスプレッドシートに入らないようにするため
  const FIXED_API = (!isLocal && window.KUMA_CONFIG && window.KUMA_CONFIG.apiUrl) ? String(window.KUMA_CONFIG.apiUrl).trim() : '';
  if (FIXED_API) cfg.apiUrl = FIXED_API;
  try {
    const qp = new URLSearchParams(location.search);
    if (qp.get('api')) { cfg.apiUrl = qp.get('api').trim(); save(KEYS.cfg, cfg); history.replaceState(null, '', location.pathname); }
  } catch (e) { /* 無視 */ }
  let cache = load(KEYS.state, null);
  let queue = load(KEYS.queue, []);
  let idmap = load(KEYS.idmap, {});

  /* ========== 日付ユーティリティ ========== */
  const pad = (n) => String(n).padStart(2, '0');
  const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fmtTime = (d) => `${fmtDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  // 論理日: 午前4時を日付の境目にする(深夜1時の服薬は「前日の夜」に属する)
  const logicalToday = (now = new Date()) => fmtDate(new Date(now.getTime() - 4 * 3600e3));
  function addDays(ds, n) { const [y, m, d] = ds.split('-').map(Number); return fmtDate(new Date(y, m - 1, d + n)); }
  function daysBetween(a, b) {
    const [y1, m1, d1] = a.split('-').map(Number); const [y2, m2, d2] = b.split('-').map(Number);
    return Math.round((new Date(y2, m2 - 1, d2) - new Date(y1, m1 - 1, d1)) / 86400e3);
  }
  const DOW = ['日', '月', '火', '水', '木', '金', '土'];
  function dowOf(ds) { const [y, m, d] = ds.split('-').map(Number); return new Date(y, m - 1, d).getDay(); }
  function jpDate(ds) { const [, m, d] = ds.split('-').map(Number); return `${m}月${d}日(${DOW[dowOf(ds)]})`; }
  function jpShort(ds) { const [, m, d] = ds.split('-').map(Number); return `${m}/${d}`; }
  const hhmm = (t) => (t && t.length >= 16 ? t.slice(11, 16) : '');
  // 論理日 date の "HH:MM" から taken_at を作る。深夜0〜3時台は翌日の暦日になる
  function takenAtFor(date, hm) { const h = parseInt(hm.slice(0, 2), 10); return `${h < 4 ? addDays(date, 1) : date}T${hm}`; }
  const uid = () => 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
  const isRare = (date) => hash(date + 'kuma') % 7 === 3;

  /* ========== 定数 ========== */
  const KIND_LABEL = { morning: '朝の薬', concerta: 'コンサータ', night: '寝る前の薬', prn: '頓服' };
  const STATUS_LABEL = { all: '全部飲んだ', no_concerta: 'コンサータ以外', partial: '一部だけ', missed: '飲み忘れあり', none: '記録なし', unknown: 'わからない' };
  // 画像とリアクションの定義は docs/images/images.js(window.KUMA_IMAGES)から読む。無い・壊れている時は内蔵の値を使う
  const DEFAULT_REACTIONS = [
    { id: 'heart', label: '見たよ', image: '❤️' }, { id: 'clap', label: 'えらい', image: '👏' },
    { id: 'honey', label: 'おつかれ', image: '🍯' }, { id: 'bear', label: 'だいすき', image: '🐻' }
  ];
  const IMAGES = (function () {
    const src = (window.KUMA_IMAGES && typeof window.KUMA_IMAGES === 'object') ? window.KUMA_IMAGES : null;
    const library = src && src.library && typeof src.library === 'object' ? src.library : {};
    const slots = src && src.slots && typeof src.slots === 'object' ? src.slots : {};
    let reactions = src && Array.isArray(src.reactions) ? src.reactions : DEFAULT_REACTIONS;
    reactions = reactions.filter((r) => r && typeof r === 'object' && /^[a-z0-9_-]{1,32}$/i.test(String(r.id || '')))
      .map((r) => ({ id: String(r.id), label: String(r.label || r.id).slice(0, 30), image: typeof r.image === 'string' ? r.image : '' }));
    if (!reactions.length) reactions = DEFAULT_REACTIONS;
    return { loaded: !!src, library, slots, reactions };
  })();
  const TITLES = ['できた！', 'えらい！', 'ばっちり！', 'おつかれさま！', 'さすが！'];
  const MESSAGES = [
    'きょうも記録できたね。それだけで十分すごい。',
    'つらい日に記録するのが、いちばんえらい。',
    'この数字が、先生に届く。ちゃんと意味がある。',
    'くまはいつでも味方だよ。',
    '20秒のがんばり、見てたよ。',
    'きょうの分は、もうおしまい。あとはゆっくり。',
    '波がある日も、記録は味方になる。',
    'ぐるぐるも痛みも、数字にしたら少し手放せる。',
    'よくがんばった。おふろで温まってね。',
    'ひとつずつで、だいじょうぶ。',
    '休むのも、だいじな仕事。',
    'きょうのあなたに、はちみつ一杯。',
    '記録がたまるほど、先生の判断材料になるよ。',
    'ゆっくりでいい。続いてることがすごい。',
    'つらさを言葉にしなくても、数字が代わりに伝えてくれる。',
    'おつかれさま。あなたの一日を、くまは知ってるよ。',
    '今夜はいい眠りになりますように。',
    'ちいさな一歩が、いちばん強い。',
    'きょうもここに来てくれて、ありがとう。',
    '完璧じゃなくていい。だいたいで、ちょうどいい。',
    'がんばりすぎないのも、がんばり。',
    'この積み重ねが、次の診察の武器になる。',
    'くまも一緒に記録したつもり。',
    'あなたのペースで。それがいちばん続く。',
    'きょうの空、見た？ 記録のあとは深呼吸。',
    'しんどい時ほど、記録は短くていい。'
  ];
  const RARE_MESSAGES = ['レアくま登場！きょうは特別な日。', '王冠くまが出た！たまにしか会えないよ。', 'きらきらスタンプ！運がいい日。'];

  /* ========== 画面の状態 ========== */
  let curDate = logicalToday();
  let tab = 'today';            // サポーター用タブ
  let wiz = null;               // チェックインのウィザード
  let sheet = null;             // 下から出るシート
  let listData = null;          // 一覧用データ
  let toastTimer = null;

  /* ========== API ========== */
  async function call(req) {
    if (!cfg.apiUrl) throw new Error('no_api');
    const res = await fetch(cfg.apiUrl, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({}, req, { token: cfg.token })), redirect: 'follow'
    });
    return await res.json();
  }

  function resolveIds(req) {
    const r = Object.assign({}, req);
    if (r.id && idmap[r.id]) r.id = idmap[r.id];
    if (Array.isArray(r.ids)) r.ids = r.ids.map((id) => idmap[id] || id);
    return r;
  }

  let processing = false;
  async function processQueue() {
    if (processing || !queue.length || !cfg.token) return;
    processing = true; renderSync();
    while (queue.length) {
      const item = queue[0];
      const req = resolveIds(item.req);
      if (req.id && String(req.id).startsWith('c_')) { queue.shift(); save(KEYS.queue, queue); continue; } // 作成に失敗した記録への変更は捨てる
      let data;
      try { data = await call(req); } catch (e) { break; } // 通信できない → 後で再送
      if (!data.ok) {
        if (data.error === 'unauthorized') { processing = false; logout('ログインし直してください'); return; }
        queue.shift(); save(KEYS.queue, queue);
        toast('保存できなかった記録があります: ' + (data.message || data.error));
        continue;
      }
      if (req.action === 'addMed' && data.med && item.req.clientId) idmap[item.req.clientId] = data.med.id;
      if (req.action === 'addMemo' && data.memo && item.req.clientId) idmap[item.req.clientId] = data.memo.id;
      queue.shift(); save(KEYS.queue, queue); save(KEYS.idmap, idmap);
    }
    processing = false; renderSync();
    if (!queue.length) refresh(true);
  }
  window.addEventListener('online', processQueue);

  // 楽観的更新: 先に画面を変え、送信はキューへ
  function enqueue(req, mutate) {
    queue.push({ id: uid(), req });
    save(KEYS.queue, queue);
    if (mutate && cache) { mutate(cache); save(KEYS.state, cache); }
    render();
    processQueue();
  }

  let refreshing = false;
  async function refresh(silent) {
    if (!cfg.token || refreshing) return;
    if (queue.length) { processQueue(); return; } // 未送信があるうちはサーバーの状態で上書きしない
    refreshing = true; renderSync();
    try {
      const data = await call({ action: 'state', date: curDate });
      if (data.ok) { cache = data; save(KEYS.state, cache); render(); }
      else if (data.error === 'unauthorized') logout('ログインし直してください');
      else if (!silent) toast(data.message || '読み込みに失敗しました');
    } catch (e) {
      if (!silent) toast('通信できませんでした。記録はあとで送ります');
    }
    refreshing = false; renderSync();
  }

  function logout(msg) {
    cfg.token = ''; cfg.role = ''; save(KEYS.cfg, cfg);
    cache = null; queue = []; idmap = {}; save(KEYS.state, null); save(KEYS.queue, queue); save(KEYS.idmap, idmap);
    wiz = null; sheet = null; render();
    if (msg) toast(msg);
  }

  /* ========== 服薬のまとめ ========== */
  function medsByKind(meds) {
    const o = { morning: null, concerta: null, night: null, prn: [] };
    (meds || []).forEach((m) => {
      if (m.kind === 'prn') o.prn.push(m);
      else if (!o[m.kind] || m.taken_at < o[m.kind].taken_at) o[m.kind] = m;
    });
    return o;
  }
  function medStatus(meds, log) {
    const k = medsByKind(meds);
    const ans = log && log.meds_answer;
    const partial = [k.morning, k.night, k.concerta].some((m) => m && m.partial && m.partial.length);
    const morning = !!k.morning || ans === 'all' || ans === 'no_concerta';
    const concerta = !!k.concerta || ans === 'all';
    const night = !!k.night;
    if (!k.morning && !k.concerta && !k.night) {
      if (ans === 'missed') return 'missed';
      if (ans === 'unknown') return 'unknown';
      if (!ans) return 'none';
    }
    if (morning && night && concerta) return partial ? 'partial' : 'all';
    if (morning && night && !concerta) return partial ? 'partial' : 'no_concerta';
    return 'missed';
  }
  function medList(settings, kind) {
    const raw = kind === 'morning' ? settings.meds_morning : kind === 'night' ? settings.meds_night : '';
    return String(raw || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }

  /* ========== くま(SVG) ========== */
  function bearSVG(mood, cls) {
    const line = 'stroke="#2E211C" stroke-width="4" fill="none" stroke-linecap="round"';
    const EYES = {
      normal: '<circle cx="77" cy="101" r="6.5" fill="#2E211C"/><circle cx="123" cy="101" r="6.5" fill="#2E211C"/><circle cx="79.5" cy="98.5" r="2" fill="#fff"/><circle cx="125.5" cy="98.5" r="2" fill="#fff"/>',
      happy: `<path d="M69 104 Q77 93 85 104" ${line}/><path d="M115 104 Q123 93 131 104" ${line}/>`,
      sleepy: `<path d="M69 101 Q77 107 85 101" ${line}/><path d="M115 101 Q123 107 131 101" ${line}/>`,
      love: '<path d="M77 109 L67 99 A5.5 5.5 0 0 1 77 93 A5.5 5.5 0 0 1 87 99 Z" fill="#E0566F"/><path d="M123 109 L113 99 A5.5 5.5 0 0 1 123 93 A5.5 5.5 0 0 1 133 99 Z" fill="#E0566F"/>'
    };
    const eyes = EYES[mood === 'crown' || mood === 'cheer' ? 'happy' : mood] || EYES.normal;
    const bigSmile = mood === 'happy' || mood === 'love' || mood === 'crown' || mood === 'cheer';
    const mouth = mood === 'sleepy'
      ? '<ellipse cx="100" cy="139" rx="5" ry="6" fill="#4A3328"/>'
      : bigSmile ? '<path d="M86 134 Q100 150 114 134" stroke="#4A3328" stroke-width="3.5" fill="none" stroke-linecap="round"/>'
        : '<path d="M90 136 Q100 145 110 136" stroke="#4A3328" stroke-width="3.5" fill="none" stroke-linecap="round"/>';
    const extras = mood === 'sleepy'
      ? '<text x="150" y="58" font-size="24" font-weight="700" fill="#8B5E3C" font-family="system-ui">z</text><text x="168" y="40" font-size="17" font-weight="700" fill="#8B5E3C" font-family="system-ui">z</text>'
      : mood === 'love' ? '<text x="148" y="52" font-size="28" fill="#E0566F">♥</text><text x="30" y="40" font-size="18" fill="#E0566F">♥</text>'
        : mood === 'cheer' ? '<text x="150" y="48" font-size="26">✨</text><text x="24" y="60" font-size="20">✨</text>' : '';
    const crown = mood === 'crown' ? '<path d="M68 50 L80 26 L100 44 L120 26 L132 50 Z" fill="#F2B84B" stroke="#C98A17" stroke-width="3" stroke-linejoin="round"/>' : '';
    return `<svg viewBox="0 0 200 200" class="${cls || ''}" aria-hidden="true">
      <circle cx="54" cy="64" r="24" fill="#C8955C"/><circle cx="146" cy="64" r="24" fill="#C8955C"/>
      <circle cx="54" cy="64" r="12" fill="#E8C39E"/><circle cx="146" cy="64" r="12" fill="#E8C39E"/>
      <circle cx="100" cy="112" r="64" fill="#C8955C"/>
      <ellipse cx="100" cy="132" rx="32" ry="23" fill="#F2DEC4"/>
      <circle cx="64" cy="124" r="9" fill="#F4A7B4" opacity="0.75"/><circle cx="136" cy="124" r="9" fill="#F4A7B4" opacity="0.75"/>
      <ellipse cx="100" cy="123" rx="11" ry="7.5" fill="#4A3328"/>
      ${eyes}${mouth}${extras}${crown}</svg>`;
  }

  /* ========== 画像(スロット → ライブラリ → ファイル) ==========
   * images.js の slots で指定された画像を出す。指定が無い・ファイルが読めない時は内蔵のくま(bearSVG)。 */
  const SLOT_MOOD = { title: 'normal', loading: 'normal', normal: 'normal', happy: 'happy', sleepy: 'sleepy', love: 'love', cheer: 'cheer', crown: 'crown', stamp: 'happy', stamp_rare: 'crown' };
  const SLOT_ALIAS = { title: 'normal', loading: 'normal', stamp: 'happy', stamp_rare: 'crown' }; // 空の時に代わりに使うスロット
  const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isNameLike = (s) => /^[A-Za-z0-9_.-]+$/.test(s); // ライブラリ名やファイル名らしい文字列(絵文字ではない)
  const brokenImgs = new Set(); // 読み込みに失敗した画像の src(以後は内蔵のくまに切り替える)
  // 参照(ライブラリ名・ファイル名・URL)を <img> の src にする。画像でなければ(絵文字・見つからない名前) null
  function imgSrc(ref) {
    if (!ref || typeof ref !== 'string') return null;
    const file = hasOwn(IMAGES.library, ref) ? String(IMAGES.library[ref] || '') : ref;
    if (!file) return null;
    if (/^https?:\/\//.test(file) || file.startsWith('data:image/')) return file;
    if (IMG_EXT.test(file) && !/[\/\\]/.test(file)) return 'images/' + file;
    return null;
  }
  const pickRef = (v, seed) => (Array.isArray(v) ? (v.length ? v[hash(seed) % v.length] : '') : v); // 配列なら日替わり
  function slotRef(slot, seed) {
    const s = IMAGES.slots; const d = seed || curDate;
    let ref = pickRef(s[slot], d + slot);
    if (!ref && SLOT_ALIAS[slot]) ref = pickRef(s[SLOT_ALIAS[slot]], d + SLOT_ALIAS[slot]);
    return typeof ref === 'string' ? ref : '';
  }
  // スロットの画像タグ。cls はアニメーション用のクラス、seed は日替わり用(省略時は表示中の日付)
  function pic(slot, cls, seed) {
    const mood = SLOT_MOOD[slot] || 'normal';
    const src = imgSrc(slotRef(slot, seed));
    if (!src || brokenImgs.has(src)) return bearSVG(mood, 'pic ' + (cls || ''));
    return `<img class="pic ${cls || ''}" src="${esc(src)}" alt="" data-mood="${mood}" data-cls="${esc(cls || '')}">`;
  }
  // 絵文字でも画像でもよい小さな絵(ログインのボタンなど)。def は内蔵の絵文字
  function picText(slot, def) {
    const ref = slotRef(slot);
    const src = imgSrc(ref);
    if (src && !brokenImgs.has(src)) return `<img class="pic-sm" src="${esc(src)}" alt="" data-def="${esc(def)}">`;
    return esc(ref && !src && !isNameLike(ref) ? ref : def);
  }
  // リアクションの絵(画像 <img class="rimg"> か絵文字 <span class="remoji">)
  function reactionVisual(def, cls) {
    const src = imgSrc(def.image);
    if (src && !brokenImgs.has(src)) return `<img class="rimg ${cls || ''}" src="${esc(src)}" alt="">`;
    const t = (!src && def.image && !isNameLike(def.image)) ? def.image : '♡';
    return `<span class="remoji ${cls || ''}">${esc(t)}</span>`;
  }
  const reactionDef = (type) => IMAGES.reactions.find((r) => r.id === type) || null;
  // 画像が読めなかったら、その場で内蔵のくま(または絵文字)に差し替える
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG') return;
    brokenImgs.add(img.getAttribute('src'));
    const cell = img.closest('.img-grid .cell'); if (cell) cell.classList.add('bad');
    const tmp = document.createElement('span');
    if (img.dataset.mood) tmp.innerHTML = bearSVG(img.dataset.mood, 'pic ' + (img.dataset.cls || ''));
    else if (img.classList.contains('rimg')) tmp.innerHTML = `<span class="${esc(img.className.replace('rimg', 'remoji'))}">${img.dataset.lib ? '✕' : '♡'}</span>`;
    else tmp.textContent = img.dataset.def || '♡';
    img.replaceWith(tmp.firstElementChild || tmp);
  }, true);

  /* ========== 紙吹雪 ========== */
  function confetti() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const c = document.createElement('canvas'); c.className = 'confetti';
    c.width = window.innerWidth; c.height = window.innerHeight; document.body.appendChild(c);
    const ctx = c.getContext('2d');
    const colors = ['#F2B84B', '#F08CA3', '#4A86D9', '#4FA86B', '#C8955C', '#FFFFFF'];
    const ps = Array.from({ length: 90 }, () => ({
      x: c.width / 2 + (Math.random() - 0.5) * 120, y: c.height * 0.45,
      vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 14 - 4, g: 0.35 + Math.random() * 0.15,
      w: 6 + Math.random() * 6, h: 8 + Math.random() * 8, r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
      color: colors[Math.floor(Math.random() * colors.length)]
    }));
    const t0 = performance.now();
    (function frame(t) {
      const el = (t - t0) / 1000;
      ctx.clearRect(0, 0, c.width, c.height);
      ps.forEach((p) => {
        p.vy += p.g; p.x += p.vx; p.y += p.vy; p.r += p.vr; p.vx *= 0.99;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.globalAlpha = Math.max(0, 1 - el / 1.8);
        ctx.fillStyle = p.color; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
      });
      if (el < 1.9) requestAnimationFrame(frame); else c.remove();
    })(t0);
  }

  /* ========== トースト ========== */
  function toast(msg, action) {
    const el = document.getElementById('toast');
    el.innerHTML = `<div class="toast"><span>${esc(msg)}</span>${action ? `<button data-act="toast-action">${esc(action.label)}</button>` : ''}</div>`;
    el._action = action ? action.onClick : null;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.innerHTML = ''; el._action = null; }, action ? 7000 : 3500);
  }

  /* ========== 画面: ログイン ========== */
  let loginRole = 'patient';
  function viewLogin() {
    return `<div class="login">
      <div class="hero">${pic('title', 'bear-bob')}<h1>くまの記録</h1><p class="muted">毎日の体調と服薬を、20秒で。</p></div>
      <form id="login-form" class="card">
        ${FIXED_API
          ? `<input type="hidden" name="apiUrl" value="${esc(cfg.apiUrl)}">`
          : `<label class="field"><span>API のURL(Apps Script のウェブアプリURL)</span>
          <input type="url" name="apiUrl" value="${esc(cfg.apiUrl)}" placeholder="https://script.google.com/macros/s/…/exec" required autocomplete="off"></label>`}
        <label class="field"><span>家族コード</span><input type="password" name="code" required autocomplete="current-password"></label>
        <span class="small muted" style="display:block;margin-bottom:6px;font-weight:600">わたしは…</span>
        <div class="role-grid">
          <button type="button" class="btn ${loginRole === 'patient' ? 'sel' : ''}" data-act="login-role" data-role="patient">${picText('role_patient', '🐻')} 記録する人<small class="sub">本人</small></button>
          <button type="button" class="btn ${loginRole === 'supporter' ? 'sel' : ''}" data-act="login-role" data-role="supporter">${picText('role_supporter', '🧸')} サポーター<small class="sub">家族</small></button>
        </div>
        <label class="field"><span>名前(表示に使います)</span><input type="text" name="name" value="${esc(cfg.name)}" placeholder="${loginRole === 'patient' ? '例: はなこ' : '例: たろう'}"></label>
        <div id="login-error" class="error"></div>
        <button type="submit" class="btn primary big" style="margin-top:8px">はじめる</button>
      </form>
    </div>`;
  }

  async function doLogin(form) {
    const f = new FormData(form);
    const url = String(f.get('apiUrl') || '').trim();
    const code = String(f.get('code') || '');
    const name = String(f.get('name') || '').trim();
    const err = form.querySelector('#login-error');
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true; err.textContent = '';
    cfg.apiUrl = url;
    try {
      const data = await call({ action: 'login', code, role: loginRole, name });
      if (!data.ok) { err.textContent = data.message || 'ログインできませんでした'; btn.disabled = false; return; }
      cfg.token = data.token; cfg.role = data.role; cfg.name = name; save(KEYS.cfg, cfg);
      curDate = logicalToday(); cache = null; render(); refresh();
    } catch (e) {
      err.textContent = 'URL に接続できませんでした。URL を確認してください';
      btn.disabled = false;
    }
  }

  /* ========== 画面: 共通パーツ ========== */
  function topbar(title, right) {
    return `<header class="topbar"><div class="date">${title}<small id="sync" class="sync-badge"></small></div>${right || ''}</header>`;
  }
  function renderSync() {
    const el = document.getElementById('sync');
    if (!el) return;
    if (queue.length) { el.textContent = `未送信 ${queue.length}件`; el.className = 'sync-badge pending'; }
    else if (refreshing) { el.textContent = '更新中…'; el.className = 'sync-badge'; }
    else { el.textContent = ''; el.className = 'sync-badge'; }
  }

  function medsCard(data, date, focus) {
    const k = medsByKind(data.meds);
    const s = data.settings;
    const btn = (kind) => {
      const m = k[kind];
      const label = kind === 'concerta' ? (s.concerta_label || 'コンサータ') : KIND_LABEL[kind];
      if (m) {
        const partial = m.partial && m.partial.length;
        return `<button class="btn med-btn ${partial ? 'partial' : 'taken'}" data-act="med-edit" data-id="${esc(m.id)}">
          <span class="label">${esc(label)}</span><span class="time">${hhmm(m.taken_at)} <span class="check">${partial ? '一部' : '✓'}</span></span></button>`;
      }
      return `<button class="btn med-btn" data-act="med-tap" data-kind="${kind}" data-date="${date}">
        <span class="label">${esc(label)}</span><span class="time">まだ</span></button>`;
    };
    const prn = k.prn.map((m) => `<button class="pill" data-act="med-edit" data-id="${esc(m.id)}">頓服 ${hhmm(m.taken_at)} ✓</button>`).join('');
    return `<section class="card ${focus ? 'focus' : ''}">
      <h2>おくすり <span class="link">飲んだらタップ(時刻が入ります)</span></h2>
      <div class="btn-grid">${btn('morning')}${btn('concerta')}</div>
      <div class="btn-grid" style="margin-top:12px">${btn('night')}
        <button class="btn outline" data-act="med-tap" data-kind="prn" data-date="${date}"><span class="label">頓服を飲んだ</span><span class="sub">必要な時の薬</span></button></div>
      ${prn ? `<div class="pill-list">${prn}</div>` : ''}
      <p class="help">押し忘れた時は、押したあとに「時間を直す」で実際の時刻に変えられます。</p>
    </section>`;
  }

  // ヘルスケア連携(サポーターが共有したショートカット)の状態
  function healthLink(s) {
    s = s || {};
    const name = s.health_shortcut_name || 'くまヘルス送信';
    return { ready: !!s.health_shortcut_url, consent: s.health_consent === '1', url: s.health_shortcut_url || '', name,
      runUrl: 'shortcuts://run-shortcut?name=' + encodeURIComponent(name) };
  }
  function sleepCard(h, s) {
    const hl = healthLink(s);
    const isPatient = cfg.role !== 'supporter';
    if (!h || (h.sleep_min == null && h.steps == null && h.dyskinesia == null)) {
      let body;
      if (isPatient && hl.consent) {
        body = `<p class="muted small" style="margin-bottom:10px">まだ届いていません。</p>
          <a class="btn" href="${esc(hl.runUrl)}">昨夜の眠りを取り込む</a>
          <p class="help">ショートカットが動いて通知が出たら、この画面に戻ってきてね。</p>`;
      } else if (isPatient && hl.ready) {
        body = `<p class="small" style="margin-bottom:10px">Apple Watch の眠りと歩数を、ボタンひとつで取り込めるようにできます。</p>
          <button class="btn" data-act="health-setup">ヘルスケア連携を設定する</button>`;
      } else if (isPatient) {
        body = '<p class="muted">まだ届いていません。<span class="small">(サポーターの準備がすむと、ここから取り込めるようになります)</span></p>';
      } else {
        body = `<p class="muted">まだ届いていません。<span class="small">(${hl.consent ? '本人の iPhone で取り込まれると、ここに出ます' : '本人がヘルスケア連携に同意すると取り込めます'})</span></p>`;
      }
      return `<section class="card"><h2>昨夜の眠り</h2>${body}</section>`;
    }
    const sl = h.sleep_min != null ? `${Math.floor(h.sleep_min / 60)}<small>時間</small>${pad(h.sleep_min % 60)}<small>分</small>` : '<span class="muted">—</span>';
    const again = isPatient && hl.consent ? `<a class="link" href="${esc(hl.runUrl)}">取り込み直す</a>` : '';
    return `<section class="card"><h2>昨夜の眠り ${again}</h2>
      <div class="sleep-main">${sl}${h.awakenings != null ? `<small>途中で起きた ${h.awakenings}回</small>` : ''}</div>
      <dl class="kv">
        ${h.bed_start ? `<dt>就床→起床</dt><dd>${esc(h.bed_start)} → ${esc(h.bed_end || '')}</dd>` : ''}
        ${h.deep_min != null && h.deep_min > 0 ? `<dt>深い眠り</dt><dd>${h.deep_min}分</dd>` : ''}
        ${h.steps != null ? `<dt>歩数</dt><dd>${Number(h.steps).toLocaleString()} 歩</dd>` : ''}
        ${h.steadiness ? `<dt>歩行安定性</dt><dd>${esc(h.steadiness)}</dd>` : ''}
        ${h.resting_hr != null ? `<dt>安静時心拍</dt><dd>${h.resting_hr}</dd>` : ''}
        ${h.dyskinesia != null ? `<dt>StrivePD の値</dt><dd>${h.dyskinesia}</dd>` : ''}
      </dl></section>`;
  }

  function stampsCard(data) {
    const dates = new Set(data.stamps.dates);
    const dow = dowOf(curDate); // 0=日
    const monday = addDays(curDate, -((dow + 6) % 7));
    let cells = '';
    let weekCount = 0;
    for (let i = 0; i < 7; i++) {
      const d = addDays(monday, i);
      const has = dates.has(d);
      if (has) weekCount++;
      const future = d > curDate;
      cells += `<div class="stamp"><span class="dow">${DOW[dowOf(d)]}</span><div class="box ${d === curDate ? 'today' : ''} ${has && isRare(d) ? 'rare' : ''}">${has ? pic(isRare(d) ? 'stamp_rare' : 'stamp', '', d) : (future ? '' : '<span class="dot"></span>')}</div></div>`;
    }
    const s = data.settings;
    let appt = '';
    if (s.next_appointment) {
      const left = daysBetween(curDate, s.next_appointment);
      const since = s.last_appointment || addDays(s.next_appointment, -42);
      const span = Math.max(1, daysBetween(since, s.next_appointment));
      const recorded = data.stamps.dates.filter((d) => d >= since && d <= curDate).length;
      appt = `<div style="margin-top:12px"><div class="row small"><span>次の診察まで <b>${left >= 0 ? left + '日' : '過ぎています'}</b></span><span class="spacer"></span><span class="muted">記録 ${recorded}日 / ${span}日</span></div>
        <div class="progress"><div style="width:${Math.min(100, Math.round(recorded / span * 100))}%"></div></div></div>`;
    }
    return `<section class="card"><h2>スタンプカード <span class="link">今週 ${weekCount}/7</span></h2>
      <div class="stamps">${cells}</div>
      <div class="stat-row"><div class="stat"><div class="v">${data.stamps.total}</div><div class="l">累計(日)</div></div>
        <div class="stat"><div class="v">${weekCount}</div><div class="l">今週</div></div>
        <div class="stat"><div class="v">${data.stamps.dates.filter((d) => isRare(d)).length}</div><div class="l">レアくま</div></div></div>
      ${appt}</section>`;
  }

  function memoCard(data, date) {
    const items = (data.memos || []).map((m) => `<li class="row"><span class="muted small">${hhmm(m.ts)}</span><span class="spacer">${esc(m.text)}</span><button class="icon-btn" data-act="memo-del" data-id="${esc(m.id)}" aria-label="削除">×</button></li>`).join('');
    return `<section class="card"><h2>気になること <button class="link" data-act="memo-new" data-date="${date}">＋ メモする</button></h2>
      ${items ? `<ul style="list-style:none;margin:0;padding:0;display:grid;gap:6px">${items}</ul>` : '<p class="muted small">転んだ、むせた、胸がつまる、動画を撮った、など。キーボードのマイクで声でも書けます。</p>'}
    </section>`;
  }

  function logChips(log) {
    if (!log) return '';
    const chips = [];
    if (log.dizziness != null) chips.push(`ぐるぐる <b>${log.dizziness}</b>`);
    if (log.pain != null) chips.push(`痛み <b>${log.pain}</b>`);
    if (log.alcohol != null) chips.push(`お酒 <b>${log.alcohol ? 'あり' : 'なし'}</b>`);
    if (log.sleep_feel != null) chips.push(`眠り <b>${['', 'わるい', 'ふつう', 'よい'][log.sleep_feel] || ''}</b>`);
    if (log.meds_answer) chips.push(`朝の薬 <b>${STATUS_LABEL[log.meds_answer] || ''}</b>`);
    return `<div class="pill-list">${chips.map((c) => `<span class="pill">${c}</span>`).join('')}</div>`;
  }

  /* ========== 画面: 本人のホーム ========== */
  function greeting(data) {
    const h = new Date().getHours();
    const seed = hash(curDate);
    const pick = (arr) => arr[seed % arr.length];
    if (data.log) return pick(['きょうの記録、ばっちり。あとはゆっくりね。', 'きょうの分はおしまい。おつかれさま。', '記録ありがとう。いい夜になりますように。']);
    if (h >= 4 && h < 11) return pick(['おはよう。朝の薬を飲んだら、ぽちっとね。', 'おはよう。きょうも、ゆっくりでいいよ。', 'おはよう。昨夜の眠り、下に出てるよ。']);
    if (h >= 11 && h < 17) return pick(['こんにちは。しんどい時は横になってね。', 'こんにちは。水分、とってる？', 'こんにちは。きょうの波はどんな感じ？']);
    return pick(['おつかれさま。寝る前に20秒、チェックインしよう。', 'こんばんは。薬を飲んだら、チェックインまで一息にね。', 'おつかれさま。きょうの数字、くまに教えて。']);
  }

  function viewPatient(data) {
    const right = `<button class="icon-btn" data-act="settings" aria-label="設定">⚙︎</button>`;
    if (!data) return topbar(jpDate(curDate), right) + `<div class="card center">${pic('loading', 'bear-bob')}<p class="muted">読み込んでいます…</p></div>`;
    const reaction = data.reactions && data.reactions.length ? data.reactions[data.reactions.length - 1] : null;
    // 種類がこの端末の images.js に無い(まだ古い)時は、送信時に一緒に届いた見た目(label/image)で表示する
    const rdef = reaction ? (reactionDef(reaction.type) || { id: reaction.type, label: reaction.label || 'リアクション', image: reaction.image || '' }) : null;
    const mood = reaction ? 'love' : data.log ? 'happy' : (new Date().getHours() < 10 ? 'sleepy' : 'normal');
    const bubble = reaction
      ? `<div class="bubble reaction"><span class="from">${esc(reaction.from_name || 'サポーター')}さんから</span>${reactionVisual(rdef, 'in-bubble')} ${esc(rdef.label)}${reaction.message ? '<br>' + esc(reaction.message) : ''}
          <button class="dismiss" data-act="seen-reactions">ありがとう ♡</button></div>`
      : `<div class="bubble">${esc(greeting(data))}</div>`;
    const h = new Date().getHours();
    const evening = h >= 17 || h < 4;
    const yesterday = data.yesterday && !data.yesterday.log
      ? `<section class="card"><h2>昨日の分</h2><p class="small" style="margin-bottom:10px">${jpDate(data.yesterday.date)}の記録がまだです。だいたいで大丈夫。</p>
          <button class="btn" data-act="checkin" data-date="${data.yesterday.date}">昨日の分を入れる</button></section>` : '';
    const checkin = data.log
      ? `<section class="card"><h2>きょうのチェックイン <button class="link" data-act="checkin" data-date="${curDate}">直す</button></h2>${logChips(data.log)}</section>`
      : `<section class="card ${evening ? 'focus' : ''}"><h2>きょうのチェックイン</h2><p class="small muted">寝る前の薬を飲んだあとに。4つ答えるだけ、20秒で終わります。</p></section>`;
    return topbar(jpDate(curDate), right) +
      `<section class="card"><div class="mascot">${pic(mood, 'bear-bob')}${bubble}</div></section>` +
      medsCard(data, curDate, !evening && !medsByKind(data.meds).morning) +
      checkin + yesterday + sleepCard(data.health, data.settings) + stampsCard(data) + memoCard(data, curDate) +
      `<div class="fab-bar"><div class="inner">
        <button class="btn ${data.log ? 'done' : 'primary'} big" data-act="checkin" data-date="${curDate}">${data.log ? 'チェックイン済み ✓' : 'きょうのチェックイン'}</button>
      </div></div>`;
  }

  /* ========== 画面: サポーター ========== */
  function viewSupporter(data) {
    const tabs = `<nav class="tabs">
      <button class="${tab === 'today' ? 'active' : ''}" data-act="tab" data-tab="today">記録</button>
      <button class="${tab === 'list' ? 'active' : ''}" data-act="tab" data-tab="list">一覧</button>
      <button class="${tab === 'react' ? 'active' : ''}" data-act="tab" data-tab="react">リアクション</button>
      <button class="${tab === 'settings' ? 'active' : ''}" data-act="tab" data-tab="settings">設定</button></nav>`;
    const right = `<button class="icon-btn" data-act="logout" aria-label="ログアウト" title="ログアウト">⎋</button>`;
    let body = '';
    if (tab === 'today') {
      const nav = `<div class="row" style="margin-bottom:12px"><button class="btn outline" style="width:auto;min-height:48px" data-act="date" data-delta="-1">◀</button>
        <div class="spacer center"><b>${jpDate(curDate)}</b>${curDate === logicalToday() ? '<span class="chip" style="margin-left:6px">きょう</span>' : ''}</div>
        <button class="btn outline" style="width:auto;min-height:48px" data-act="date" data-delta="1" ${curDate >= logicalToday() ? 'disabled' : ''}>▶</button></div>`;
      if (!data) body = nav + `<div class="card center muted">読み込んでいます…</div>`;
      else {
        const st = medStatus(data.meds, data.log);
        body = nav +
          `<section class="card"><h2>チェックイン <button class="link" data-act="checkin" data-date="${curDate}">${data.log ? '直す' : '代わりに入力'}</button></h2>
            ${data.log ? logChips(data.log) : '<p class="muted">未入力</p>'}
            <p class="small" style="margin-top:8px">薬のまとめ: <b>${STATUS_LABEL[st]}</b></p></section>` +
          medsCard(data, curDate, false) + sleepCard(data.health, data.settings) + memoCard(data, curDate);
      }
    } else if (tab === 'list') {
      body = viewList();
    } else if (tab === 'react') {
      body = `<section class="card"><h2>リアクションを送る</h2><p class="small muted" style="margin-bottom:10px">本人の画面で、くまのふきだしに表示されます。</p>
        <div class="react-grid">${IMAGES.reactions.map((r) => `<button class="btn" data-act="react" data-type="${esc(r.id)}">${reactionVisual(r)}<small>${esc(r.label)}</small></button>`).join('')}</div>
        <label class="field" style="margin-top:14px"><span>ひとこと(任意)</span><input type="text" id="react-msg" maxlength="200" placeholder="例: 今日もおつかれさま"></label>
        <p class="help">ボタンを押すと、ひとことと一緒に送ります。種類を増やす・絵を変えるには docs/images/images.js を編集します(IMAGES.md)。</p></section>
        <section class="card"><h2>記録の確認</h2><p class="small">「記録」タブで日付を選ぶと、代わりの入力や時刻の修正ができます。</p></section>`;
    } else if (tab === 'settings') {
      body = viewSettings(data);
    }
    return topbar('くまの記録', right) + tabs + body;
  }

  function viewList() {
    if (!listData) { loadList(); return `<div class="card center muted">読み込んでいます…</div>`; }
    const byDate = {};
    for (let i = 0; i < 14; i++) { const d = addDays(listData.to, -i); byDate[d] = { date: d, meds: [], memos: 0 }; }
    listData.logs.forEach((l) => { if (byDate[l.date]) byDate[l.date].log = l; });
    listData.meds.forEach((m) => { if (byDate[m.date]) byDate[m.date].meds.push(m); });
    listData.health.forEach((h) => { if (byDate[h.date]) byDate[h.date].health = h; });
    listData.memos.forEach((m) => { if (byDate[m.date]) byDate[m.date].memos++; });
    const SYM = { all: '●', no_concerta: '◐', partial: '◔', missed: '○', none: '–', unknown: '?' };
    const rows = Object.values(byDate).map((r) => {
      const k = medsByKind(r.meds);
      const st = medStatus(r.meds, r.log);
      const sl = r.health && r.health.sleep_min != null ? `${(r.health.sleep_min / 60).toFixed(1)}h` : '';
      return `<tr class="clickable" data-act="goto-date" data-date="${r.date}">
        <td>${jpShort(r.date)}<span class="muted small"> ${DOW[dowOf(r.date)]}</span></td>
        <td class="num">${r.log && r.log.dizziness != null ? r.log.dizziness : '<span class="muted">–</span>'}</td>
        <td class="num">${r.log && r.log.pain != null ? r.log.pain : '<span class="muted">–</span>'}</td>
        <td class="num">${r.log && r.log.alcohol ? '🍷' : ''}</td>
        <td><span class="sym" title="${STATUS_LABEL[st]}">${SYM[st]}</span> <span class="small muted">${k.morning ? hhmm(k.morning.taken_at) : '–'} / ${k.night ? hhmm(k.night.taken_at) : '–'}</span></td>
        <td class="num">${sl}</td><td class="num">${r.memos || ''}</td></tr>`;
    }).join('');
    const s = listData.settings;
    const from = s.last_appointment || addDays(listData.to, -41);
    return `<section class="card"><h2>直近14日 <span class="link">タップで開く</span></h2>
      <table class="list"><thead><tr><th>日付</th><th>ぐるぐる</th><th>痛み</th><th>酒</th><th>薬(朝/夜)</th><th>睡眠</th><th>メモ</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="help">● 全部 ◐ コンサータ以外 ◔ 一部 ○ 飲み忘れ – 記録なし</p></section>
      <section class="card"><h2>医師に見せるレポート</h2>
        <p class="small" style="margin-bottom:10px">PC のブラウザで開き、印刷 →「PDF に保存」。期間はレポート画面でも変えられます。</p>
        <a class="btn primary" href="report.html?from=${from}&to=${listData.to}" target="_blank" rel="noopener">レポートを開く(${jpShort(from)}〜${jpShort(listData.to)})</a></section>`;
  }

  async function loadList() {
    try {
      const to = logicalToday();
      const data = await call({ action: 'report', from: addDays(to, -13), to });
      if (data.ok) { listData = data; if (tab === 'list') render(); }
    } catch (e) { toast('一覧を読み込めませんでした'); }
  }

  function viewSettings(data) {
    const s = (data && data.settings) || (cache && cache.settings) || {};
    const f = (name, label, type, help) => `<label class="field"><span>${label}</span><input type="${type || 'text'}" name="${name}" value="${esc(s[name] || '')}">${help ? `<div class="help">${help}</div>` : ''}</label>`;
    return `<form id="settings-form" class="card">
      <h2>設定</h2>
      ${f('patient_name', '本人の名前', 'text', 'レポートに印字します(空欄でも可)')}
      ${f('supporter_name', 'サポーターの名前')}
      <label class="field"><span>朝の薬(1行に1つ)</span><textarea name="meds_morning" placeholder="例:&#10;おくすりA 10mg&#10;おくすりB 2mg">${esc(s.meds_morning || '')}</textarea><div class="help">「一部だけ飲んだ」を記録する時の選択肢になります。コンサータは別ボタンなので入れません。</div></label>
      <label class="field"><span>寝る前の薬(1行に1つ)</span><textarea name="meds_night">${esc(s.meds_night || '')}</textarea></label>
      ${f('concerta_label', 'コンサータのボタン名')}
      <div class="row"><div style="flex:1">${f('notify_morning', '朝の通知', 'time')}</div><div style="flex:1">${f('notify_night', '夜の通知', 'time')}</div></div>
      <div class="help" style="margin:-6px 0 14px">通知は iPhone のショートカット(オートメーション)で設定します。ここは覚え書きです。</div>
      <div class="row"><div style="flex:1">${f('last_appointment', '前回の診察日', 'date')}</div><div style="flex:1">${f('next_appointment', '次の診察日', 'date')}</div></div>
      <label class="check-list"><label><input type="checkbox" name="ask_sleep_feel" ${s.ask_sleep_feel === '1' ? 'checked' : ''}> チェックインで「眠れた?」も聞く(Apple Watch がない時)</label></label>
      <label class="check-list" style="margin-top:8px"><label><input type="checkbox" name="ask_dyskinesia" ${s.ask_dyskinesia === '1' ? 'checked' : ''}> チェックインで StrivePD の値も聞く</label></label>
      <button type="submit" class="btn primary" style="margin-top:16px">設定を保存</button>
    </form>
    ${healthAdminHTML(s)}
    ${imagesCardHTML()}
    <section class="card"><h2>この端末</h2><p class="small">ログイン中: ${esc(cfg.name || '')}(${cfg.role === 'supporter' ? 'サポーター' : '本人'})</p>
      <button class="btn ghost" data-act="logout" style="margin-top:8px">ログアウト</button></section>`;
  }

  // 設定タブの「画像とリアクション」: images.js の内容を確かめるための一覧(読めない画像は赤枠と ✕)
  function imagesCardHTML() {
    const names = { title: 'タイトル', loading: '読み込み中', normal: 'ふつう', happy: 'うれしい', sleepy: 'ねむい', love: 'ハート', cheer: '完了', crown: 'レアくま', stamp: 'スタンプ', stamp_rare: 'レアスタンプ' };
    const cell = (visual, label, bad) => `<div class="cell ${bad ? 'bad' : ''}">${visual}<span>${label}</span></div>`;
    const slotCells = Object.keys(names).map((k) => { const ref = slotRef(k); return cell(pic(k), names[k], !!ref && !imgSrc(ref)); }).join('') +
      cell(`<span class="remoji">${picText('role_patient', '🐻')}</span>`, '記録する人', false) +
      cell(`<span class="remoji">${picText('role_supporter', '🧸')}</span>`, 'サポーター', false);
    const reactCells = IMAGES.reactions.map((r) => cell(reactionVisual(r), `${esc(r.label)}<br><span class="muted">${esc(r.id)}</span>`, !!r.image && isNameLike(r.image) && !imgSrc(r.image))).join('');
    const libCells = Object.keys(IMAGES.library).map((k) => {
      const src = imgSrc(k);
      const v = src && !brokenImgs.has(src) ? `<img class="rimg" src="${esc(src)}" alt="" data-lib="1">` : '<span class="remoji">✕</span>';
      return cell(v, esc(k), !src || brokenImgs.has(src));
    }).join('');
    return `<section class="card"><h2>画像とリアクション</h2>
      <p class="small muted" style="margin-bottom:6px">${IMAGES.loaded ? 'docs/images/images.js の内容です。' : '<b>images.js が読み込めていません。</b>内蔵のくまを使っています。'}変え方は IMAGES.md。</p>
      <p class="small" style="font-weight:600;margin:10px 0 4px">画面の画像</p><div class="img-grid">${slotCells}</div>
      <p class="small" style="font-weight:600;margin:12px 0 4px">リアクション(${IMAGES.reactions.length}種類)</p><div class="img-grid">${reactCells}</div>
      ${libCells ? `<p class="small" style="font-weight:600;margin:12px 0 4px">登録されている画像</p><div class="img-grid">${libCells}</div>` : ''}
      <p class="help">赤い枠は、ファイルが見つからないか、名前が登録されていない画像です。その場所には内蔵のくまが出ます。ファイル名(大文字小文字)と images.js の綴りを確かめてください。</p></section>`;
  }

  /* ========== チェックイン(ウィザード) ========== */
  function startCheckin(date) {
    const data = cache;
    if (!data) { toast('読み込み中です。少し待ってください'); return; }
    const isCur = date === data.date;
    const meds = isCur ? data.meds : (data.yesterday && data.yesterday.date === date ? data.yesterday.meds : []);
    const log = isCur ? data.log : (data.yesterday && data.yesterday.date === date ? data.yesterday.log : null);
    const k = medsByKind(meds);
    const steps = ['dizziness', 'pain', 'alcohol'];
    if (!k.night) steps.push('night');
    if (!k.morning && !k.concerta && !(log && log.meds_answer)) steps.push('morning');
    if (data.settings.ask_sleep_feel === '1') steps.push('sleep_feel');
    if (data.settings.ask_dyskinesia === '1') steps.push('dyskinesia');
    wiz = { date, steps, i: 0, ans: {}, startedAt: Date.now(), isToday: date === logicalToday(), log, done: null };
    if (log) {
      if (log.dizziness != null) wiz.ans.dizziness = log.dizziness;
      if (log.pain != null) wiz.ans.pain = log.pain;
      if (log.alcohol != null) wiz.ans.alcohol = log.alcohol;
      if (log.sleep_feel != null) wiz.ans.sleep_feel = log.sleep_feel;
    }
    renderOverlay();
  }

  function wizHTML() {
    const w = wiz;
    if (w.done) return wizDoneHTML();
    const step = w.steps[w.i];
    const dots = w.steps.map((s, i) => `<span class="${i < w.i ? 'done' : i === w.i ? 'on' : ''}"></span>`).join('');
    const dateLabel = w.isToday ? 'きょう' : jpDate(w.date);
    const scale = (key, lo, hi) => {
      const cur = w.ans[key];
      let b = '';
      for (let v = 0; v <= 10; v++) b += `<button class="n lv${Math.ceil(v / 2)} ${cur === v ? 'sel' : ''}" data-v="${v}" data-act="wiz-pick" data-key="${key}" data-val="${v}">${v}</button>`;
      return `<div class="scale">${b}</div><div class="scale-labels"><span>0 = ${lo}</span><span>10 = ${hi}</span></div>`;
    };
    const choice = (key, opts) => `<div class="choice">${opts.map(([v, label, sub]) => `<button class="btn ${String(w.ans[key]) === String(v) ? 'sel' : ''}" data-act="wiz-pick" data-key="${key}" data-val="${v}">${label}${sub ? `<small class="sub">${sub}</small>` : ''}</button>`).join('')}</div>`;
    let body = '';
    if (step === 'dizziness') body = `<div class="q">${dateLabel}の<br>「ぐるぐる」は？<small>いちばん強かった時で</small></div>${scale('dizziness', 'なし', 'さいあく')}`;
    else if (step === 'pain') body = `<div class="q">${dateLabel}の<br>痛みは？<small>いちばん強かった時で</small></div>${scale('pain', 'なし', 'さいあく')}`;
    else if (step === 'alcohol') body = `<div class="q">${dateLabel}、<br>お酒は？</div>${choice('alcohol', [[0, 'なし'], [1, 'あり']])}`;
    else if (step === 'night') {
      body = w.isToday
        ? `<div class="q">寝る前の薬は？</div>${choice('night', [['now', 'いま飲んだ', '今の時刻で記録'], ['time', 'さっき飲んだ', '時刻を選んで記録'], ['later', 'まだ', 'あとでボタンを押す']])}`
        : `<div class="q">${dateLabel}の<br>寝る前の薬は？</div>${choice('night', [['time', '飲んだ', '時刻はだいたいで'], ['skip', '飲まなかった・わからない']])}`;
      if (w.ans.night === 'time') body += `<div class="row" style="justify-content:center"><input type="time" id="wiz-time" value="${esc(w.ans.nightTime || '23:00')}" style="width:160px"><button class="btn primary" style="width:auto" data-act="wiz-time-ok">これで記録</button></div>`;
    }
    else if (step === 'morning') body = `<div class="q">${dateLabel}の朝の薬は？<small>ボタンの記録がなかったので確認です</small></div>${choice('meds_answer', [['all', '全部飲んだ', 'コンサータも'], ['no_concerta', 'コンサータ以外を飲んだ'], ['missed', '飲み忘れた薬がある'], ['unknown', 'わからない']])}`;
    else if (step === 'sleep_feel') body = `<div class="q">昨夜は眠れた？</div>${choice('sleep_feel', [[3, 'よく眠れた'], [2, 'ふつう'], [1, '眠れなかった']])}`;
    else if (step === 'dyskinesia') body = `<div class="q">StrivePD の値は？<small>わからなければスキップ</small></div><div class="row" style="justify-content:center"><input type="number" id="wiz-dysk" min="0" max="100" step="0.1" inputmode="decimal" style="width:160px" value="${w.ans.dyskinesia != null ? w.ans.dyskinesia : ''}"><button class="btn primary" style="width:auto" data-act="wiz-dysk-ok">次へ</button></div>`;
    return `<div class="wizard" role="dialog" aria-modal="true">
      <div class="head"><button class="btn ghost" style="width:auto" data-act="wiz-close">やめる</button><div class="dots">${dots}</div><span class="small muted">${w.i + 1}/${w.steps.length}</span></div>
      <div class="body">${body}</div>
      <div class="foot"><button class="btn ghost" style="width:auto" data-act="wiz-back" ${w.i === 0 ? 'disabled' : ''}>← 戻る</button>
        <button class="btn ghost" style="width:auto" data-act="wiz-skip">${w.i === w.steps.length - 1 ? '保存する' : 'スキップ →'}</button></div>
    </div>`;
  }

  function wizDoneHTML() {
    const d = wiz.done;
    const chips = logChips(Object.assign({}, wiz.ans, { meds_answer: wiz.ans.meds_answer }));
    return `<div class="wizard" role="dialog" aria-modal="true"><div class="body done-screen">
      <div class="big-bear">${pic(d.rare ? 'crown' : 'cheer', 'bear-cheer')}</div>
      <h2>${esc(d.title)}</h2>
      <p class="msg">${esc(d.msg)}</p>
      ${d.rare ? `<span class="rare-badge">👑 レアくま！</span>` : ''}
      <div><span class="secs">${d.secs}秒で完了</span></div>
      ${chips.replace('pill-list', 'summary-chips')}
      <div style="margin-top:22px"><button class="btn primary big" data-act="wiz-close">とじる</button></div>
      <p class="help" style="margin-top:10px">直したい時は、ホームの「直す」から。</p>
    </div></div>`;
  }

  function wizPick(key, val) {
    const w = wiz;
    let v = val;
    if (key === 'dizziness' || key === 'pain' || key === 'alcohol' || key === 'sleep_feel') v = parseInt(val, 10);
    w.ans[key] = v;
    if (key === 'night') {
      if (v === 'now') {
        const now = new Date();
        addMed('night', w.date, fmtTime(now));
        setTimeout(wizNext, 350);
      } else if (v === 'time') { renderOverlay(); const el = document.getElementById('wiz-time'); if (el) el.focus(); }
      else setTimeout(wizNext, 250);
      renderOverlay();
      return;
    }
    renderOverlay();
    setTimeout(wizNext, 350);
  }

  function wizNext() {
    if (!wiz || wiz.done) return;
    if (wiz.i < wiz.steps.length - 1) { wiz.i++; renderOverlay(); }
    else wizFinish();
  }

  function wizFinish() {
    const w = wiz; const a = w.ans; const date = w.date;
    const secs = Math.max(1, Math.round((Date.now() - w.startedAt) / 1000));
    const req = { action: 'saveLog', date, duration_sec: secs };
    ['dizziness', 'pain', 'alcohol', 'sleep_feel', 'meds_answer'].forEach((k) => { if (k in a && a[k] != null) req[k] = a[k]; });
    const isNew = !w.log;
    enqueue(req, (c) => {
      const base = Object.assign({ date, dizziness: null, pain: null, alcohol: null, sleep_feel: null, meds_answer: null, note: '' }, w.log || {});
      ['dizziness', 'pain', 'alcohol', 'sleep_feel', 'meds_answer'].forEach((k) => { if (k in req) base[k] = req[k]; });
      base.duration_sec = secs;
      if (date === c.date) c.log = base; else if (c.yesterday && c.yesterday.date === date) c.yesterday.log = base;
      if (!c.stamps.dates.includes(date)) { c.stamps.dates.push(date); c.stamps.total += 1; }
    });
    if (a.dyskinesia != null && a.dyskinesia !== '') {
      enqueue({ action: 'health', date, dyskinesia: a.dyskinesia, source: 'manual' }, (c) => { if (date === c.date) c.health = Object.assign({}, c.health || { date }, { dyskinesia: a.dyskinesia }); });
    }
    const rare = isNew && isRare(date);
    const seed = hash(date + ':' + (cache ? cache.stamps.total : 0));
    w.done = { secs, rare, title: TITLES[seed % TITLES.length], msg: rare ? RARE_MESSAGES[seed % RARE_MESSAGES.length] : MESSAGES[seed % MESSAGES.length] };
    renderOverlay();
    confetti();
  }

  function wizClose() {
    const w = wiz;
    if (w && !w.done && !w.log && (w.ans.dizziness != null || w.ans.pain != null)) {
      // 途中でやめても、答えた分は残す
      const req = { action: 'saveLog', date: w.date };
      ['dizziness', 'pain', 'alcohol'].forEach((k) => { if (w.ans[k] != null) req[k] = w.ans[k]; });
      enqueue(req, (c) => {
        const base = Object.assign({ date: w.date, dizziness: null, pain: null, alcohol: null, sleep_feel: null, meds_answer: null, note: '' }, req);
        delete base.action;
        if (w.date === c.date) c.log = base; else if (c.yesterday && c.yesterday.date === w.date) c.yesterday.log = base;
        if (!c.stamps.dates.includes(w.date)) { c.stamps.dates.push(w.date); c.stamps.total += 1; }
      });
      toast('途中までの答えを保存しました');
    }
    wiz = null; renderOverlay(); render();
  }

  /* ========== 服薬の操作 ========== */
  function addMed(kind, date, takenAt, partial) {
    const clientId = uid();
    const med = { id: clientId, date, kind, taken_at: takenAt, partial: partial && partial.length ? partial : null, deleted: 0 };
    enqueue({ action: 'addMed', date, kind, taken_at: takenAt, partial: partial || [], clientId }, (c) => {
      if (date === c.date) c.meds.push(med); else if (c.yesterday && c.yesterday.date === date) c.yesterday.meds.push(med);
    });
    return med;
  }
  function findMed(id) {
    if (!cache) return null;
    return (cache.meds || []).find((m) => m.id === id) || (cache.yesterday && (cache.yesterday.meds || []).find((m) => m.id === id)) || null;
  }
  function medTap(kind, date) {
    const now = new Date();
    const med = addMed(kind, date, fmtTime(now));
    toast(`${KIND_LABEL[kind]} ${hhmm(med.taken_at)} に記録しました`, { label: '時間を直す', onClick: () => openMedSheet(med.id) });
  }
  function openMedSheet(id) {
    const med = findMed(id);
    if (!med) return;
    sheet = { type: 'med', id, time: hhmm(med.taken_at) };
    renderOverlay();
  }
  function medSheetHTML() {
    const med = findMed(sheet.id);
    if (!med) { sheet = null; return ''; }
    const s = cache.settings;
    const label = med.kind === 'concerta' ? (s.concerta_label || 'コンサータ') : KIND_LABEL[med.kind];
    const list = medList(s, med.kind);
    const taken = new Set(med.partial && med.partial.length ? med.partial : list);
    const checks = list.length ? `<p class="small" style="margin:12px 0 6px;font-weight:600">飲んだ薬(一部だけの時はチェックを外す)</p><div class="check-list" id="med-checks">${list.map((n) => `<label><input type="checkbox" value="${esc(n)}" ${taken.has(n) ? 'checked' : ''}> ${esc(n)}</label>`).join('')}</div>` : '';
    return `<div class="sheet-bg" data-act="sheet-bg"><div class="sheet" role="dialog" aria-modal="true">
      <h3>${esc(label)} の記録</h3>
      <label class="field"><span>飲んだ時刻</span><input type="time" id="med-time" value="${esc(sheet.time)}"></label>
      ${checks}
      <div class="actions">
        <button class="btn primary" data-act="med-save">保存</button>
        <button class="btn danger" data-act="med-delete">この記録を取り消す</button>
        <button class="btn ghost" data-act="sheet-close">閉じる</button>
      </div></div></div>`;
  }
  function medSave() {
    const med = findMed(sheet.id);
    const time = (document.getElementById('med-time') || {}).value;
    if (!med || !time) { sheet = null; renderOverlay(); return; }
    const checks = Array.from(document.querySelectorAll('#med-checks input'));
    const all = checks.length === 0 || checks.every((c) => c.checked);
    const partial = all ? [] : checks.filter((c) => c.checked).map((c) => c.value);
    const takenAt = takenAtFor(med.date, time);
    enqueue({ action: 'updateMed', id: med.id, taken_at: takenAt, partial }, () => { med.taken_at = takenAt; med.partial = partial.length ? partial : null; });
    sheet = null; renderOverlay();
    toast('直しました');
  }
  function medDelete() {
    const med = findMed(sheet.id);
    if (!med) { sheet = null; renderOverlay(); return; }
    enqueue({ action: 'deleteMed', id: med.id }, (c) => {
      c.meds = (c.meds || []).filter((m) => m.id !== med.id);
      if (c.yesterday) c.yesterday.meds = (c.yesterday.meds || []).filter((m) => m.id !== med.id);
    });
    sheet = null; renderOverlay();
    toast('取り消しました');
  }

  /* ========== メモ ========== */
  function memoSheetHTML() {
    return `<div class="sheet-bg" data-act="sheet-bg"><div class="sheet" role="dialog" aria-modal="true">
      <h3>気になること</h3>
      <textarea id="memo-text" placeholder="例: 夕方に少しむせた / 胸の下がつまる感じ / 動画を撮った" autofocus></textarea>
      <p class="help">キーボードのマイクで声でも入力できます。</p>
      <div class="actions"><button class="btn primary" data-act="memo-save">保存</button><button class="btn ghost" data-act="sheet-close">閉じる</button></div></div></div>`;
  }
  function memoSave() {
    const text = ((document.getElementById('memo-text') || {}).value || '').trim();
    if (!text) { sheet = null; renderOverlay(); return; }
    const date = sheet.date; const clientId = uid(); const ts = fmtTime(new Date());
    enqueue({ action: 'addMemo', date, ts, text, clientId }, (c) => { if (date === c.date) (c.memos = c.memos || []).push({ id: clientId, date, ts, text }); });
    sheet = null; renderOverlay();
    toast('メモしました');
  }

  /* ========== 設定・キー発行・リアクション ========== */
  function saveSettings(form) {
    const f = new FormData(form);
    const settings = {};
    ['patient_name', 'supporter_name', 'meds_morning', 'meds_night', 'concerta_label', 'notify_morning', 'notify_night', 'last_appointment', 'next_appointment'].forEach((k) => { settings[k] = String(f.get(k) || ''); });
    settings.ask_sleep_feel = f.get('ask_sleep_feel') ? '1' : '0';
    settings.ask_dyskinesia = f.get('ask_dyskinesia') ? '1' : '0';
    enqueue({ action: 'saveSettings', settings }, (c) => { c.settings = Object.assign({}, c.settings, settings); });
    listData = null;
    toast('設定を保存しました');
  }
  async function createKey() {
    try {
      const data = await call({ action: 'createKey', name: 'ヘルスケア連携' });
      if (!data.ok) return toast(data.message || '発行できませんでした');
      sheet = { type: 'key', token: data.token };
      renderOverlay();
    } catch (e) { toast('通信できませんでした'); }
  }
  function keySheetHTML() {
    return `<div class="sheet-bg" data-act="sheet-bg"><div class="sheet" role="dialog" aria-modal="true">
      <h3>ヘルスケア連携キー</h3>
      <p class="small">この画面を閉じると二度と表示されません。ショートカットに貼り付けてから閉じてください。</p>
      <label class="field" style="margin-top:12px"><span>連携キー</span><input type="text" id="key-token" value="${esc(sheet.token)}" readonly></label>
      <label class="field"><span>送信先URL</span><input type="text" value="${esc(cfg.apiUrl)}" readonly></label>
      <p class="help">このキーを、ショートカットの「URLの内容を取得」の <b>token</b> の欄に貼ります(SHORTCUTS.md の 2 の ⑦)。ショートカットを作る iPhone でこの画面を開いていれば、コピーしてそのまま貼れます。</p>
      <div class="actions"><button class="btn" data-act="copy" data-target="key-token">キーをコピー</button><button class="btn ghost" data-act="sheet-close">閉じる</button></div></div></div>`;
  }
  function react(type) {
    const def = reactionDef(type);
    if (!def) { toast('このリアクションは使えません。ページを再読み込みしてください'); return; }
    const msg = ((document.getElementById('react-msg') || {}).value || '').trim();
    // 本人の端末の images.js が古くても表示できるように、見た目(ファイル名か絵文字)も一緒に送る
    const src = imgSrc(def.image);
    const image = src ? src.replace(/^images\//, '') : def.image;
    enqueue({ action: 'react', type, label: def.label, image, message: msg, date: logicalToday() }, null);
    const el = document.getElementById('react-msg'); if (el) el.value = '';
    toast(`「${def.label}」を送りました`);
  }

  /* ========== ヘルスケア連携(同意と設定) ========== */
  function fmtStamp(iso, withTime) {
    const d = new Date(iso);
    if (!iso || isNaN(d)) return '';
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}` + (withTime ? ` ${pad(d.getHours())}:${pad(d.getMinutes())}` : '');
  }
  // 本人用: 同意の画面 → 同意後は「追加する → 試しに取り込む」の手順
  function healthSheetHTML() {
    const s = (cache && cache.settings) || {};
    const hl = healthLink(s);
    const wrap = (inner) => `<div class="sheet-bg" data-act="sheet-bg"><div class="sheet" role="dialog" aria-modal="true">${inner}</div></div>`;
    const sup = s.supporter_name ? esc(s.supporter_name) + 'さん' : '家族';
    if (!hl.ready) {
      return wrap(`<h3>ヘルスケア連携</h3>
        <p class="small">まだ準備ができていません。${sup}に、サポーター画面の「設定 → ヘルスケア連携」でショートカットのリンクを登録してもらってください。</p>
        <div class="actions"><button class="btn ghost" data-act="sheet-close">閉じる</button></div>`);
    }
    if (!hl.consent) {
      return wrap(`<h3>Apple Watch の記録を、くまに届ける</h3>
        <p class="small" style="margin-bottom:12px">Apple Watch が記録した「眠り」と「歩数」を、くまの記録に取り込みます。先生に見せるレポートの、眠りのグラフになります。</p>
        <dl class="kv consent">
          <dt>取り込むもの</dt><dd>眠り(寝た時刻、起きた時刻、眠った長さ、途中で起きた回数)と歩数</dd>
          <dt>届く先</dt><dd>家族の Google スプレッドシートだけ。見るのは${sup}と、診察で見せるレポート</dd>
          <dt>取り込む時</dt><dd>「昨夜の眠りを取り込む」を押した時。毎朝の自動にもできます</dd>
          <dt>やめたい時</dt><dd>この画面の「連携をやめる」で、いつでも止められます</dd>
        </dl>
        <p class="help">このあと iPhone が「ヘルスケアのデータを読んでいいか」を聞いてきます。そこで許可することが、iPhone への同意になります。</p>
        <div class="actions"><button class="btn primary big" data-act="health-consent">同意して、はじめる</button><button class="btn ghost" data-act="sheet-close">今はしない</button></div>`);
    }
    const got = cache && cache.health && cache.health.sleep_min != null;
    return wrap(`<h3>ヘルスケア連携 <span class="chip">同意ずみ ${esc(fmtStamp(s.health_consent_at))}</span></h3>
      <ol class="steps">
        <li><b>ショートカットを追加する</b>
          <a class="btn primary" href="${esc(hl.url)}" target="_blank" rel="noopener">① ショートカットを追加</a>
          <span class="help">開いた画面で「ショートカットを追加」(または「ショートカットを入手」)を押します。追加ずみなら飛ばして大丈夫。</span></li>
        <li><b>試しに取り込む</b>
          <a class="btn" href="${esc(hl.runUrl)}">② 昨夜の眠りを取り込む</a>
          <span class="help">初めての時は、iPhone が「ヘルスケア」と「接続」の許可を聞いてきます。すべて許可してください。通知が出たら、くまの記録に戻ってきてね。</span></li>
        <li><b>${got ? '✓ 届きました。これで完了です' : '「昨夜の眠り」に数字が出たら完了'}</b>
          <span class="help">明日からは、朝にホームの「昨夜の眠りを取り込む」を押すだけです。</span></li>
      </ol>
      <div class="actions"><button class="btn ghost" data-act="sheet-close">閉じる</button><button class="btn danger" data-act="health-withdraw">連携をやめる</button></div>`);
  }
  function healthConsent(agree) {
    const now = new Date().toISOString();
    enqueue({ action: 'consentHealth', agree: agree ? 1 : 0 }, (c) => {
      c.settings = Object.assign({}, c.settings, { health_consent: agree ? '1' : '0', health_consent_at: now, health_consent_by: cfg.name || '' });
    });
  }
  // サポーター用: 連携の準備の手順と、本人の同意の状態
  function healthAdminHTML(s) {
    const hl = healthLink(s);
    const status = hl.consent ? `<b style="color:#2E6E42">同意ずみ</b>(${esc(fmtStamp(s.health_consent_at, true))} ${esc(s.health_consent_by || '')})`
      : s.health_consent_at ? `<b>取り消されています</b>(${esc(fmtStamp(s.health_consent_at, true))})` : '<b>まだ</b>';
    return `<section class="card"><h2>ヘルスケア連携</h2>
      <p class="small" style="margin-bottom:12px">本人がショートカットを作らなくてよいように、サポーターが 1 回だけ作って共有します。くわしい手順は SHORTCUTS.md。</p>
      <ol class="steps">
        <li><b>連携キーを発行する</b>
          <span class="help">ショートカットを作る自分の iPhone でこの画面を開いて押すと、コピーしてそのまま貼れます。</span>
          <button class="btn" data-act="create-key">連携キーを発行する</button></li>
        <li><b>自分の iPhone でショートカットを作り、iCloud リンクをコピーする</b>
          <span class="help">SHORTCUTS.md の 2〜4。作ったら自分の iPhone で一度実行して、通知が出るか確かめます。</span></li>
        <li><b>リンクを登録する</b>
          <form id="health-form">
            <label class="field"><span>ショートカットのリンク</span><input type="url" name="health_shortcut_url" value="${esc(s.health_shortcut_url || '')}" placeholder="https://www.icloud.com/shortcuts/…" autocomplete="off"></label>
            <label class="field"><span>ショートカットの名前</span><input type="text" name="health_shortcut_name" value="${esc(hl.name)}"><div class="help">作ったショートカットの名前と一字一句同じにします。</div></label>
            <button type="submit" class="btn">リンクを保存</button>
          </form></li>
        <li><b>本人に「同意」してもらう</b>
          <span class="help">本人の画面の「昨夜の眠り」→「ヘルスケア連携を設定する」。いまの状態: ${status}</span></li>
      </ol>
      <p class="help">API の URL: <code style="word-break:break-all">${esc(cfg.apiUrl)}</code></p></section>`;
  }
  function saveHealthLink(form) {
    const f = new FormData(form);
    const url = String(f.get('health_shortcut_url') || '').trim();
    const name = String(f.get('health_shortcut_name') || '').trim() || 'くまヘルス送信';
    if (url && !/^https:\/\/(www\.)?icloud\.com\/shortcuts\/[A-Za-z0-9]+/.test(url)) { toast('リンクは https://www.icloud.com/shortcuts/… の形です'); return; }
    const settings = { health_shortcut_url: url, health_shortcut_name: name };
    enqueue({ action: 'saveSettings', settings }, (c) => { c.settings = Object.assign({}, c.settings, settings); });
    toast('リンクを保存しました');
  }

  /* ========== 本人の設定シート ========== */
  function patientSettingsHTML() {
    const s = (cache && cache.settings) || {};
    const hl = healthLink(s);
    return `<div class="sheet-bg" data-act="sheet-bg"><div class="sheet" role="dialog" aria-modal="true">
      <h3>設定</h3>
      <dl class="kv"><dt>名前</dt><dd>${esc(cfg.name || '')}</dd><dt>朝の通知</dt><dd>${esc(s.notify_morning || '')}</dd><dt>夜の通知</dt><dd>${esc(s.notify_night || '')}</dd><dt>未送信</dt><dd>${queue.length}件</dd><dt>ヘルスケア連携</dt><dd>${hl.consent ? '同意ずみ' : 'まだ'}</dd></dl>
      <p class="help" style="margin-top:10px">通知の時刻や薬のリストは、サポーターの画面から変えられます。</p>
      <div class="actions">${hl.ready ? '<button class="btn" data-act="health-setup">ヘルスケア連携</button>' : ''}<button class="btn" data-act="refresh">最新の状態に更新</button><button class="btn ghost" data-act="logout">ログアウト</button><button class="btn ghost" data-act="sheet-close">閉じる</button></div></div></div>`;
  }

  /* ========== オーバーレイ描画 ========== */
  function renderOverlay() {
    const el = document.getElementById('overlay');
    if (wiz) { el.innerHTML = wizHTML(); return; }
    if (sheet) {
      el.innerHTML = sheet.type === 'med' ? medSheetHTML() : sheet.type === 'memo' ? memoSheetHTML() : sheet.type === 'key' ? keySheetHTML() : sheet.type === 'psettings' ? patientSettingsHTML() : sheet.type === 'health' ? healthSheetHTML() : '';
      const ta = el.querySelector('textarea'); if (ta) setTimeout(() => ta.focus(), 50);
      return;
    }
    el.innerHTML = '';
  }

  /* ========== 描画の入口 ========== */
  function render() {
    const root = document.getElementById('app');
    if (!cfg.token) { root.innerHTML = viewLogin(); return; }
    if (cfg.role !== 'supporter') {
      const t = logicalToday();
      if (t !== curDate) { curDate = t; cache = null; refresh(); }
    }
    const data = cache && cache.date === curDate ? cache : null;
    root.innerHTML = cfg.role === 'supporter' ? viewSupporter(data) : viewPatient(data);
    renderOverlay(); renderSync();
    if (!data) refresh(true);
  }

  /* ========== イベント ========== */
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'sheet-bg' && e.target !== el) return; // シートの中身のクリックは無視
    switch (act) {
      case 'login-role': loginRole = el.dataset.role; render(); break;
      case 'checkin': startCheckin(el.dataset.date); break;
      case 'wiz-pick': wizPick(el.dataset.key, el.dataset.val); break;
      case 'wiz-time-ok': {
        const t = (document.getElementById('wiz-time') || {}).value || '23:00';
        wiz.ans.nightTime = t;
        addMed('night', wiz.date, takenAtFor(wiz.date, t));
        wizNext(); break;
      }
      case 'wiz-dysk-ok': {
        const v = (document.getElementById('wiz-dysk') || {}).value;
        wiz.ans.dyskinesia = v === '' ? null : parseFloat(v);
        wizNext(); break;
      }
      case 'wiz-back': if (wiz && wiz.i > 0) { wiz.i--; renderOverlay(); } break;
      case 'wiz-skip': wizNext(); break;
      case 'wiz-close': wizClose(); break;
      case 'med-tap': medTap(el.dataset.kind, el.dataset.date); break;
      case 'med-edit': openMedSheet(el.dataset.id); break;
      case 'med-save': medSave(); break;
      case 'med-delete': medDelete(); break;
      case 'memo-new': sheet = { type: 'memo', date: el.dataset.date }; renderOverlay(); break;
      case 'memo-save': memoSave(); break;
      case 'memo-del': {
        const id = el.dataset.id;
        enqueue({ action: 'deleteMemo', id }, (c) => { c.memos = (c.memos || []).filter((m) => m.id !== id); });
        break;
      }
      case 'seen-reactions': {
        const ids = (cache && cache.reactions ? cache.reactions : []).map((r) => r.id);
        enqueue({ action: 'seenReactions', ids }, (c) => { c.reactions = []; });
        break;
      }
      case 'sheet-close': case 'sheet-bg': sheet = null; renderOverlay(); break;
      case 'settings': sheet = { type: 'psettings' }; renderOverlay(); break;
      case 'health-setup': sheet = { type: 'health' }; renderOverlay(); break;
      case 'health-consent': healthConsent(true); renderOverlay(); break;
      case 'health-withdraw':
        if (confirm('ヘルスケア連携をやめますか？\nこれから先の眠りと歩数は届かなくなります(これまでの記録は残ります)。')) {
          healthConsent(false); sheet = null; renderOverlay(); toast('連携をやめました。ショートカットは消しても大丈夫です');
        }
        break;
      case 'refresh': sheet = null; renderOverlay(); refresh(); toast('更新しています…'); break;
      case 'logout': if (confirm('ログアウトしますか？(この端末の記録は送信済みなら消えません)')) logout(); break;
      case 'tab': tab = el.dataset.tab; if (tab === 'list') listData = null; render(); break;
      case 'date': curDate = addDays(curDate, parseInt(el.dataset.delta, 10)); cache = null; render(); break;
      case 'goto-date': curDate = el.dataset.date; tab = 'today'; cache = null; render(); break;
      case 'react': react(el.dataset.type); break;
      case 'create-key': createKey(); break;
      case 'copy': {
        const input = document.getElementById(el.dataset.target);
        if (input) { input.select(); try { navigator.clipboard.writeText(input.value); toast('コピーしました'); } catch (err) { document.execCommand && document.execCommand('copy'); toast('コピーしました'); } }
        break;
      }
      case 'toast-action': {
        const t = document.getElementById('toast');
        const fn = t._action; t.innerHTML = ''; t._action = null; if (fn) fn();
        break;
      }
      default: break;
    }
  });

  document.addEventListener('submit', (e) => {
    if (e.target.id === 'login-form') { e.preventDefault(); doLogin(e.target); }
    if (e.target.id === 'settings-form') { e.preventDefault(); saveSettings(e.target); }
    if (e.target.id === 'health-form') { e.preventDefault(); saveHealthLink(e.target); }
  });

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { render(); refresh(true); } });

  /* ========== 起動 ========== */
  render();
  if (cfg.token) { processQueue(); refresh(true); }
})();
