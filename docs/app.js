/* くまの記録 — app.js
 * ビルド不要の素のJavaScript。画面は1ファイルで完結する。
 * 記録するのは家族(サポーター)。本人の画面は「くまとひとこと」だけで、体調のことは一切たずねない。
 * 方針: 押した瞬間に画面を更新し(楽観的更新)、送信はキューで裏側に行う。
 *       通信が遅い・切れている時でも「記録できた」体験を途切れさせない。 */
(function () {
  'use strict';

  /* ========== 保存(localStorage) ========== */
  const KEYS = { cfg: 'kuma.cfg', state: 'kuma.state3', queue: 'kuma.queue', idmap: 'kuma.idmap', thanked: 'kuma.thanked' };
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
  const QUEUE_ACTIONS = new Set(['saveObs', 'addMemo', 'deleteMemo', 'react', 'seenReactions', 'saveSettings', 'consentHealth', 'saveImageConfig', 'deleteImage']);
  let cache = load(KEYS.state, null);
  // 前の版の未送信(服薬ボタンなど)は今の仕組みでは送れないので捨てる
  let queue = load(KEYS.queue, []).filter((q) => q && q.req && QUEUE_ACTIONS.has(q.req.action));
  let idmap = load(KEYS.idmap, {});

  /* ========== 日付ユーティリティ ========== */
  const pad = (n) => String(n).padStart(2, '0');
  const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fmtTime = (d) => `${fmtDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const nowHm = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  // 論理日: 午前4時を日付の境目にする(深夜1時の出来事は「前日の夜」に属する)
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
  const uid = () => 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
  function fmtStamp(iso, withTime) {
    const d = new Date(iso);
    if (!iso || isNaN(d)) return '';
    return `${d.getMonth() + 1}/${d.getDate()}` + (withTime ? ` ${pad(d.getHours())}:${pad(d.getMinutes())}` : '');
  }

  /* ========== 観察の項目(家族が見て分かることだけ) ========== */
  const SCALES = {
    getup:    { label: '起き上がり', opts: [[0, 'スムーズ'], [1, 'ゆっくり'], [2, 'つらそう']] },
    gait:     { label: '歩き方のふらつき', opts: [[0, 'なし'], [1, '少し'], [2, '目立つ']] },
    lying:    { label: '横になっていた時間', opts: [[0, 'ほとんどなし'], [1, '2〜3時間'], [2, '半日くらい'], [3, 'ほぼ一日']] },
    outing:   { label: '外出', opts: [[2, '外出できた'], [1, '近所だけ'], [0, 'なし']] },
    meal:     { label: '食事の量', opts: [[3, 'ふつう'], [2, '半分くらい'], [1, '少し'], [0, 'ほぼ食べず']] },
    movement: { label: '不随意運動の見た目', opts: [[1, 'ほぼなし'], [2, '少し'], [3, '中くらい'], [4, '強い'], [5, 'とても強い']] },
    alcohol:  { label: 'お酒', opts: [[0, 'なし'], [1, 'あり']] }
  };
  const EASY = [['morning', '朝'], ['noon', '昼'], ['evening', '夕方'], ['night', '夜']];
  const COMPLAINT = [['pain', '痛み'], ['dizzy', 'ぐるぐる'], ['other', 'その他']];
  const MED_STATE = [['yes', '飲んだ'], ['part', '一部'], ['no', '飲まなかった']];
  function medKinds(s) {
    const list = [['med_morning', '朝の薬']];
    if (s.med2_label) list.push(['med_extra', s.med2_label]);
    list.push(['med_night', '寝る前の薬']);
    return list;
  }
  const parseMed = (v) => { const [st, t] = String(v || '').split(' '); return { st: st || '', t: t || '' }; };

  /* ========== 画像とリアクション ==========
   * もとの設定は docs/images/images.js(window.KUMA_IMAGES)。サイトの「くま」タブで選んだ画像と
   * リアクションの種類(settings の image_config)があれば、そちらを優先する。
   * 画像の参照: 'u:<id>' = サイトで登録した画像 / ライブラリの名前 / ファイル名 / 絵文字 */
  const DEFAULT_REACTIONS = [
    { id: 'heart', label: '見たよ', image: '❤️' }, { id: 'clap', label: 'えらい', image: '👏' },
    { id: 'honey', label: 'おつかれ', image: '🍯' }, { id: 'bear', label: 'だいすき', image: '🐻' }
  ];
  function cleanReactions(list) {
    return (Array.isArray(list) ? list : []).filter((r) => r && typeof r === 'object' && /^[a-z0-9_-]{1,32}$/i.test(String(r.id || '')))
      .map((r) => ({ id: String(r.id), label: String(r.label || r.id).slice(0, 30), image: typeof r.image === 'string' ? r.image : '' }));
  }
  const STATIC = (function () {
    const src = (window.KUMA_IMAGES && typeof window.KUMA_IMAGES === 'object') ? window.KUMA_IMAGES : null;
    const library = src && src.library && typeof src.library === 'object' ? src.library : {};
    const slots = src && src.slots && typeof src.slots === 'object' ? src.slots : {};
    let reactions = cleanReactions(src && src.reactions);
    if (!reactions.length) reactions = DEFAULT_REACTIONS;
    return { loaded: !!src, library, slots, reactions };
  })();
  const settingsNow = () => (cache && cache.settings) || {};
  function siteConfig() {
    const raw = settingsNow().image_config;
    if (!raw) return {};
    try { const c = JSON.parse(raw); return c && typeof c === 'object' ? c : {}; } catch (e) { return {}; }
  }
  function slotsNow() { const c = siteConfig(); return Object.assign({}, STATIC.slots, c.slots && typeof c.slots === 'object' ? c.slots : {}); }
  function reactionsNow() {
    const c = siteConfig();
    if (Array.isArray(c.reactions)) { const l = cleanReactions(c.reactions); if (l.length) return l; }
    return STATIC.reactions;
  }
  const imagesNow = () => (cache && cache.images) || [];

  /* ---- サイトで登録した画像(スプレッドシートから 1 回だけ読み、端末に保存して使い回す) ---- */
  const up = { url: {}, loading: {}, failed: {} };
  const IMG_CACHE = 'kuma-uploads';
  const imgKey = (id) => new URL('__kuma_img/' + id, location.href).href;
  function dataUrlToBlob(d) {
    const m = /^data:([^;,]+);base64,(.*)$/.exec(d || '');
    if (!m) throw new Error('decode');
    const bin = atob(m[2]); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: m[1] });
  }
  async function cachePut(id, blob) {
    if (!window.caches) return;
    try { const c = await caches.open(IMG_CACHE); await c.put(imgKey(id), new Response(blob, { headers: { 'Content-Type': blob.type } })); } catch (e) { /* 保存できなくても表示はできる */ }
  }
  async function loadUpImage(id) {
    if (up.url[id] || up.loading[id]) return;
    if (up.failed[id] && Date.now() - up.failed[id] < 60000) return;
    up.loading[id] = true;
    try {
      let blob = null;
      if (window.caches) { try { const c = await caches.open(IMG_CACHE); const hit = await c.match(imgKey(id)); if (hit) blob = await hit.blob(); } catch (e) { /* 無視 */ } }
      if (!blob) {
        if (!cfg.token || !imagesNow().some((m) => m.id === id)) return; // まだ一覧が届いていない、または消された画像
        const data = await call({ action: 'getImage', id });
        if (!data.ok) throw new Error(data.error);
        blob = dataUrlToBlob(data.data);
        await cachePut(id, blob);
      }
      up.url[id] = URL.createObjectURL(blob);
      scheduleRender();
    } catch (e) {
      up.failed[id] = Date.now();
    } finally {
      delete up.loading[id];
    }
  }
  // 画面に出す予定の画像を先に読んでおく(起動直後に内蔵のくまが一瞬出るのを減らす)
  function wantedImageIds() {
    const ids = new Set();
    const addRef = (r) => { if (typeof r === 'string' && r.startsWith('u:')) ids.add(r.slice(2)); };
    Object.values(slotsNow()).forEach((v) => (Array.isArray(v) ? v.forEach(addRef) : addRef(v)));
    reactionsNow().forEach((r) => addRef(r.image));
    ((cache && cache.reactions) || []).forEach((r) => addRef(r.image));
    return Array.from(ids);
  }
  async function preloadImages() { await Promise.all(wantedImageIds().map((id) => loadUpImage(id))); }

  /* ---- くま(SVG)。画像が無い・読めない時はいつでもこれに戻る ---- */
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

  // スロット名 → 内蔵のくまの表情。空の時に代わりに使うスロット
  const SLOT_MOOD = { title: 'normal', loading: 'normal', normal: 'normal', happy: 'happy', sleepy: 'sleepy', love: 'love' };
  const SLOT_ALIAS = { title: 'normal', loading: 'normal' };
  const SLOT_UI = [['normal', 'ふだん'], ['sleepy', '朝(10時まで)'], ['love', 'ひとことが届いた時'], ['happy', 'ありがとう・なでた後'], ['title', 'ログイン画面'], ['loading', '読み込み中']];
  const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isNameLike = (s) => /^[A-Za-z0-9_.-]+$/.test(s); // ライブラリ名やファイル名らしい文字列(絵文字ではない)
  const brokenImgs = new Set(); // 読み込みに失敗した画像の src(以後は内蔵のくまに切り替える)
  function isPicRef(ref) {
    return typeof ref === 'string' && !!ref && (ref.startsWith('u:') || hasOwn(STATIC.library, ref) || /^https?:\/\//.test(ref) || ref.startsWith('data:image/') || (IMG_EXT.test(ref) && isNameLike(ref)));
  }
  // 参照を <img> の src にする。画像でない(絵文字・見つからない名前)・まだ読み込み中なら null
  function imgSrc(ref) {
    if (!ref || typeof ref !== 'string') return null;
    if (ref.startsWith('u:')) { const id = ref.slice(2); if (up.url[id]) return up.url[id]; loadUpImage(id); return null; }
    const file = hasOwn(STATIC.library, ref) ? String(STATIC.library[ref] || '') : ref;
    if (!file) return null;
    if (/^https?:\/\//.test(file) || file.startsWith('data:image/')) return file;
    if (IMG_EXT.test(file) && !/[\/\\]/.test(file)) return 'images/' + file;
    return null;
  }
  const pickRef = (v, seed) => (Array.isArray(v) ? (v.length ? v[hash(seed) % v.length] : '') : v); // 配列なら日替わり
  function slotRef(slot, seed) {
    const s = slotsNow(); const d = seed || logicalToday();
    let ref = pickRef(s[slot], d + slot);
    if (!ref && SLOT_ALIAS[slot]) ref = pickRef(s[SLOT_ALIAS[slot]], d + SLOT_ALIAS[slot]);
    return typeof ref === 'string' ? ref : '';
  }
  // 画像タグ(参照が画像でない・読めない時は内蔵のくま)
  function picFor(ref, mood, cls) {
    const src = imgSrc(ref);
    if (!src || brokenImgs.has(src)) return bearSVG(mood || 'normal', 'pic ' + (cls || ''));
    return `<img class="pic ${cls || ''}" src="${esc(src)}" alt="" data-mood="${mood || 'normal'}" data-cls="${esc(cls || '')}">`;
  }
  const pic = (slot, cls, seed) => picFor(slotRef(slot, seed), SLOT_MOOD[slot] || 'normal', cls);
  // 絵文字でも画像でもよい小さな絵(ログインのボタンなど)。def は内蔵の絵文字
  function picText(slot, def) {
    const ref = slotRef(slot);
    const src = imgSrc(ref);
    if (src && !brokenImgs.has(src)) return `<img class="pic-sm" src="${esc(src)}" alt="" data-def="${esc(def)}">`;
    return esc(ref && !isPicRef(ref) ? ref : def);
  }
  // リアクションの絵(画像 <img class="rimg"> か絵文字 <span class="remoji">)
  function reactionVisual(def, cls) {
    const ref = def && def.image;
    const src = imgSrc(ref);
    if (src && !brokenImgs.has(src)) return `<img class="rimg ${cls || ''}" src="${esc(src)}" alt="">`;
    const t = (ref && !isPicRef(ref)) ? ref : '♡';
    return `<span class="remoji ${cls || ''}">${esc(t)}</span>`;
  }
  // 画像が読めなかったら、その場で内蔵のくま(または絵文字)に差し替える
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG') return;
    brokenImgs.add(img.getAttribute('src'));
    const cell = img.closest('.img-grid .cell'); if (cell) cell.classList.add('bad');
    const tmp = document.createElement('span');
    if (img.dataset.mood) tmp.innerHTML = bearSVG(img.dataset.mood, 'pic ' + (img.dataset.cls || ''));
    else if (img.classList.contains('rimg')) tmp.innerHTML = `<span class="${esc(img.className.replace('rimg', 'remoji'))}">♡</span>`;
    else tmp.textContent = img.dataset.def || '♡';
    img.replaceWith(tmp.firstElementChild || tmp);
  }, true);
  function refName(ref) {
    if (!ref) return '内蔵のくま';
    if (ref.startsWith('u:')) { const m = imagesNow().find((x) => x.id === ref.slice(2)); return m ? m.name : '(消された画像)'; }
    return ref;
  }

  /* ========== 画面の状態 ========== */
  let curDate = logicalToday();
  let tab = 'today';            // 記録する人のタブ
  let sheet = null;             // 下から出るシート
  let listData = null;          // 一覧用データ
  let toastTimer = null;
  let patMsg = null;            // 本人の画面で、くまをなでた時のひとこと
  let patTimer = null;
  let uploading = false;

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
  let inflight = null;
  async function processQueue() {
    if (processing || !queue.length || !cfg.token) return;
    processing = true; renderSync();
    while (queue.length) {
      const item = queue[0];
      inflight = item.id;
      const req = resolveIds(item.req);
      if (req.id && String(req.id).startsWith('c_')) { queue.shift(); save(KEYS.queue, queue); continue; } // 作成に失敗した記録への変更は捨てる
      let data;
      try { data = await call(req); } catch (e) { break; } // 通信できない → 後で再送
      if (!data.ok) {
        if (data.error === 'unauthorized') { processing = false; inflight = null; logout('ログインし直してください'); return; }
        queue.shift(); save(KEYS.queue, queue);
        toast('保存できなかった記録があります: ' + (data.message || data.error));
        continue;
      }
      if (req.action === 'addMemo' && data.memo && item.req.clientId) idmap[item.req.clientId] = data.memo.id;
      queue.shift(); save(KEYS.queue, queue); save(KEYS.idmap, idmap);
    }
    processing = false; inflight = null; renderSync();
    if (!queue.length) refresh(true);
  }
  window.addEventListener('online', processQueue);

  // 楽観的更新: 先に画面を変え、送信はキューへ。同じ日の観察は、まだ送っていない分とまとめて 1 回で送る
  let editSeq = 0; // 画面で何かを変えるたびに増える(読み込み中に変えた時、古い状態で上書きしないため)
  function enqueue(req, mutate) {
    editSeq++;
    const last = queue[queue.length - 1];
    if (req.action === 'saveObs' && last && last.id !== inflight && last.req.action === 'saveObs' && last.req.date === req.date) Object.assign(last.req, req);
    else queue.push({ id: uid(), req });
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
    const seq = editSeq;
    let stale = false;
    try {
      const data = await call(cfg.role === 'supporter' ? { action: 'state', date: curDate } : { action: 'room' });
      if (data.ok && (seq !== editSeq || (cfg.role === 'supporter' && data.date !== curDate))) stale = true; // 読み込み中に変更や日付の移動があった → 読み直す
      else if (data.ok) { cache = data; save(KEYS.state, cache); render(); }
      else if (data.error === 'unauthorized') logout('ログインし直してください');
      else if (!silent) toast(data.message || '読み込みに失敗しました');
    } catch (e) {
      if (!silent) toast('通信できませんでした。記録はあとで送ります');
    }
    refreshing = false; renderSync();
    if (stale && !queue.length) refresh(true);
  }

  function logout(msg) {
    cfg.token = ''; cfg.role = ''; save(KEYS.cfg, cfg);
    cache = null; queue = []; idmap = {}; save(KEYS.state, null); save(KEYS.queue, queue); save(KEYS.idmap, idmap);
    sheet = null; render();
    if (msg) toast(msg);
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
  let loginRole = 'supporter';
  function viewLogin() {
    return `<div class="login">
      <div class="hero">${pic('title', 'bear-bob')}<h1>くま</h1><p class="muted">家族の、ちいさなアプリ</p></div>
      <form id="login-form" class="card">
        ${FIXED_API
          ? `<input type="hidden" name="apiUrl" value="${esc(cfg.apiUrl)}">`
          : `<label class="field"><span>API のURL(Apps Script のウェブアプリURL)</span>
          <input type="url" name="apiUrl" value="${esc(cfg.apiUrl)}" placeholder="https://script.google.com/macros/s/…/exec" required autocomplete="off"></label>`}
        <label class="field"><span>家族コード</span><input type="password" name="code" required autocomplete="current-password"></label>
        <span class="small muted" style="display:block;margin-bottom:6px;font-weight:600">この iPhone を使うのは…</span>
        <div class="role-grid">
          <button type="button" class="btn ${loginRole === 'supporter' ? 'sel' : ''}" data-act="login-role" data-role="supporter">${picText('role_supporter', '🧸')} 記録する人<small class="sub">家族</small></button>
          <button type="button" class="btn ${loginRole === 'patient' ? 'sel' : ''}" data-act="login-role" data-role="patient">${picText('role_patient', '🐻')} 本人<small class="sub">くまの部屋</small></button>
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
      curDate = logicalToday(); cache = null; tab = 'today'; render(); refresh();
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
  const card = (title, inner, extra) => `<section class="card ${extra || ''}"><h2>${title}</h2>${inner}</section>`;

  // ヘルスケア連携(サポーターが共有したショートカット)の状態
  function healthLink(s) {
    s = s || {};
    const name = s.health_shortcut_name || 'くまヘルス送信';
    return { ready: !!s.health_shortcut_url, consent: s.health_consent === '1', url: s.health_shortcut_url || '', name,
      runUrl: 'shortcuts://run-shortcut?name=' + encodeURIComponent(name) };
  }

  /* ========== 画面: 本人(くまの部屋) ==========
   * 体調・薬・記録のことは一切出さない。くまと、家族からのひとことだけ。 */
  const GREET = {
    morning: ['おはよう。きょうも、ゆっくりでいいよ。', 'おはよう。くまはここにいるよ。', 'おはよう。お水を一杯どうぞ。'],
    day: ['こんにちは。好きなことをする時間、たいせつにね。', 'こんにちは。ひと休みしよう。', 'こんにちは。くまはいつでも味方だよ。'],
    night: ['こんばんは。きょうも一日おつかれさま。', 'あったかくして、ゆっくりしてね。', 'おやすみ前に、深呼吸ひとつ。']
  };
  const PAT = ['えへへ。', 'なでてくれて、ありがとう。', 'くまも、うれしい。', 'ふわふわでしょ。', 'もう一回？', 'だいすきだよ。', 'いい手だね。'];
  function greeting() {
    const h = new Date().getHours();
    const list = h >= 4 && h < 11 ? GREET.morning : h >= 11 && h < 17 ? GREET.day : GREET.night;
    return list[hash(logicalToday()) % list.length];
  }
  function viewPatient(data) {
    const right = `<button class="icon-btn" data-act="settings" aria-label="設定">⚙︎</button>`;
    const today = logicalToday();
    if (!data) return topbar(jpDate(today), right) + `<section class="card room">${pic('loading', 'bear-bob')}<p class="muted">くまを呼んでいます…</p></section>`;
    const reaction = data.reactions && data.reactions.length ? data.reactions[data.reactions.length - 1] : null;
    // 種類が今の設定に無い時は、送信時に一緒に届いた見た目(label/image)で表示する
    const rdef = reaction ? { id: reaction.type, label: reaction.label || (reactionsNow().find((r) => r.id === reaction.type) || {}).label || 'ひとこと', image: reaction.image || (reactionsNow().find((r) => r.id === reaction.type) || {}).image || '' } : null;
    const thanked = load(KEYS.thanked, '') === today;
    const slot = reaction ? 'love' : (patMsg || thanked) ? 'happy' : new Date().getHours() < 10 ? 'sleepy' : 'normal';
    const bubble = reaction
      ? `<div class="bubble reaction"><span class="from">${esc(reaction.from_name || '家族')}さんから</span>${reactionVisual(rdef, 'in-bubble')} ${esc(rdef.label)}${reaction.message ? '<br>' + esc(reaction.message) : ''}
          <button class="dismiss" data-act="seen-reactions">ありがとう ♡</button></div>`
      : `<div class="bubble">${esc(patMsg || greeting())}</div>`;
    return topbar(jpDate(today), right) +
      `<section class="card room"><button class="bear-btn ${patMsg ? 'bear-pat' : ''}" data-act="pat" aria-label="くまをなでる">${pic(slot, 'bear-bob')}</button>${bubble}</section>`;
  }

  /* ========== 画面: 記録する人 ========== */
  function viewSupporter(data) {
    const tabs = `<nav class="tabs">
      <button class="${tab === 'today' ? 'active' : ''}" data-act="tab" data-tab="today">記録</button>
      <button class="${tab === 'list' ? 'active' : ''}" data-act="tab" data-tab="list">一覧</button>
      <button class="${tab === 'kuma' ? 'active' : ''}" data-act="tab" data-tab="kuma">くま</button>
      <button class="${tab === 'settings' ? 'active' : ''}" data-act="tab" data-tab="settings">設定</button></nav>`;
    const right = `<button class="icon-btn" data-act="logout" aria-label="ログアウト" title="ログアウト">⎋</button>`;
    let body = '';
    if (tab === 'today') body = viewRecord(data);
    else if (tab === 'list') body = viewList();
    else if (tab === 'kuma') body = viewKuma(data);
    else if (tab === 'settings') body = viewSettings(data);
    return topbar('くまの記録', right) + tabs + body;
  }

  function scaleField(key, o) {
    const def = SCALES[key];
    const cur = o[key] == null ? null : Number(o[key]);
    return `<div class="obs-field"><div class="obs-label">${def.label}</div><div class="chips">${def.opts.map(([v, l]) =>
      `<button class="chip-btn ${cur === v ? 'sel' : ''}" data-act="obs" data-f="${key}" data-v="${v}" aria-pressed="${cur === v}">${l}</button>`).join('')}</div></div>`;
  }
  function setChips(key, opts, cur) {
    const sel = new Set(String(cur || '').split(',').filter(Boolean));
    return `<div class="chips">${opts.map(([v, l]) =>
      `<button class="chip-btn ${sel.has(v) ? 'sel' : ''}" data-act="obs-set" data-f="${key}" data-v="${v}" aria-pressed="${sel.has(v)}">${l}</button>`).join('')}</div>`;
  }

  function viewRecord(data) {
    const today = logicalToday();
    const nav = `<div class="row" style="margin-bottom:12px"><button class="btn outline" style="width:auto;min-height:48px" data-act="date" data-delta="-1" aria-label="前の日">◀</button>
      <div class="spacer center"><b>${jpDate(curDate)}</b>${curDate === today ? '<span class="chip" style="margin-left:6px">きょう</span>' : ''}</div>
      <button class="btn outline" style="width:auto;min-height:48px" data-act="date" data-delta="1" aria-label="次の日" ${curDate >= today ? 'disabled' : ''}>▶</button></div>`;
    if (!data) return nav + `<div class="card center muted">読み込んでいます…</div>`;
    const o = data.obs || {};
    const s = data.settings || {};
    const pr = data.progress;
    let progress = '';
    if (pr) {
      const left = s.next_appointment ? daysBetween(curDate, s.next_appointment) : null;
      progress = `<p class="progress-line small">${s.last_appointment ? `前回の診察(${jpShort(pr.since)})から` : `${jpShort(pr.since)}から`} 記録 <b>${pr.recorded}日</b> / ${pr.days}日${left != null ? `<br>次の診察まで <b>${left >= 0 ? left + '日' : '過ぎています'}</b>` : ''}</p>`;
    }
    const wake = `<div class="obs-field"><div class="obs-label">起きてきた時刻</div><div class="row">
        <input type="time" data-obs="wake_time" value="${esc(o.wake_time || '')}" style="max-width:160px">
        ${curDate === today ? '<button class="btn outline" style="width:auto;min-height:52px" data-act="wake-now">いま</button>' : ''}</div></div>`;
    const prn = Number(o.prn || 0);
    const meds = medKinds(s).map(([f, label]) => {
      const m = parseMed(o[f]);
      const chips = MED_STATE.map(([k, l]) => `<button class="chip-btn ${m.st === k ? 'sel' : ''}" data-act="med" data-f="${f}" data-v="${k}" aria-pressed="${m.st === k}">${l}</button>`).join('');
      const time = m.st === 'yes' || m.st === 'part'
        ? `<label class="inline-time"><span>時刻(わかれば)</span><input type="time" data-med-time="${f}" value="${esc(m.t)}"></label>` : '';
      return `<div class="obs-field"><div class="obs-label">${esc(label)}</div><div class="chips">${chips}</div>${time}</div>`;
    }).join('') + `<div class="obs-field"><div class="obs-label">頓服(必要な時の薬)</div><div class="stepper">
        <button class="chip-btn" data-act="prn" data-d="-1" aria-label="1回へらす" ${prn <= 0 ? 'disabled' : ''}>−</button><b>${o.prn == null ? '–' : prn + '回'}</b><button class="chip-btn" data-act="prn" data-d="1" aria-label="1回ふやす">＋</button></div></div>`;
    return nav + progress + sleepCard(data.health, s) +
      card('朝のようす', wake + scaleField('getup', o)) +
      card('日中のようす', scaleField('gait', o) + scaleField('lying', o) + scaleField('outing', o) + scaleField('meal', o)) +
      card('見た目のようす', scaleField('movement', o) + '<p class="help">あなたの目で見た印象で大丈夫です。いちばん目立った時で。</p>') +
      card('おくすり', meds) +
      card('お酒', scaleField('alcohol', o).replace('<div class="obs-label">お酒</div>', '')) +
      card('楽そうだった時間・できたこと', `<div class="obs-label">楽そうだった時間帯</div>${setChips('easy_times', EASY, o.easy_times)}
        <label class="field" style="margin-top:12px"><span>楽しめたこと・できたこと</span><textarea data-obs="good_note" maxlength="500" placeholder="例: ドラマを見て笑っていた / 一緒に買い物に行けた">${esc(o.good_note || '')}</textarea></label>
        <p class="help">本人には聞かずに、見ていて気づいたことや、本人が自分から話したことだけ。</p>`) +
      card('本人が自分から口にしたこと', `${setChips('complaint', COMPLAINT, o.complaint)}
        <label class="field" style="margin-top:12px"><span>ひとこと(任意)</span><input type="text" data-obs="complaint_note" maxlength="500" value="${esc(o.complaint_note || '')}" placeholder="例: 夕方に「足が痛い」と言った"></label>
        <p class="help">こちらからは聞きません。本人が自分から言った日だけ押します。</p>`) +
      memoCard(data, curDate) +
      `<p class="help center" style="margin:4px 0 20px">押した内容はその場で保存されます。</p>`;
  }

  function sleepCard(h, s) {
    const hl = healthLink(s);
    if (!h || (h.sleep_min == null && h.steps == null && h.inbed_min == null)) {
      const last = s.health_last_at ? `最後に届いたのは ${fmtStamp(s.health_last_at, true)} です。` : '';
      const why = hl.consent ? last || '本人の iPhone の設定がすむと、毎日自動で届きます。'
        : '本人の同意と iPhone の設定がすむと、毎日自動で届きます(設定タブ)。';
      return card('昨夜の眠り <span class="link">自動</span>', `<p class="muted small">まだ届いていません。${esc(why)}</p>`);
    }
    const sl = h.sleep_min != null ? `${Math.floor(h.sleep_min / 60)}<small>時間</small>${pad(h.sleep_min % 60)}<small>分</small>` : '<span class="muted">—</span>';
    return card('昨夜の眠り <span class="link">自動</span>', `<div class="sleep-main">${sl}${h.awakenings != null ? `<small>目覚め ${h.awakenings}回</small>` : ''}</div>
      <dl class="kv">
        ${h.bed_start ? `<dt>寝た→起きた</dt><dd>${esc(h.bed_start)} → ${esc(h.bed_end || '')}</dd>` : ''}
        ${h.deep_min != null && h.deep_min > 0 ? `<dt>深い眠り</dt><dd>${h.deep_min}分</dd>` : ''}
        ${h.nap_min ? `<dt>昼寝など</dt><dd>${h.nap_min}分</dd>` : ''}
        ${h.steps != null ? `<dt>歩数</dt><dd>${Number(h.steps).toLocaleString()} 歩</dd>` : ''}
        ${h.walking_speed != null ? `<dt>歩く速さ</dt><dd>${h.walking_speed} km/時</dd>` : ''}
        ${h.steadiness ? `<dt>歩行安定性</dt><dd>${esc(h.steadiness)}</dd>` : ''}
        ${h.resting_hr != null ? `<dt>安静時心拍</dt><dd>${h.resting_hr}</dd>` : ''}
      </dl><p class="help">目覚め = 5分以上目が覚めた回数。</p>`);
  }

  function memoCard(data, date) {
    const items = (data.memos || []).map((m) => `<li class="row"><span class="muted small">${hhmm(m.ts)}</span><span class="spacer">${esc(m.text)}</span><button class="icon-btn" data-act="memo-del" data-id="${esc(m.id)}" aria-label="削除">×</button></li>`).join('');
    return `<section class="card"><h2>気になったこと <button class="link" data-act="memo-new" data-date="${date}">＋ メモする</button></h2>
      ${items ? `<ul style="list-style:none;margin:0;padding:0;display:grid;gap:6px">${items}</ul>` : '<p class="muted small">転んだ、むせた、動画を撮った、など。時刻つきで残ります。キーボードのマイクで声でも書けます。</p>'}
    </section>`;
  }

  /* ---- 一覧 ---- */
  const SYM3 = ['○', '△', '×'];
  const OUT_SYM = ['–', '近', '外'];
  const MED_SYM = { yes: '●', part: '◔', no: '○', '': '–' };
  function viewList() {
    if (!listData) { loadList(); return `<div class="card center muted">読み込んでいます…</div>`; }
    const byDate = {};
    for (let i = 0; i < 14; i++) { const d = addDays(listData.to, -i); byDate[d] = { date: d, memos: 0 }; }
    listData.obs.forEach((o) => { if (byDate[o.date]) byDate[o.date].obs = o; });
    listData.health.forEach((h) => { if (byDate[h.date]) byDate[h.date].health = h; });
    listData.memos.forEach((m) => { if (byDate[m.date]) byDate[m.date].memos++; });
    const dash = '<span class="muted">–</span>';
    const rows = Object.values(byDate).map((r) => {
      const o = r.obs || {};
      const sl = r.health && r.health.sleep_min != null ? `${(r.health.sleep_min / 60).toFixed(1)}h` : '';
      const med = (f) => MED_SYM[parseMed(o[f]).st] || '–';
      return `<tr class="clickable" data-act="goto-date" data-date="${r.date}">
        <td>${jpShort(r.date)}<span class="muted small"> ${DOW[dowOf(r.date)]}</span></td>
        <td class="num">${o.movement != null ? o.movement : dash}</td>
        <td class="num">${o.getup != null ? SYM3[o.getup] : dash}</td>
        <td class="num">${o.gait != null ? SYM3[o.gait] : dash}</td>
        <td class="num">${o.outing != null ? OUT_SYM[o.outing] : dash}</td>
        <td class="num">${med('med_morning')}/${med('med_night')}</td>
        <td class="num">${sl}</td></tr>`;
    }).join('');
    const s = listData.settings;
    const from = s.last_appointment || addDays(listData.to, -41);
    return `<section class="card"><h2>直近14日 <span class="link">タップで開く</span></h2>
      <table class="list"><thead><tr><th>日付</th><th>見た目</th><th>起上</th><th>ふらつき</th><th>外出</th><th>薬 朝/夜</th><th>睡眠</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="help">見た目 = 不随意運動 1〜5 / 起上・ふらつき: ○ なし・スムーズ △ 少し × 目立つ・つらそう / 外出: 外 外出 近 近所 / 薬: ● 飲んだ ◔ 一部 ○ 飲まなかった</p></section>
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

  /* ---- くま(ひとことを送る・画像とリアクションを選ぶ) ---- */
  function viewKuma(data) {
    const reactions = reactionsNow();
    const sent = (data && data.sent) || [];
    const sentList = sent.length ? `<ul class="sent-list">${sent.map((r) => `<li>${reactionVisual(r)}<span class="spacer"><b>${esc(r.label || r.type)}</b>${r.message ? ' ' + esc(r.message) : ''}<br><span class="muted small">${esc(fmtStamp(r.created_at, true))}</span></span><span class="chip">${r.seen ? '見たよ ✓' : 'まだ'}</span></li>`).join('')}</ul>` : '';
    const slotCells = SLOT_UI.map(([k, label]) => `<button class="cell" data-act="slot-pick" data-slot="${k}">${pic(k)}<span>${label}</span></button>`).join('');
    const reactCells = reactions.map((r) => `<button class="cell" data-act="react-edit" data-id="${esc(r.id)}">${reactionVisual(r)}<span>${esc(r.label)}</span></button>`).join('') +
      '<button class="cell add" data-act="react-edit" data-id=""><span class="remoji">＋</span><span>種類を足す</span></button>';
    const imgs = imagesNow();
    const imgCells = imgs.map((m) => `<button class="cell" data-act="img-open" data-id="${esc(m.id)}">${reactionVisual({ image: 'u:' + m.id })}<span>${esc(m.name)}</span></button>`).join('');
    return card('ひとことを送る', `<p class="small muted" style="margin-bottom:10px">本人の画面で、くまのふきだしに出ます。</p>
        <div class="react-grid">${reactions.map((r) => `<button class="btn" data-act="react" data-type="${esc(r.id)}">${reactionVisual(r)}<small>${esc(r.label)}</small></button>`).join('')}</div>
        <label class="field" style="margin-top:14px"><span>ひとこと(任意)</span><input type="text" id="react-msg" maxlength="200" placeholder="例: きょうもおつかれさま"></label>
        <p class="help">ボタンを押すと、ひとことと一緒に送ります。</p>${sentList}`) +
      card('場面ごとのくま', `<p class="small muted" style="margin-bottom:8px">タップして、その場面に出す画像を選びます。</p><div class="img-grid">${slotCells}</div>`) +
      card('ひとことの種類', `<p class="small muted" style="margin-bottom:8px">タップして、ことばや絵を変えられます。</p><div class="img-grid">${reactCells}</div>`) +
      card(`登録した画像 <span class="link">${imgs.length}枚</span>`, `${imgCells ? `<div class="img-grid" style="margin-bottom:12px">${imgCells}</div>` : '<p class="muted small" style="margin-bottom:10px">まだありません。</p>'}
        ${uploadButton('lib', '＋ 画像を登録する')}
        <p class="help">iPhone の写真やファイルから選べます。小さく縮めて、家族のスプレッドシートに保存します(GitHub には上がらないので、外からは見えません)。正方形で背景が透明の PNG だと、きれいに出ます。</p>`);
  }
  const uploadButton = (target, label) => `<label class="btn outline upload-btn">${label}<input type="file" accept="image/*" data-upload="${esc(target)}"></label>`;

  /* ---- 設定 ---- */
  function viewSettings(data) {
    const s = (data && data.settings) || settingsNow();
    const f = (name, label, type, help, ph) => `<label class="field"><span>${label}</span><input type="${type || 'text'}" name="${name}" value="${esc(s[name] || '')}" ${ph ? `placeholder="${esc(ph)}"` : ''}>${help ? `<div class="help">${help}</div>` : ''}</label>`;
    return `<form id="settings-form" class="card">
      <h2>設定</h2>
      ${f('patient_name', '本人の名前', 'text', 'レポートに印字します(空欄でも可)')}
      ${f('supporter_name', '記録する人の名前', 'text', '本人の同意の画面に「届く先: ○○さん」と出ます')}
      ${f('med2_label', '3つ目の薬の名前(任意)', 'text', '空欄なら「朝の薬」「寝る前の薬」の2つだけを記録します')}
      <div class="row"><div style="flex:1">${f('last_appointment', '前回の診察日', 'date')}</div><div style="flex:1">${f('next_appointment', '次の診察日', 'date')}</div></div>
      <label class="field"><span>先生に伝えたいこと</span><textarea name="report_note" maxlength="2000" placeholder="例: 本人に症状を尋ねると痛みが強くなるため、家族の観察で記録しています。">${esc(s.report_note || '')}</textarea><div class="help">レポートのいちばん上に印刷されます。</div></label>
      <button type="submit" class="btn primary" style="margin-top:4px">設定を保存</button>
    </form>
    ${healthAdminHTML(s)}
    <section class="card"><h2>この端末</h2><p class="small">ログイン中: ${esc(cfg.name || '')}(記録する人)</p>
      <button class="btn ghost" data-act="logout" style="margin-top:8px">ログアウト</button></section>`;
  }

  // 記録する人用: 連携の準備の手順と、いまの状態
  function healthAdminHTML(s) {
    const hl = healthLink(s);
    const consent = hl.consent ? `<b style="color:#2E6E42">同意ずみ</b>(${esc(fmtStamp(s.health_consent_at, true))})`
      : s.health_consent_at ? `<b>止めています</b>(${esc(fmtStamp(s.health_consent_at, true))})` : '<b>まだ</b>';
    return `<section class="card"><h2>眠りと歩数の連携</h2>
      <p class="small" style="margin-bottom:10px">本人の iPhone から、眠りと歩数が毎日自動で届くようにします。くわしい手順は SHORTCUTS.md。</p>
      <dl class="kv consent">
        <dt>本人の同意</dt><dd>${consent}</dd>
        <dt>最後に届いた</dt><dd>${s.health_last_at ? `${esc(fmtStamp(s.health_last_at, true))} ${esc(s.health_last || '')}` : 'まだ'}</dd>
        ${s.health_try_at ? `<dt>試しの送信</dt><dd>${esc(fmtStamp(s.health_try_at, true))} ${esc(s.health_try || '')}<br><span class="muted small">(同意の前なので保存していません)</span></dd>` : ''}
      </dl>
      <ol class="steps">
        <li><b>連携キーを発行する</b>
          <span class="help">ショートカットを作る自分の iPhone でこの画面を開いて押すと、コピーしてそのまま貼れます。</span>
          <button class="btn" data-act="create-key">連携キーを発行する</button></li>
        <li><b>自分の iPhone でショートカットを作り、試す</b>
          <span class="help">SHORTCUTS.md の 2〜3。試すと、上の「試しの送信」に読み取れた内容が出ます(同意の前なので保存はされません)。</span></li>
        <li><b>共有リンクを登録する</b>
          <form id="health-form">
            <label class="field"><span>ショートカットのリンク</span><input type="url" name="health_shortcut_url" value="${esc(s.health_shortcut_url || '')}" placeholder="https://www.icloud.com/shortcuts/…" autocomplete="off"></label>
            <label class="field"><span>ショートカットの名前</span><input type="text" name="health_shortcut_name" value="${esc(hl.name)}"><div class="help">作ったショートカットの名前と一字一句同じにします。</div></label>
            <button type="submit" class="btn">リンクを保存</button>
          </form></li>
        <li><b>本人の iPhone で同意してもらい、ショートカットを入れる</b>
          <span class="help">本人の iPhone で「本人」としてログイン → 右上の ⚙︎ →「眠りと歩数の連携」。本人が説明を読んで「同意」を押します(SHORTCUTS.md の 5)。</span></li>
        <li><b>本人の iPhone に「自動で送る」設定を作る</b>
          <span class="help">本人がよく開くアプリ(LINE など)を開いた時に、裏で送られるようにします(SHORTCUTS.md の 6)。</span></li>
      </ol>
      ${hl.consent ? '<button class="btn danger" data-act="health-stop" style="margin-top:14px">連携を止める</button>' : ''}
      <p class="help">API の URL: <code style="word-break:break-all">${esc(cfg.apiUrl)}</code></p></section>`;
  }

  /* ========== 下から出るシート ========== */
  const wrapSheet = (inner) => `<div class="sheet-bg" data-act="sheet-bg"><div class="sheet" role="dialog" aria-modal="true">${inner}</div></div>`;

  function memoSheetHTML() {
    return wrapSheet(`<h3>気になったこと</h3>
      <textarea id="memo-text" placeholder="例: 夕方に少しむせた / 立ちくらみで壁に手をついた / 動画を撮った">${esc(sheet.text || '')}</textarea>
      <p class="help">キーボードのマイクで声でも入力できます。</p>
      <div class="actions"><button class="btn primary" data-act="memo-save">保存</button><button class="btn ghost" data-act="sheet-close">閉じる</button></div>`);
  }

  function keySheetHTML() {
    return wrapSheet(`<h3>連携キー</h3>
      <p class="small">この画面を閉じると二度と表示されません。ショートカットに貼り付けてから閉じてください。</p>
      <label class="field" style="margin-top:12px"><span>連携キー</span><input type="text" id="key-token" value="${esc(sheet.token)}" readonly></label>
      <label class="field"><span>送信先URL</span><input type="text" value="${esc(cfg.apiUrl)}" readonly></label>
      <p class="help">このキーを、ショートカットの「URLの内容を取得」の <b>token</b> の欄に貼ります(SHORTCUTS.md の 2)。</p>
      <div class="actions"><button class="btn" data-act="copy" data-target="key-token">キーをコピー</button><button class="btn ghost" data-act="sheet-close">閉じる</button></div>`);
  }

  // 本人の端末の設定(歯車)
  function patientSettingsHTML() {
    const s = settingsNow();
    const hl = healthLink(s);
    return wrapSheet(`<h3>設定</h3>
      <dl class="kv"><dt>名前</dt><dd>${esc(cfg.name || '')}</dd><dt>眠りと歩数</dt><dd>${hl.consent ? '家族に届けています' : '届けていません'}</dd></dl>
      <div class="actions">${hl.ready || hl.consent ? '<button class="btn" data-act="health-setup">眠りと歩数の連携</button>' : ''}<button class="btn" data-act="refresh">最新の状態に更新</button><button class="btn ghost" data-act="logout">ログアウト</button><button class="btn ghost" data-act="sheet-close">閉じる</button></div>`);
  }

  // 本人用: 同意の画面 → 同意後はショートカットを入れて試す手順(家族がそばで手伝う前提)
  function healthSheetHTML() {
    const s = settingsNow();
    const hl = healthLink(s);
    const sup = s.supporter_name ? esc(s.supporter_name) + 'さん' : '家族';
    if (!hl.ready && !hl.consent) {
      return wrapSheet(`<h3>眠りと歩数の連携</h3>
        <p class="small">まだ準備ができていません。${sup}に設定してもらってね。</p>
        <div class="actions"><button class="btn ghost" data-act="sheet-close">閉じる</button></div>`);
    }
    if (!hl.consent) {
      return wrapSheet(`<h3>眠りと歩いた量を、${sup}に届ける</h3>
        <p class="small" style="margin-bottom:12px">Apple Watch と iPhone が記録している「眠り」と「歩いた量」を、毎日自動で${sup}のメモに届けます。診察のときに先生に見せる資料にもなります。</p>
        <dl class="kv consent">
          <dt>届けるもの</dt><dd>眠った時間、寝た時刻と起きた時刻、途中で目が覚めた回数、歩数</dd>
          <dt>届く先</dt><dd>家族の Google スプレッドシートだけ。見るのは${sup}と、先生に見せる資料</dd>
          <dt>届く時</dt><dd>毎日自動で。この iPhone で何かを押す必要はありません</dd>
          <dt>やめたい時</dt><dd>いつでも。この画面の「やめる」を押すか、${sup}に言えば止まります</dd>
        </dl>
        <p class="help">このあと iPhone が「ヘルスケアのデータを読んでいいか」を聞いてきます。そこで許可することが、iPhone への同意になります。</p>
        <div class="actions"><button class="btn primary big" data-act="health-consent">同意して、はじめる</button><button class="btn ghost" data-act="sheet-close">今はしない</button></div>`);
    }
    return wrapSheet(`<h3>眠りと歩数の連携 <span class="chip">同意ずみ ${esc(fmtStamp(s.health_consent_at))}</span></h3>
      <p class="small" style="margin-bottom:10px">ここから先は${sup}が設定します。</p>
      <ol class="steps">
        <li><b>ショートカットを追加する</b>
          ${hl.ready ? `<a class="btn primary" href="${esc(hl.url)}" target="_blank" rel="noopener">① ショートカットを追加</a>` : '<span class="help">(まだリンクが登録されていません)</span>'}
          <span class="help">開いた画面で「ショートカットを追加」を押します。追加ずみなら飛ばして大丈夫。</span></li>
        <li><b>試しに送る</b>
          <a class="btn" href="${esc(hl.runUrl)}">② 試しに送る</a>
          <span class="help">初めての時は、iPhone が「ヘルスケア」と「接続」の許可を聞いてきます。すべて許可します。</span></li>
        <li><b>自動で送る設定を作る</b>
          <span class="help">SHORTCUTS.md の 6。${s.health_last_at ? `最後に届いたのは ${esc(fmtStamp(s.health_last_at, true))} です。` : ''}</span></li>
      </ol>
      <div class="actions"><button class="btn ghost" data-act="sheet-close">閉じる</button><button class="btn danger" data-act="health-withdraw">連携をやめる</button></div>`);
  }

  // 場面(スロット)の画像を選ぶ
  function slotSheetHTML() {
    const slot = sheet.slot;
    const label = (SLOT_UI.find((x) => x[0] === slot) || [slot, slot])[1];
    const sc = siteConfig().slots || {};
    const cur = hasOwn(sc, slot) ? sc[slot] : null;
    const mood = SLOT_MOOD[slot] || 'normal';
    const staticRef = pickRef(STATIC.slots[slot], logicalToday() + slot);
    const cell = (ref, visual, name) => `<button class="cell ${cur === ref ? 'sel' : ''}" data-act="slot-set" data-ref="${esc(ref)}">${visual}<span>${esc(name)}</span></button>`;
    const cells = [
      `<button class="cell ${cur === null ? 'sel' : ''}" data-act="slot-set" data-ref="__reset">${picFor(staticRef, mood)}<span>もとの設定</span></button>`,
      cell('', bearSVG(mood, 'pic'), '内蔵のくま')
    ].concat(imagesNow().map((m) => cell('u:' + m.id, picFor('u:' + m.id, mood), m.name)))
      .concat(Object.keys(STATIC.library).map((k) => cell(k, picFor(k, mood), k))).join('');
    return wrapSheet(`<h3>「${esc(label)}」のくま</h3>
      <div class="img-grid">${cells}</div>
      <div class="actions">${uploadButton('slot:' + slot, '＋ 新しい画像を登録して使う')}<button class="btn ghost" data-act="sheet-close">閉じる</button></div>
      <p class="help">「もとの設定」は docs/images/images.js で決めた画像です。</p>`);
  }

  // ひとことの種類を足す・変える
  function reactSheetHTML() {
    const r = reactionsNow().find((x) => x.id === sheet.id) || { id: '', label: '', image: '' };
    if (sheet.label == null) sheet.label = r.label;
    if (sheet.draft == null) sheet.draft = r.image || '❤️';
    if (sheet.emoji == null) sheet.emoji = isPicRef(sheet.draft) ? '' : sheet.draft;
    const preview = sheet.emoji ? { image: sheet.emoji } : { image: sheet.draft };
    const cell = (ref, name) => `<button class="cell ${!sheet.emoji && sheet.draft === ref ? 'sel' : ''}" data-act="react-img" data-ref="${esc(ref)}">${reactionVisual({ image: ref })}<span>${esc(name)}</span></button>`;
    const cells = imagesNow().map((m) => cell('u:' + m.id, m.name)).concat(Object.keys(STATIC.library).map((k) => cell(k, k))).join('');
    return wrapSheet(`<h3>${r.id ? 'ひとことの種類を変える' : 'ひとことの種類を足す'}</h3>
      <div class="react-preview">${reactionVisual(preview)}<b>${esc(sheet.label || '…')}</b></div>
      <label class="field"><span>ことば(ボタンの下と、本人のふきだしに出ます)</span><input type="text" id="react-label" maxlength="30" value="${esc(sheet.label)}" placeholder="例: がんばったね"></label>
      <label class="field"><span>絵文字で表す</span><input type="text" id="react-emoji" maxlength="8" value="${esc(sheet.emoji)}" placeholder="例: 🍯"></label>
      ${cells ? `<p class="small" style="font-weight:600;margin:4px 0 6px">または画像を選ぶ(絵文字の欄は空にします)</p><div class="img-grid">${cells}</div>` : ''}
      <div class="actions">${uploadButton('react', '＋ 新しい画像を登録して使う')}
        <button class="btn primary" data-act="react-save">保存</button>
        ${r.id ? '<button class="btn danger" data-act="react-del">この種類を消す</button>' : ''}
        <button class="btn ghost" data-act="sheet-close">閉じる</button></div>
      <p class="help">消しても、これまでに送ったひとことはそのまま残ります。</p>`);
  }

  // 登録した画像を見る・消す
  function imageSheetHTML() {
    const m = imagesNow().find((x) => x.id === sheet.id);
    if (!m) { sheet = null; return ''; }
    const ref = 'u:' + m.id;
    const slots = slotsNow();
    const used = SLOT_UI.filter(([k]) => slots[k] === ref || (Array.isArray(slots[k]) && slots[k].includes(ref))).map((x) => x[1])
      .concat(reactionsNow().filter((r) => r.image === ref).map((r) => 'ひとこと「' + r.label + '」'));
    return wrapSheet(`<h3>${esc(m.name)}</h3>
      <div class="center" style="margin-bottom:10px">${picFor(ref, 'normal', 'big-preview')}</div>
      <p class="small">${m.w && m.h ? `${m.w}×${m.h} ・ ` : ''}${esc(fmtStamp(m.created_at, true))} に登録</p>
      <p class="small" style="margin-top:6px">使っている場所: ${used.length ? esc(used.join('、')) : 'なし'}</p>
      <div class="actions"><button class="btn danger" data-act="img-del">この画像を消す</button><button class="btn ghost" data-act="sheet-close">閉じる</button></div>
      <p class="help">消すと、使っていた場所は内蔵のくま(ひとことは ♡)に戻ります。</p>`);
  }

  function renderOverlay() {
    const el = document.getElementById('overlay');
    if (!sheet) { el.innerHTML = ''; return; }
    const map = { memo: memoSheetHTML, key: keySheetHTML, psettings: patientSettingsHTML, health: healthSheetHTML, slot: slotSheetHTML, react: reactSheetHTML, image: imageSheetHTML };
    el.innerHTML = map[sheet.type] ? map[sheet.type]() : '';
    if (sheet && sheet.type === 'memo') { const ta = el.querySelector('textarea'); if (ta && !sheet.focused) { sheet.focused = true; setTimeout(() => ta.focus(), 50); } }
  }

  /* ========== 操作 ========== */
  const obsNow = () => (cache && cache.obs) || {};
  function saveObs(patch) {
    const date = curDate;
    enqueue(Object.assign({ action: 'saveObs', date }, patch), (c) => { if (c.date === date) c.obs = Object.assign({ date }, c.obs || {}, patch); });
  }
  function memoSave() {
    const text = (sheet.text || '').trim();
    if (!text) { sheet = null; renderOverlay(); return; }
    const date = sheet.date; const clientId = uid(); const ts = fmtTime(new Date());
    enqueue({ action: 'addMemo', date, ts, text, clientId }, (c) => { if (date === c.date) (c.memos = c.memos || []).push({ id: clientId, date, ts, text }); });
    sheet = null; renderOverlay();
    toast('メモしました');
  }
  function saveSettings(form) {
    const f = new FormData(form);
    const settings = {};
    ['patient_name', 'supporter_name', 'med2_label', 'last_appointment', 'next_appointment', 'report_note'].forEach((k) => { settings[k] = String(f.get(k) || '').trim(); });
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
  function saveHealthLink(form) {
    const f = new FormData(form);
    const url = String(f.get('health_shortcut_url') || '').trim();
    const name = String(f.get('health_shortcut_name') || '').trim() || 'くまヘルス送信';
    if (url && !/^https:\/\/(www\.)?icloud\.com\/shortcuts\/[A-Za-z0-9]+/.test(url)) { toast('リンクは https://www.icloud.com/shortcuts/… の形です'); return; }
    const settings = { health_shortcut_url: url, health_shortcut_name: name };
    enqueue({ action: 'saveSettings', settings }, (c) => { c.settings = Object.assign({}, c.settings, settings); });
    toast('リンクを保存しました');
  }
  function healthConsent(agree) {
    const now = new Date().toISOString();
    enqueue({ action: 'consentHealth', agree: agree ? 1 : 0 }, (c) => {
      c.settings = Object.assign({}, c.settings, { health_consent: agree ? '1' : '0', health_consent_at: now });
    });
  }
  function react(type) {
    const def = reactionsNow().find((r) => r.id === type);
    if (!def) { toast('この種類は使えません。ページを再読み込みしてください'); return; }
    const msg = ((document.getElementById('react-msg') || {}).value || '').trim();
    // 本人の端末で同じ見た目を出せるように、言葉と絵(画像の参照か絵文字)も一緒に送る
    const image = def.image && STATIC.library[def.image] ? STATIC.library[def.image] : def.image;
    const sent = { id: uid(), type, label: def.label, image, message: msg, seen: 0, created_at: new Date().toISOString() };
    enqueue({ action: 'react', type, label: def.label, image, message: msg, date: logicalToday() }, (c) => { c.sent = [sent].concat(c.sent || []).slice(0, 5); });
    const el = document.getElementById('react-msg'); if (el) el.value = '';
    toast(`「${def.label}」を送りました`);
  }

  // 画像の設定(サイト側)を書き換える。変更は全体を送る
  function saveImageConfig(change) {
    const c = siteConfig();
    const next = { slots: Object.assign({}, c.slots || {}), reactions: Array.isArray(c.reactions) ? cleanReactions(c.reactions) : null };
    change(next);
    if (!next.reactions) delete next.reactions;
    const json = JSON.stringify(next);
    enqueue({ action: 'saveImageConfig', config: next }, (cc) => { cc.settings = Object.assign({}, cc.settings, { image_config: json }); });
  }
  function setSlot(slot, ref) {
    saveImageConfig((n) => { if (ref === '__reset') delete n.slots[slot]; else n.slots[slot] = ref; });
    toast(ref === '__reset' ? 'もとの設定に戻しました' : '変えました');
  }
  function reactSave() {
    const label = (sheet.label || '').trim();
    if (!label) { toast('ことばを入れてください'); return; }
    const image = (sheet.emoji || '').trim() || sheet.draft || '';
    const id = sheet.id || ('r' + Date.now().toString(36));
    saveImageConfig((n) => {
      const list = n.reactions || reactionsNow().map((r) => Object.assign({}, r));
      const i = list.findIndex((r) => r.id === id);
      if (i >= 0) list[i] = { id, label, image }; else list.push({ id, label, image });
      n.reactions = list;
    });
    sheet = null; renderOverlay();
    toast('保存しました');
  }
  function reactDelete() {
    const id = sheet.id;
    if (!confirm('この種類を消しますか？(送ったひとことは残ります)')) return;
    saveImageConfig((n) => { n.reactions = (n.reactions || reactionsNow().map((r) => Object.assign({}, r))).filter((r) => r.id !== id); });
    sheet = null; renderOverlay();
    toast('消しました');
  }
  function imageDelete() {
    const id = sheet.id; const ref = 'u:' + id;
    if (!confirm('この画像を消しますか？')) return;
    saveImageConfig((n) => {
      Object.keys(n.slots).forEach((k) => { if (n.slots[k] === ref) delete n.slots[k]; });
      if (n.reactions) n.reactions = n.reactions.map((r) => (r.image === ref ? Object.assign({}, r, { image: '' }) : r));
      else if (reactionsNow().some((r) => r.image === ref)) n.reactions = reactionsNow().map((r) => (r.image === ref ? Object.assign({}, r, { image: '' }) : Object.assign({}, r)));
    });
    enqueue({ action: 'deleteImage', id }, (c) => { c.images = (c.images || []).filter((m) => m.id !== id); });
    sheet = null; renderOverlay();
    toast('消しました');
  }

  // 画像を小さく縮める(最大 400px)。透明があれば PNG、なければ JPEG(WebP が作れる端末は WebP)
  function hasAlpha(ctx, w, h) {
    try { const d = ctx.getImageData(0, 0, w, h).data; for (let i = 3; i < d.length; i += 16) if (d[i] < 250) return true; return false; } catch (e) { return true; }
  }
  async function shrinkImage(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('decode')); i.src = url; });
      const w = img.naturalWidth || 400, h = img.naturalHeight || 400;
      for (const max of [400, 320, 240]) {
        const sc = Math.min(1, max / Math.max(w, h));
        const cw = Math.max(1, Math.round(w * sc)), ch = Math.max(1, Math.round(h * sc));
        const c = document.createElement('canvas'); c.width = cw; c.height = ch;
        const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, cw, ch);
        let data = c.toDataURL('image/webp', 0.9);
        if (!data.startsWith('data:image/webp')) data = hasAlpha(ctx, cw, ch) ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.88);
        if (data.length <= 390000) return { data, w: cw, h: ch };
      }
      throw new Error('big');
    } finally { URL.revokeObjectURL(url); }
  }
  async function uploadImage(file, target) {
    if (uploading) return;
    uploading = true;
    toast('画像を縮めて送っています…');
    try {
      const img = await shrinkImage(file);
      const name = String(file.name || '画像').replace(/\.[^.]+$/, '').slice(0, 30) || '画像';
      const data = await call({ action: 'uploadImage', name, data: img.data, w: img.w, h: img.h });
      if (!data.ok) { toast(data.message || '登録できませんでした'); return; }
      const meta = data.image;
      const blob = dataUrlToBlob(img.data);
      await cachePut(meta.id, blob);
      up.url[meta.id] = URL.createObjectURL(blob);
      if (cache) { cache.images = (cache.images || []).concat([meta]); save(KEYS.state, cache); }
      const ref = 'u:' + meta.id;
      if (target.startsWith('slot:')) { setSlot(target.slice(5), ref); sheet = null; renderOverlay(); }
      else if (target === 'react' && sheet && sheet.type === 'react') { sheet.draft = ref; sheet.emoji = ''; renderOverlay(); }
      toast('画像を登録しました');
      render();
    } catch (e) {
      toast(e.message === 'decode' ? 'この画像は読めませんでした' : e.message === 'big' ? '画像が大きすぎます' : '通信できませんでした。もう一度お試しください');
    } finally {
      uploading = false;
    }
  }

  /* ========== 描画の入口 ==========
   * 文字を入力している途中は描き直さない(入力中の文字が消えないように)。入力欄から離れたら描き直す */
  let pendingRender = false;
  function isEditing() {
    const a = document.activeElement;
    if (!a || !a.closest || !a.closest('#app, #overlay')) return false;
    return a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && /^(text|time|date|number|url|password|search|email|tel)$/.test(a.type));
  }
  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }
  function render() {
    if (isEditing()) { pendingRender = true; return; }
    pendingRender = false;
    const root = document.getElementById('app');
    if (!cfg.token) { root.innerHTML = viewLogin(); renderOverlay(); return; }
    let data = null;
    if (cfg.role === 'supporter') data = cache && cache.date === curDate && 'obs' in cache ? cache : null;
    else data = cache && cache.room ? cache : null;
    root.innerHTML = cfg.role === 'supporter' ? viewSupporter(data) : viewPatient(data);
    renderOverlay(); renderSync();
    if (!data) refresh(true);
  }
  document.addEventListener('focusout', () => { setTimeout(() => { if (pendingRender && !isEditing()) render(); }, 200); });

  /* ========== イベント ========== */
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    // iPhone ではボタンを押しても入力欄から離れないことがあるので、先に入力を確定させる(入力した文字はその時に保存される)
    if (isEditing() && el.closest('#app') && !el.closest('form')) document.activeElement.blur();
    if (act === 'sheet-bg' && e.target !== el) return; // シートの中身のクリックは無視
    switch (act) {
      case 'login-role': {
        // 描き直すと入力ずみの家族コードが消えるので、選んだ印と名前の例だけ変える
        loginRole = el.dataset.role;
        el.parentNode.querySelectorAll('.btn').forEach((b) => b.classList.toggle('sel', b === el));
        const nm = document.querySelector('#login-form input[name=name]');
        if (nm) nm.placeholder = loginRole === 'patient' ? '例: はなこ' : '例: たろう';
        break;
      }
      case 'obs': {
        const f = el.dataset.f; const v = parseInt(el.dataset.v, 10);
        saveObs({ [f]: obsNow()[f] === v ? null : v }); // もう一度押すと取り消し
        break;
      }
      case 'obs-set': {
        const f = el.dataset.f; const v = el.dataset.v;
        const cur = new Set(String(obsNow()[f] || '').split(',').filter(Boolean));
        if (cur.has(v)) cur.delete(v); else cur.add(v);
        saveObs({ [f]: (f === 'easy_times' ? EASY : COMPLAINT).map((x) => x[0]).filter((x) => cur.has(x)).join(',') });
        break;
      }
      case 'med': {
        const f = el.dataset.f; const v = el.dataset.v; const m = parseMed(obsNow()[f]);
        saveObs({ [f]: m.st === v ? '' : v === 'no' ? 'no' : v + (m.t ? ' ' + m.t : '') });
        break;
      }
      case 'prn': saveObs({ prn: Math.max(0, Math.min(20, Number(obsNow().prn || 0) + parseInt(el.dataset.d, 10))) }); break;
      case 'wake-now': saveObs({ wake_time: nowHm() }); break;
      case 'memo-new': sheet = { type: 'memo', date: el.dataset.date, text: '' }; renderOverlay(); break;
      case 'memo-save': memoSave(); break;
      case 'memo-del': {
        const id = el.dataset.id;
        enqueue({ action: 'deleteMemo', id }, (c) => { c.memos = (c.memos || []).filter((m) => m.id !== id); });
        break;
      }
      case 'pat': {
        let next = PAT[Math.floor(Math.random() * PAT.length)];
        if (next === patMsg) next = PAT[(PAT.indexOf(next) + 1) % PAT.length];
        patMsg = next; render();
        clearTimeout(patTimer); patTimer = setTimeout(() => { patMsg = null; render(); }, 6000);
        break;
      }
      case 'seen-reactions': {
        const ids = (cache && cache.reactions ? cache.reactions : []).map((r) => r.id);
        save(KEYS.thanked, logicalToday());
        enqueue({ action: 'seenReactions', ids }, (c) => { c.reactions = []; });
        break;
      }
      case 'sheet-close': case 'sheet-bg': sheet = null; renderOverlay(); break;
      case 'settings': sheet = { type: 'psettings' }; renderOverlay(); break;
      case 'health-setup': sheet = { type: 'health' }; renderOverlay(); break;
      case 'health-consent': healthConsent(true); renderOverlay(); break;
      case 'health-withdraw':
        if (confirm('眠りと歩数の連携をやめますか？\nこれから先は届かなくなります(これまでの分は残ります)。')) {
          healthConsent(false); sheet = null; renderOverlay(); toast('連携をやめました');
        }
        break;
      case 'health-stop':
        if (confirm('眠りと歩数の連携を止めますか？\n本人の iPhone から送られても保存しなくなります。もう一度始めるには、本人の iPhone で同意し直します。')) {
          healthConsent(false); toast('止めました');
        }
        break;
      case 'refresh': sheet = null; renderOverlay(); refresh(); toast('更新しています…'); break;
      case 'logout': if (confirm('ログアウトしますか？(送信済みの記録は消えません)')) logout(); break;
      case 'tab': tab = el.dataset.tab; if (tab === 'list') listData = null; render(); break;
      case 'date': curDate = addDays(curDate, parseInt(el.dataset.delta, 10)); cache = null; render(); break;
      case 'goto-date': curDate = el.dataset.date; tab = 'today'; cache = null; render(); window.scrollTo(0, 0); break;
      case 'react': react(el.dataset.type); break;
      case 'slot-pick': sheet = { type: 'slot', slot: el.dataset.slot }; renderOverlay(); break;
      case 'slot-set': setSlot(sheet.slot, el.dataset.ref); sheet = null; renderOverlay(); break;
      case 'react-edit': sheet = { type: 'react', id: el.dataset.id }; renderOverlay(); break;
      case 'react-img': sheet.draft = el.dataset.ref; sheet.emoji = ''; renderOverlay(); break;
      case 'react-save': reactSave(); break;
      case 'react-del': reactDelete(); break;
      case 'img-open': sheet = { type: 'image', id: el.dataset.id }; renderOverlay(); break;
      case 'img-del': imageDelete(); break;
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

  // 入力欄: 観察の文字と時刻は、入力し終わった時(欄から離れた時)に保存する
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches && t.matches('input[type=file][data-upload]')) {
      const file = t.files && t.files[0]; const target = t.dataset.upload; t.value = '';
      if (file) uploadImage(file, target);
      return;
    }
    if (t.dataset && t.dataset.obs) { saveObs({ [t.dataset.obs]: t.value.trim() }); return; }
    if (t.dataset && t.dataset.medTime) {
      const f = t.dataset.medTime; const m = parseMed(obsNow()[f]);
      if (m.st === 'yes' || m.st === 'part') saveObs({ [f]: m.st + (t.value ? ' ' + t.value : '') });
    }
  });
  // シートの入力中の文字を覚えておく(描き直しても消えないように)
  document.addEventListener('input', (e) => {
    if (!sheet) return;
    const t = e.target;
    if (t.id === 'memo-text') sheet.text = t.value;
    if (t.id === 'react-label') { sheet.label = t.value; const b = document.querySelector('.react-preview b'); if (b) b.textContent = t.value || '…'; }
    if (t.id === 'react-emoji') sheet.emoji = t.value;
  });

  document.addEventListener('submit', (e) => {
    if (e.target.id === 'login-form') { e.preventDefault(); doLogin(e.target); }
    if (e.target.id === 'settings-form') { e.preventDefault(); saveSettings(e.target); }
    if (e.target.id === 'health-form') { e.preventDefault(); saveHealthLink(e.target); }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (cfg.role !== 'supporter') curDate = logicalToday();
    render(); refresh(true);
  });

  /* ========== 起動 ========== */
  (async function boot() {
    try { await Promise.race([preloadImages(), new Promise((r) => setTimeout(r, 400))]); } catch (e) { /* 無視 */ }
    render();
    if (cfg.token) { processQueue(); refresh(true); }
  })();
})();
