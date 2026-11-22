/* くまの記録 — app.js
 * ビルド不要の素のJavaScript。画面は1ファイルで完結する。
 * 記録するのは家族(サポーター)。本人の画面は「くまとひとこと」だけで、体調のことは一切たずねない。
 * 方針: 押した瞬間に画面を更新し(楽観的更新)、送信はキューで裏側に行う。
 *       通信が遅い・切れている時でも「記録できた」体験を途切れさせない。 */
(function () {
  'use strict';

  /* ========== 保存(localStorage) ========== */
  const KEYS = { cfg: 'kuma.cfg', state: 'kuma.state3', queue: 'kuma.queue', idmap: 'kuma.idmap', thanked: 'kuma.thanked', look: 'kuma.look', prnNames: 'kuma.prnNames', wx: 'kuma.wxAt', wxNext: 'kuma.wxNext' };
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
  const QUEUE_ACTIONS = new Set(['saveObs', 'addMemo', 'updateMemo', 'deleteMemo', 'react', 'seenReactions', 'saveSettings', 'consentHealth', 'saveImageConfig', 'deleteImage', 'striveDone', 'striveDelete']);
  let cache = load(KEYS.state, null);
  // 前の版の未送信(服薬ボタンなど)は今の仕組みでは送れないので捨てる
  let queue = load(KEYS.queue, []).filter((q) => q && q.req && QUEUE_ACTIONS.has(q.req.action));
  let idmap = load(KEYS.idmap, {});

  /* ========== 日付ユーティリティ ========== */
  const pad = (n) => String(n).padStart(2, '0');
  const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
    meal:     { label: '食事の量', opts: [[4, 'よく食べた'], [3, 'ふつう'], [2, '半分くらい'], [1, '少し'], [0, 'ほぼ食べず']] },
    movement: { label: '不随意運動の見た目', opts: [[1, 'ほぼなし'], [2, '少し'], [3, '中くらい'], [4, '強い'], [5, 'とても強い']] },
    alcohol:  { label: 'アルコール', opts: [[0, 'なし'], [1, 'あり']] },
    sleep_onset: { label: '寝つき', opts: [[0, 'すぐ眠れた'], [1, '少し時間がかかった'], [2, 'なかなか眠れなかった']] },
    evening:  { label: '寝るまでのようす', opts: [[0, 'おだやか'], [1, '少しつらそう'], [2, 'つらそう']] },
    bath:     { label: 'お風呂', opts: [[2, '湯ぶね'], [1, 'シャワー'], [0, '入らなかった']] }
  };
  const EASY = [['morning', '朝'], ['noon', '昼'], ['evening', '夕方'], ['night', '夜']];
  const COMPLAINT = [['pain', '痛み'], ['dizzy', 'ぐるぐる'], ['other', 'その他']];
  const ACTIVITY = [['work', '会社出勤'], ['overtime', '+残業'], ['lesson', '習い事'], ['ballet', 'バレエ']];
  const SET_OPTS = { easy_times: EASY, complaint: COMPLAINT, activity: ACTIVITY };
  // 記録画面のカテゴリー。並び順は「設定」タブで変えられる(settings の card_order)
  const CARD_DEFS = [['sleep', '昨夜の眠り'], ['morning', '朝のようす'], ['day', '日中のようす'], ['night', '夜のようす'], ['look', '見た目のようす・本人のことば'],
    ['easy', '楽そうだった時間・できたこと'], ['meds', 'おくすり'], ['alcohol', 'アルコール'], ['memo', '気になったこと']];
  // 保存した並びに無いカテゴリー(あとから増えたもの)は、最初の並びで 1 つ前にあるカテゴリーのすぐ後ろに入れる
  function cardOrder(s) {
    const known = CARD_DEFS.map((d) => d[0]);
    const out = [];
    String((s && s.card_order) || '').split(',').forEach((k) => { if (known.includes(k) && !out.includes(k)) out.push(k); });
    known.forEach((k, i) => {
      if (out.includes(k)) return;
      let at = 0;
      for (let j = i - 1; j >= 0; j--) { const p = out.indexOf(known[j]); if (p >= 0) { at = p + 1; break; } }
      out.splice(at, 0, k);
    });
    return out;
  }
  // 時刻は 4 桁の数字で入れる: "0815" "815" "08:15" "０８１５" → "08:15"。空なら ''、読めなければ null
  function parseHm(v) {
    const d = String(v || '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[^0-9]/g, '');
    if (!d) return '';
    if (d.length < 3 || d.length > 4) return null;
    const h = parseInt(d.slice(0, -2), 10), m = parseInt(d.slice(-2), 10);
    if (h > 23 || m > 59) return null;
    return `${pad(h)}:${pad(m)}`;
  }
  // 欄には 4 桁で出す("07:30" → "0730")
  const hmInput = (attrs, value) => `<input type="text" class="hm" inputmode="numeric" autocomplete="off" maxlength="5" placeholder="例: 0730" value="${esc(String(value || '').replace(':', ''))}" ${attrs}>`;
  // 朝の薬のボタンには、設定の「朝の薬で分けて書く薬の名前」を出す(名前はスプレッドシートにだけ保存し、プログラムには書かない)
  const medName = (s) => String(s.med2_label || '').trim() || '別の薬';
  function medRows(s) {
    const n = medName(s);
    return [
      ['med_morning', '朝の薬', [['all', `${n}全部飲んだ`], ['part', `${n}一部飲んだ`], ['noc', `${n}以外飲んだ`]]],
      ['med_night', '寝る前の薬', [['yes', '飲んだ'], ['part', '一部'], ['no', '飲まなかった']]]
    ];
  }
  // "all 08:10" → { st: 'all', t: '08:10' }。前の版の朝の "yes" は「全部飲んだ」として読む
  const parseMed = (v, morning) => {
    const [st0, t] = String(v || '').split(' ');
    return { st: morning && st0 === 'yes' ? 'all' : (st0 || ''), t: t || '' };
  };
  const hmKey = (t) => { const [h, m] = t.split(':').map(Number); return (h < 4 ? h + 24 : h) * 60 + m; }; // 深夜は前の日の続き
  // 寝る前の薬が「早い」時刻(朝 4 時〜夕方 17 時台)か。深夜 0〜3 時台は前の日の夜の続きなので含めない(サーバーと同じ決まり)
  const isEarlyNight = (v) => { const m = parseMed(v); return (m.st === 'yes' || m.st === 'part') && /^(0[4-9]|1[0-7]):[0-5]\d$/.test(m.t); };
  // 他の薬(頓服など)の記録。1 回分は「時刻」か「時刻 薬の名前」(例: '13:20 痛み止め')で、カンマでつなぐ
  const prnList = (o) => String((o && o.prn_times) || '').split(',').filter(Boolean);
  const prnItem = (s) => { const i = s.indexOf(' '); return i < 0 ? { t: s, name: '' } : { t: s.slice(0, i), name: s.slice(i + 1) }; };
  const prnClean = (v) => String(v || '').replace(/[,，]/g, '、').replace(/\s+/g, ' ').trim().slice(0, 30);
  const prnStr = (t, name) => { const n = prnClean(name); return n ? t + ' ' + n : t; };

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
  const appTitle = () => String(settingsNow().app_title || '').trim() || 'くまの記録';
  const startDate = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String((s || settingsNow()).start_date || '')) ? (s || settingsNow()).start_date : '');
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
  async function cachePutKey(key, blob) {
    if (!window.caches) return;
    try { const c = await caches.open(IMG_CACHE); await c.put(key, new Response(blob, { headers: { 'Content-Type': blob.type } })); } catch (e) { /* 保存できなくても表示はできる */ }
  }
  const cachePut = (id, blob) => cachePutKey(imgKey(id), blob);
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
  async function preloadImages() { await Promise.all(wantedImageIds().concat(cfg.token ? [] : lookImageIds()).map((id) => loadUpImage(id))); }

  /* ---- StrivePD のスクショ(本人が毎週送る。記録する人が一覧で見て、分析用に書き出す) ----
   * 画像は「登録した画像」とは別のシート(strive)に入る。見た画像はこの端末にも保存して使い回す */
  const shot = { url: {}, loading: {}, failed: {} };
  const shotKey = (id) => new URL('__kuma_strive/' + id, location.href).href;
  async function shotBlob(id) {
    if (window.caches) { try { const c = await caches.open(IMG_CACHE); const hit = await c.match(shotKey(id)); if (hit) return await hit.blob(); } catch (e) { /* 無視 */ } }
    const data = await call({ action: 'getStrive', id });
    if (!data.ok) throw new Error(data.error || 'get');
    const blob = dataUrlToBlob(data.data);
    await cachePutKey(shotKey(id), blob);
    return blob;
  }
  async function loadShot(id) {
    if (shot.url[id] || shot.loading[id]) return;
    if (shot.failed[id] && Date.now() - shot.failed[id] < 60000) return;
    shot.loading[id] = true;
    try {
      shot.url[id] = URL.createObjectURL(await shotBlob(id));
      if (sheet && (sheet.type === 'striveweek' || sheet.type === 'shot')) renderOverlay();
    } catch (e) {
      shot.failed[id] = Date.now();
    } finally {
      delete shot.loading[id];
    }
  }
  const blobToDataUrl = (blob) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(new Error('read')); fr.readAsDataURL(blob); });

  /* ---- ログイン画面の見た目 ----
   * ログインしている間に、ログイン画面の画像と、本人・記録する人の名前をこの端末に覚えておく(ログアウトしても消さない)。
   * 名前と登録した画像は公開のサイトには置かないので、一度もログインしていない端末では内蔵のくまと「記録する人」「本人」が出る */
  let look = load(KEYS.look, {});
  function rememberLook() {
    const s = settingsNow();
    const own = (role) => (cfg.role === role ? String(cfg.name || '').trim() : '');
    const next = {
      role: cfg.role || look.role || '', // この端末を最後に使った人(ログイン画面で最初から選んでおく)
      title: slotRef('title'), role_supporter: slotRef('role_supporter'), role_patient: slotRef('role_patient'),
      supporter: String(s.supporter_name || '').trim() || own('supporter') || look.supporter || '',
      patient: String(s.patient_name || '').trim() || own('patient') || look.patient || ''
    };
    if (JSON.stringify(next) !== JSON.stringify(look)) { look = next; save(KEYS.look, look); }
    lookImageIds().forEach((id) => loadUpImage(id)); // ログアウトしたあとも出せるように、端末に保存しておく(保存ずみなら何もしない)
  }
  const lookImageIds = () => [look.title, look.role_supporter, look.role_patient].filter((r) => typeof r === 'string' && r.startsWith('u:')).map((r) => r.slice(2));

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
  function picText(slot, def, refOverride) {
    const ref = refOverride || slotRef(slot);
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
      else if (data.ok) { cache = data; save(KEYS.state, cache); render(); syncWeather(data); }
      else if (data.error === 'unauthorized') logout('ログインし直してください');
      else if (!silent) toast(data.message || '読み込みに失敗しました');
    } catch (e) {
      if (!silent) toast('通信できませんでした。記録はあとで送ります');
    }
    refreshing = false; renderSync();
    if (stale && !queue.length) refresh(true);
  }

  /* ========== 天気と気圧 ==========
   * 記録する人の iPhone が、天気のサービス(Open-Meteo。登録なし・無料)から 1 時間ごとの気圧と気温を取り、
   * 日ごとにまとめてスプレッドシートへ送る。送るのは設定の場所(緯度・経度、約 1km の粗さ)だけ。
   * 取りに行く日はサーバーが決める(state の weather_need)。取れなくても記録には関係しないので、だまって次の機会に */
  const WX_API = 'https://api.open-meteo.com/v1/forecast';
  const WX_GEO = 'https://geocoding-api.open-meteo.com/v1/search';
  const WX_BACK = 90; // 天気のサービスが返せるのは、だいたい 3 か月前まで
  let wxBusy = false, wxAnnounce = false;
  // from〜to の日ごとの値(1 時間ごとの気圧・気温・湿度と、その日の天気)。final = その日が終わっている(0 時区切り)
  async function wxFetch(place, from, to) {
    const [lat, lon] = place.split(',');
    const today = fmtDate(new Date());
    const q = `latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&hourly=pressure_msl,temperature_2m,relative_humidity_2m` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=Asia%2FTokyo&start_date=${from}&end_date=${to}`;
    const j = await (await fetch(`${WX_API}?${q}`)).json();
    const H = j && j.hourly, D = j && j.daily;
    if (!H || !D || !Array.isArray(H.time) || !Array.isArray(D.time)) throw new Error((j && j.reason) || 'weather');
    const byDay = {};
    H.time.forEach((t, k) => { (byDay[String(t).slice(0, 10)] = byDay[String(t).slice(0, 10)] || []).push(k); });
    return D.time.map((d, i) => {
      const pick = (arr) => (byDay[d] || []).map((k) => (arr ? arr[k] : null));
      const at = (arr) => (arr ? arr[i] : null);
      return { date: d, p: pick(H.pressure_msl), t: pick(H.temperature_2m), h: pick(H.relative_humidity_2m),
        t_max: at(D.temperature_2m_max), t_min: at(D.temperature_2m_min), precip: at(D.precipitation_sum), wcode: at(D.weather_code), final: d < today ? 1 : 0 };
    });
  }
  async function syncWeather(data) {
    const s = (data && data.settings) || {};
    if (cfg.role !== 'supporter' || wxBusy || !data.weather_need || !s.weather_place) return;
    if (Date.now() - (Number(load(KEYS.wx, 0)) || 0) < 15 * 60e3) return; // 取りに行くのは 15 分に 1 回まで
    wxBusy = true; save(KEYS.wx, Date.now());
    const today = fmtDate(new Date()); // 天気は 0 時区切りの日
    let from = data.weather_need;
    if (from < addDays(today, -WX_BACK)) from = addDays(today, -WX_BACK);
    let saved = -1;
    try {
      const days = await wxFetch(s.weather_place, from, today);
      const r = await call({ action: 'saveWeather', place: s.weather_place, days });
      if (r.ok) saved = r.dates.length;
      else if (r.error === 'place_changed') save(KEYS.wx, 0);
    } catch (e) { /* 次の機会に */ }
    wxBusy = false;
    if (wxAnnounce) { wxAnnounce = false; toast(saved >= 0 ? `天気と気圧を ${saved}日分 取り込みました` : '天気と気圧を取り込めませんでした。あとでもう一度試します'); }
    if (saved > 0) refresh(true);
  }
  // 天気の種類(WMO の番号)→ [絵, ことば]。その日のうちで、いちばん崩れた時の天気
  function wxLabel(c) {
    if (c == null) return ['', ''];
    if (c === 0) return ['☀️', '快晴'];
    if (c === 1) return ['🌤️', '晴れ'];
    if (c === 2) return ['⛅', '晴れ時々くもり'];
    if (c === 3) return ['☁️', 'くもり'];
    if (c === 45 || c === 48) return ['🌫️', '霧'];
    if (c >= 51 && c <= 57) return ['🌦️', '霧雨'];
    if (c >= 61 && c <= 67) return ['🌧️', c === 65 || c === 67 ? '強い雨' : '雨'];
    if (c >= 71 && c <= 77) return ['🌨️', '雪'];
    if (c >= 80 && c <= 82) return ['🌦️', 'にわか雨'];
    if (c === 85 || c === 86) return ['🌨️', 'にわか雪'];
    if (c >= 95) return ['⛈️', '雷雨'];
    return ['', ''];
  }
  const signed = (v, dg) => (v == null ? '' : (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(dg));
  // 記録の画面の上に出す 1 行(押すと 3 時間ごとの気圧と気温)
  function weatherLine(w, isToday) {
    if (!w || w.p_mean == null) return '';
    const [ico, label] = wxLabel(w.wcode);
    const temp = w.t_max != null && w.t_min != null ? `${Math.round(w.t_min)}〜${Math.round(w.t_max)}℃` : '';
    const hp = (w.hourly && Array.isArray(w.hourly.p)) ? w.hourly.p : [];
    const ht = (w.hourly && Array.isArray(w.hourly.t)) ? w.hourly.t : [];
    const hours = [];
    for (let h = 0; h < hp.length; h += 3) if (hp[h] != null) hours.push(`<span>${h}時 <b>${Math.round(hp[h])}</b>${ht[h] != null ? ` ${Math.round(ht[h])}℃` : ''}</span>`);
    return `<details class="wx"><summary><span class="wx-main">${ico ? `<span aria-hidden="true">${ico}</span>` : ''}${esc(label)}${temp ? ` ${temp}` : ''}</span>
        <span class="wx-p">気圧 <b>${Math.round(w.p_mean)}</b> hPa${w.p_diff != null ? `<small>(前日より ${signed(w.p_diff, 1)})</small>` : ''}</span></summary>
      <div class="wx-more">${w.p_drop != null ? `<p>1日の中で下がった幅: <b>${w.p_drop.toFixed(1)}</b> hPa${w.precip ? ` ・ 雨 ${w.precip} mm` : ''}${w.humidity != null ? ` ・ 湿度 ${w.humidity}%` : ''}</p>` : ''}
        ${hours.length ? `<div class="wx-hours">${hours.join('')}</div>` : ''}
        <p class="help">住まいの地域の気象データ(Open-Meteo)。気圧は海面気圧の1日の平均${isToday && !w.final ? '。きょうの分は、この先の時間の予報を含みます' : ''}。</p></div></details>`;
  }
  /* ---- あしたの気圧の予報(記録する人の画面だけ。保存はせず、この端末に 1 時間だけ覚えておく) ---- */
  const WX_BIG = 5; // 「大きく下がる見込み」の目安(hPa)。レポートの「前の日より 5hPa 以上下がった日」と同じ
  let wxNextBusy = false;
  // 1 日分の気圧のまとめ: 平均・いちばん低い時刻・その日の中で下がる幅(それまでの最高から)
  function wxSum(d) {
    const ps = (d.p || []).map((v, h) => [h, v]).filter(([, v]) => typeof v === 'number');
    if (ps.length < 18) return null;
    let top = -Infinity, drop = 0, low = ps[0];
    ps.forEach((x) => { if (x[1] > top) top = x[1]; if (top - x[1] > drop) drop = top - x[1]; if (x[1] < low[1]) low = x; });
    return { p_mean: ps.reduce((a, x) => a + x[1], 0) / ps.length, p_drop: drop, low_h: low[0], low_p: low[1] };
  }
  // date(あした)の予報。古い(1 時間より前)か無ければ取りに行き、取れたら描き直す
  function wxNext(place, date) {
    const c = load(KEYS.wxNext, null);
    const hit = c && c.place === place && c.date === date ? c : null;
    if ((!hit || Date.now() - hit.at > 60 * 60e3) && !wxNextBusy && navigator.onLine !== false) {
      wxNextBusy = true;
      wxFetch(place, addDays(date, -1), date).then((days) => {
        const d0 = days.find((x) => x.date === addDays(date, -1)), d1 = days.find((x) => x.date === date);
        const s0 = d0 && wxSum(d0), s1 = d1 && wxSum(d1);
        if (!s1) throw new Error('no forecast');
        save(KEYS.wxNext, { place, date, at: Date.now(), today_mean: s0 ? s0.p_mean : null, next: Object.assign({}, d1, s1) });
        wxNextBusy = false;
        if (tab === 'today') scheduleRender();
      }).catch(() => {
        // 取れなかった時は 10 分後にもう一度
        save(KEYS.wxNext, Object.assign({}, hit || { place, date }, { at: Date.now() - 50 * 60e3 }));
        wxNextBusy = false;
      });
    }
    return hit && hit.next ? hit : null;
  }
  // 記録の画面(きょう)の天気の下に出す、あしたの予報
  function forecastLine(s, date, todayW) {
    if (!s.weather_place) return '';
    const next = addDays(date, 1);
    const f = wxNext(s.weather_place, next);
    if (!f) return '';
    const n = f.next;
    const base = todayW && todayW.p_mean != null ? todayW.p_mean : f.today_mean;
    const diff = base != null ? Math.round((n.p_mean - base) * 10) / 10 : null;
    const big = (diff != null && diff <= -WX_BIG) || n.p_drop >= WX_BIG;
    const [ico, label] = wxLabel(n.wcode);
    const temp = n.t_max != null && n.t_min != null ? `${Math.round(n.t_min)}〜${Math.round(n.t_max)}℃` : '';
    const hours = [];
    for (let h = 0; h < (n.p || []).length; h += 3) if (n.p[h] != null) hours.push(`<span>${h}時 <b>${Math.round(n.p[h])}</b>${n.t && n.t[h] != null ? ` ${Math.round(n.t[h])}℃` : ''}</span>`);
    return `<details class="wx next${big ? ' big' : ''}"><summary><span class="wx-when">あした ${jpShort(next)}(${DOW[dowOf(next)]})の予報</span>
        <span class="wx-main">${ico ? `<span aria-hidden="true">${ico}</span>` : ''}${esc(label)}${temp ? ` ${temp}` : ''}</span>
        <span class="wx-p">気圧 <b>${Math.round(n.p_mean)}</b> hPa${diff != null ? `<small>(きょうより ${signed(diff, 1)})</small>` : ''}</span>
        ${big ? '<span class="wx-badge">⤵ 気圧が大きく下がる見込み</span>' : ''}</summary>
      <div class="wx-more"><p>その日の中で下がる幅: <b>${n.p_drop.toFixed(1)}</b> hPa ・ いちばん低いのは <b>${n.low_h}時ごろ</b>(${Math.round(n.low_p)} hPa)${n.precip ? ` ・ 雨 ${n.precip} mm` : ''}</p>
        ${hours.length ? `<div class="wx-hours">${hours.join('')}</div>` : ''}
        <p class="help">予報なので変わることがあります(${fmtStamp(new Date(f.at).toISOString(), true)} に取得)。⤵ は、きょうより ${WX_BIG}hPa 以上低いか、あしたの中で ${WX_BIG}hPa 以上下がる見込みの時。本人には伝えずに、予定を軽くする目安にしてください。</p></div></details>`;
  }
  // 設定の「天気を調べる場所」を保存する。数字(緯度,経度)か、市の名前(天気のサービスで探す)
  async function saveWeatherPlace(form) {
    const raw = String(new FormData(form).get('weather_place') || '').trim();
    let place = '', found = '';
    if (raw) {
      const t = raw.replace(/[０-９．，－]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
      const m = /^(-?\d{1,2}(?:\.\d+)?)\s*[,、\s]\s*(-?\d{1,3}(?:\.\d+)?)$/.exec(t);
      if (m && Math.abs(+m[1]) <= 90 && Math.abs(+m[2]) <= 180) place = `${(+m[1]).toFixed(2)},${(+m[2]).toFixed(2)}`;
      else {
        toast('場所を探しています…');
        try {
          const j = await (await fetch(`${WX_GEO}?name=${encodeURIComponent(raw)}&count=1&language=ja&countryCode=JP`)).json();
          const g = j && Array.isArray(j.results) && j.results[0];
          if (!g || typeof g.latitude !== 'number') { toast('その名前では見つかりませんでした。市の名前か、緯度,経度の数字で入れてください'); return; }
          place = `${g.latitude.toFixed(2)},${g.longitude.toFixed(2)}`;
          found = [g.admin1, g.name].filter((x, i, a) => x && a.indexOf(x) === i).join(' ');
        } catch (e) { toast('通信できませんでした'); return; }
      }
    }
    if (place === String(settingsNow().weather_place || '')) { toast(place ? 'この場所で保存ずみです' : '天気と気圧は取り込んでいません'); render(); return; }
    const settings = { weather_place: place };
    save(KEYS.wx, 0); wxAnnounce = !!place;
    enqueue({ action: 'saveSettings', settings }, (c) => { c.settings = Object.assign({}, c.settings, settings); c.weather = null; });
    listData = null;
    toast(place ? `${found ? found + ' の' : ''}場所(${place})を保存しました。天気を取り込みます…` : '天気と気圧の取り込みを止めました');
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
  let loginRole = look.role === 'patient' ? 'patient' : 'supporter';
  const lookName = (role) => String(look[role] || '').trim();
  const loginNamePh = (role) => lookName(role) || (role === 'patient' ? '例: はなこ' : '例: たろう');
  function viewLogin() {
    const sup = lookName('supporter'), pat = lookName('patient');
    return `<div class="login">
      <div class="hero">${picFor(look.title || slotRef('title'), 'normal', 'bear-bob')}<h1>くま</h1><p class="muted">家族の、ちいさなアプリ</p></div>
      <form id="login-form" class="card">
        ${FIXED_API
          ? `<input type="hidden" name="apiUrl" value="${esc(cfg.apiUrl)}">`
          : `<label class="field"><span>API のURL(Apps Script のウェブアプリURL)</span>
          <input type="url" name="apiUrl" value="${esc(cfg.apiUrl)}" placeholder="https://script.google.com/macros/s/…/exec" required autocomplete="off"></label>`}
        <label class="field"><span>家族コード</span><input type="password" name="code" required autocomplete="current-password"></label>
        <span class="small muted" style="display:block;margin-bottom:6px;font-weight:600">この iPhone を使うのは…</span>
        <div class="role-grid">
          <button type="button" class="btn ${loginRole === 'supporter' ? 'sel' : ''}" data-act="login-role" data-role="supporter">${picText('role_supporter', '🧸', look.role_supporter)} ${esc(sup || '記録する人')}<small class="sub">${sup ? '記録する人' : '家族'}</small></button>
          <button type="button" class="btn ${loginRole === 'patient' ? 'sel' : ''}" data-act="login-role" data-role="patient">${picText('role_patient', '🐻', look.role_patient)} ${esc(pat || '本人')}<small class="sub">${pat ? '本人・くまの部屋' : 'くまの部屋'}</small></button>
        </div>
        <label class="field"><span>名前(表示に使います)</span><input type="text" name="name" value="${esc(cfg.name || lookName(loginRole))}" placeholder="${esc(loginNamePh(loginRole))}"></label>
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
    const name = s.health_shortcut_name || 'KMヘルスチェック送信';
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
      `<section class="card room"><button class="bear-btn ${patMsg ? 'bear-pat' : ''}" data-act="pat" aria-label="くまをなでる">${pic(slot, 'bear-bob')}</button>${bubble}</section>` +
      patientStrive(data.strive);
  }
  // 日曜日(か、記録する人が「きょう出す」を押した日)の案内: StrivePD の画面のスクショを選んで送る。体調のことばは出さない
  const shotPicker = (label, cls) => `<label class="btn ${cls || 'primary'} upload-btn">${label}<input type="file" accept="image/*" multiple data-upload="strive"></label>`;
  function patientStrive(st) {
    if (!st || (!st.show && !striveProg)) return '';
    const n = st.count || 0;
    return `<section class="card strive-ask pat">
      <h2>📷 StrivePD の しゃしん <span class="link">${jpShort(st.week)}〜${jpShort(st.to)}</span></h2>
      <p>「週」の画面を 1まい と、「日」の画面を 月〜日の 7まい。スクリーンショットを えらんで、くまに とどけてね。<small class="muted">(いちどに ${SHOT_BATCH}まい まで)</small></p>
      ${striveProg ? `<p class="strive-prog" role="status">おくっています… ${striveProg.i} / ${striveProg.n}まい<br><small>おわるまで この画面のままで まってね</small></p>`
        : shotPicker(n ? 'しゃしんを たす' : 'しゃしんを えらぶ', n ? 'outline big' : 'primary big')}
      ${n && !striveProg ? `<p class="strive-count">いま <b>${n}</b>まい とどいているよ</p>
        <button class="btn primary" data-act="strive-done">これで おしまい</button><p class="help center">たりなくても だいじょうぶ。</p>` : ''}
    </section>`;
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
    return topbar(esc(appTitle()), right) + tabs + body;
  }

  function scaleField(key, o, extra, noLabel) {
    const def = SCALES[key];
    const cur = o[key] == null ? null : Number(o[key]);
    return `<div class="obs-field">${noLabel ? '' : `<div class="obs-label">${def.label}</div>`}<div class="chips">${def.opts.map(([v, l]) =>
      `<button class="chip-btn ${cur === v ? 'sel' : ''}" data-act="obs" data-f="${key}" data-v="${v}" aria-pressed="${cur === v}">${l}</button>`).join('')}${extra || ''}</div></div>`;
  }
  // カテゴリーごとの備考欄(入力し終わって欄から離れた時に保存)
  // 備考欄。下に、ほかの日に書いた備考を 3 つまで出す(書き方をそろえるため)。押すと全文が見える
  let noteExamples = {};
  const noteField = (o, key, ph, label) => {
    const ex = (noteExamples[key] || []).filter((x) => x && x.text);
    return `<label class="note-field"><span>${label || '備考'}</span><textarea class="note" data-obs="${key}" maxlength="500" rows="1" placeholder="${esc(ph)}">${esc(o[key] || '')}</textarea></label>` +
      (ex.length ? `<div class="note-ex" data-act="note-ex" role="button" aria-label="ほかの日の${esc(label || '備考')}(押すと全文)"><div class="h">ほかの日の${esc(label || '備考')}</div>${ex.map((x) => `<div class="i"><span class="d">${jpShort(x.date)}</span>${esc(x.text)}</div>`).join('')}</div>` : '');
  };
  const fitNote = (t) => { t.style.height = 'auto'; t.style.height = (t.scrollHeight + 4) + 'px'; }; // 書いた分だけ欄を伸ばす
  function setChips(key, opts, cur) {
    const sel = new Set(String(cur || '').split(',').filter(Boolean));
    return `<div class="chips">${opts.map(([v, l]) =>
      `<button class="chip-btn ${sel.has(v) ? 'sel' : ''}" data-act="obs-set" data-f="${key}" data-v="${v}" aria-pressed="${sel.has(v)}">${l}</button>`).join('')}</div>`;
  }

  function viewRecord(data) {
    const today = logicalToday();
    const sd = startDate();
    const nav = `<div class="row date-nav"><button class="btn outline nav-btn" data-act="date" data-delta="-1" aria-label="前の日" ${sd && curDate <= sd ? 'disabled' : ''}>◀</button>
      <button class="date-btn spacer" data-act="cal-open" aria-label="カレンダーから日付を選ぶ"><span class="cal-ico" aria-hidden="true">📅</span><b>${jpDate(curDate)}</b>${curDate === today ? '<span class="chip">きょう</span>' : ''}</button>
      <button class="btn outline nav-btn" data-act="date" data-delta="1" aria-label="次の日" ${curDate >= today ? 'disabled' : ''}>▶</button></div>`;
    if (!data) return nav + `<div class="card center muted">読み込んでいます…</div>`;
    const o = data.obs || {};
    const s = data.settings || {};
    const pr = data.progress;
    noteExamples = data.recent_notes || {};
    let progress = '';
    if (pr) {
      const left = s.next_appointment ? daysBetween(curDate, s.next_appointment) : null;
      const fromLabel = s.last_appointment && pr.since === s.last_appointment ? `前回の診察(${jpShort(pr.since)})から`
        : pr.since === startDate(s) ? `記録の開始日(${jpShort(pr.since)})から` : `${jpShort(pr.since)}から`;
      progress = `<p class="progress-line small">${fromLabel} 記録 <b>${pr.recorded}日</b> / ${pr.days}日${left != null ? `<br>次の診察まで <b>${left >= 0 ? left + '日' : '過ぎています'}</b>` : ''}</p>`;
    }
    // 起きてきた時刻・布団に入った時刻を入れていない日は、iPhone の睡眠の時刻を代わりに使う(一覧・レポート・書き出しも同じ)
    const sl = data.sleep_times || {};
    const autoHint = (v, t, what) => (v ? '' : t ? `<p class="help auto-hint">未入力なので、iPhone の睡眠の${what} <b>${esc(t)}</b> を使います。</p>`
      : `<p class="help">入れない日は、iPhone の睡眠の${what}を使います(届いた時)。</p>`);
    const wake = `<div class="obs-field"><div class="obs-label">起きてきた時刻</div><div class="row">
        ${hmInput('data-obs-hm="wake_time" style="max-width:120px" aria-label="起きてきた時刻(4桁)"', o.wake_time)}
        ${curDate === today ? '<button class="chip-btn" data-act="wake-now">いま</button>' : ''}</div>${autoHint(o.wake_time, sl.wake, '目が覚めた時刻')}</div>`;
    const isToday = curDate === today;
    const bed = `<div class="obs-field"><div class="obs-label">布団に入った時刻</div><div class="row">
        ${hmInput('data-obs-hm="bed_time" style="max-width:120px" aria-label="布団に入った時刻(4桁)"', o.bed_time)}
        ${isToday ? '<button class="chip-btn" data-act="bed-now">いま</button>' : ''}</div>
        <p class="help">深夜 0〜3 時台も、この日の夜として入れます(例: 0120)。</p>${autoHint(o.bed_time, sl.bed, '眠り始めた時刻')}</div>`;
    const medBtn = (f, k, label, title, m) => {
      const sel = m.st === k;
      return `<button class="chip-btn med ${sel ? 'sel' : ''}" data-act="med" ${k === 'no' ? '' : 'data-lp="med"'} data-f="${f}" data-v="${k}" data-label="${esc(title + ': ' + label)}" aria-pressed="${sel}">${esc(label)}${sel && m.t ? `<small>${m.t}</small>` : ''}</button>`;
    };
    const meds = medRows(s).map(([f, title, states]) => {
      const m = parseMed(o[f], f === 'med_morning');
      return `<div class="obs-field"><div class="obs-label">${title}</div><div class="chips">${states.map(([k, l]) => medBtn(f, k, l, title, m)).join('')}</div>${f === 'med_night' ? earlyBox(o) : ''}</div>`;
    }).join('');
    const items = prnList(o).map(prnItem);
    const recent = prnRecent(o);
    const prn = `<div class="obs-field"><div class="obs-label">他の薬(頓服など)</div>
        <div class="row prn-row"><input type="text" id="prn-name" maxlength="30" value="${esc(prnDraft)}" placeholder="薬の名前(例: 痛み止め)" aria-label="他の薬の名前" enterkeyhint="done" autocomplete="off">
          <button class="chip-btn med" data-act="prn-add" data-lp="prn" data-label="他の薬を飲んだ">他の薬を飲んだ</button></div>
        ${prnChips(recent, prnDraft)}
        ${items.length || o.prn ? `<div class="chips prn-items">${items.map((p, i) => `<span class="pill"><button class="pill-t" data-act="prn-edit" data-lp="prn-edit" data-i="${i}" aria-label="${p.t} ${esc(p.name)} の時刻と名前を直す">${p.t}${p.name ? ` ${esc(p.name)}` : ''}</button><button class="pill-x" data-act="prn-del" data-i="${i}" aria-label="${p.t} ${esc(p.name)} を取り消す">×</button></span>`).join('')}
          ${!items.length && o.prn ? `<span class="pill">${o.prn}回(時刻なし)</span>` : ''}</div>` : ''}
        ${items.length ? '' : `<p class="help">名前を入れてから(下の名前を押しても入ります)「他の薬を飲んだ」を押すと、${isToday ? '今の時刻で記録します。<b>長押し</b>すると時刻を入れて記録できます' : '時刻を入れる欄が開きます'}。名前は空でも記録できます。記録したあとは、記録を押すか長押しすると、時刻と名前を直せます。名前の候補は × で消せます。</p>`}</div>`;
    const medHelp = `<p class="help">${isToday ? '押すと今の時刻で記録します。<b>長押し</b>すると時刻を入れられます。' : '前の日の分は、押すと時刻を入れる欄が開きます。'}もう一度押すと取り消せます。${s.med2_label ? '' : '<br>「設定」タブの「朝の薬で分けて書く薬の名前」を入れると、ボタンにその名前が出ます。'}</p>`;
    const snack = `<button class="chip-btn snack ${o.night_snack === 1 ? 'sel' : ''}" data-act="obs" data-f="night_snack" data-v="1" aria-pressed="${o.night_snack === 1}">寝る前の間食</button>`;
    const cards = {
      sleep: () => sleepCard(data.health, s, data.early_prev),
      morning: () => card('朝のようす', wake + scaleField('getup', o) + noteField(o, 'note_morning', '例: 起きてすぐふらついた')),
      day: () => card('日中のようす', scaleField('gait', o) + scaleField('lying', o) + scaleField('outing', o) +
        `<div class="obs-field"><div class="obs-label">仕事・習い事</div>${setChips('activity', ACTIVITY, o.activity)}</div>` +
        scaleField('meal', o, snack) + noteField(o, 'note_day', '例: 昼過ぎに2時間横になった')),
      night: () => card('夜のようす', scaleField('evening', o) +
        '<p class="help" style="margin:-4px 0 8px">夕食のあとから布団に入るまでを、あなたの目で見た印象で。</p>' +
        scaleField('bath', o) + bed + scaleField('sleep_onset', o) +
        '<p class="help" style="margin:-4px 0 8px">見ていて分かった日だけ。分からない日は空のままで。</p>' +
        noteField(o, 'note_night', '例: 寝る前に足がつらそうだった')),
      look: () => card('見た目のようす・本人のことば', scaleField('movement', o) +
        '<p class="help" style="margin:-4px 0 8px">あなたの目で見た印象で、いちばん目立った時で。</p>' +
        `<div class="obs-field"><div class="obs-label">本人が自分から口にしたこと</div>${setChips('complaint', COMPLAINT, o.complaint)}
          <p class="help">こちらからは聞きません。本人が自分から言った時だけ押します。</p></div>` +
        noteField(o, 'complaint_note', '例: 夕方「足が痛い」と言った')),
      easy: () => card('楽そうだった時間・できたこと', `<div class="obs-field"><div class="obs-label">楽そうだった時間帯</div>${setChips('easy_times', EASY, o.easy_times)}</div>` +
        noteField(o, 'good_note', '例: ドラマを見て笑っていた', 'できたこと') +
        '<p class="help">本人には聞かずに、見ていて気づいたことや、本人が自分から話したことだけ。</p>'),
      meds: () => card('おくすり', meds + prn + medHelp + noteField(o, 'note_meds', '例: 寝る前の薬が遅くなった')),
      alcohol: () => card('アルコール', scaleField('alcohol', o, '', true) + noteField(o, 'note_alcohol', '例: 夕食でビール1杯')),
      memo: () => memoCard(data, curDate)
    };
    return nav + progress + (isToday ? supporterStrive(data.strive, s) : '') + weatherLine(data.weather, isToday) + (isToday ? forecastLine(s, curDate, data.weather) : '') + cardOrder(s).map((k) => cards[k]()).join('') +
      `<p class="help center" style="margin:2px 0 12px">押した内容はその場で保存されます。</p>`;
  }

  // StrivePD のスクショの日の案内(記録の画面の上。本人が送り終わると消える)
  function supporterStrive(st, s) {
    if (!st || (!st.show && !striveProg)) return '';
    const t = thanksNow(s);
    return `<section class="card strive-ask">
      <h2>📷 StrivePD のスクショの日 <span class="link">${jpShort(st.week)}(月)〜${jpShort(st.to)}(日)</span></h2>
      <p class="small">本人に「アップして」と声をかけてください。本人の画面(くまの部屋)にも同じ案内が出ています。StrivePD の「週」の画面1枚と、「日」の画面(月〜日)7枚です(一度に${SHOT_BATCH}枚まで選べます)。${st.sunday ? '日曜の分は、夜に撮ると1日分そろいます。' : ''}</p>
      <p class="strive-count">届いた枚数 <b>${st.count || 0}</b> / ${st.full}枚</p>
      <p class="help">本人が${st.full}枚送るか「これでおしまい」を押すと、この案内は両方の画面から消え、${t ? `お礼のスタンプ「${esc(t.label)}」が本人に届きます` : 'お礼のスタンプは「設定」タブで選べます(いまは「なし」)'}。届いた画像は「一覧」タブで見られます。</p>
      ${striveProg ? `<p class="strive-prog" role="status">送っています… ${striveProg.i} / ${striveProg.n}枚</p>` : shotPicker('この iPhone から足す', 'outline')}
    </section>`;
  }

  // 歩き方・心拍: その日の平均と、1 日の中の幅(時刻ごとの値 metric_series から)
  const SERIES_DEFS = [['walking_speed', '歩く速さ', ' km/時'], ['step_length', '歩幅', ' cm'], ['walk_asym', '左右差', '%'], ['double_support', '両足支持', '%'],
    ['steadiness', '歩行安定性', '%'], ['resting_hr', '安静時心拍', ' 回/分'], ['hrv', '心拍変動', ' ms']];
  const seriesOf = (h, k) => (h && h.metric_series && Array.isArray(h.metric_series[k]) ? h.metric_series[k] : []);
  function metricRows(h) {
    return SERIES_DEFS.map(([k, l, u]) => {
      const v = h[k];
      if (v == null || v === '') return '';
      const sr = seriesOf(h, k); const vs = sr.map((p) => p[1]);
      const range = sr.length >= 2 ? `<small class="muted"> (${Math.min(...vs)}〜${Math.max(...vs)}・${sr.length}回)</small>` : '';
      return `<dt>${l}</dt><dd>${esc(String(v))}${/^[\d.]+$/.test(String(v)) ? u : ''}${range}</dd>`;
    }).join('');
  }
  function seriesDetails(h) {
    const rows = SERIES_DEFS.map(([k, l]) => { const sr = seriesOf(h, k); return sr.length ? `<div><b>${l}</b>${sr.map((p) => `<span>${esc(p[0])} ${esc(String(p[1]))}</span>`).join('')}</div>` : ''; }).join('');
    return rows ? `<details class="series"><summary>時刻ごとの値</summary>${rows}</details>` : '';
  }
  // 寝る前の薬が 18 時より前の時: 合っているかをたずねる。合っていれば「早く休んだ日」と出す
  function earlyBox(o) {
    if (!isEarlyNight(o.med_night)) return '';
    const t = parseMed(o.med_night).t;
    if (o.early_bed === 1) return `<p class="early-note">🌙 <b>早く休んだ日</b>(寝る前の薬 ${t})。夕方からの眠りは、次の日の「昨夜の眠り」に1晩として入ります。</p>`;
    return `<div class="early-ask"><p>寝る前の薬が <b>${t}</b> になっています(18時より前)。この時刻で合っていますか？</p>
      <div class="chips"><button class="chip-btn" data-act="early-ok">合っている(早く休んだ)</button><button class="chip-btn" data-act="early-fix">時刻を直す</button></div></div>`;
  }
  // 早い時刻の寝る前の薬を記録した直後にたずねる(「あとで」を押しても、おくすりの欄に同じ質問が残る)
  // たずねた時は true(そのシートに時刻が出るので、「記録しました」の知らせは出さない。ボタンに重なるため)
  function askEarly(f) {
    const o = obsNow();
    if (f !== 'med_night' || !isEarlyNight(o.med_night) || o.early_bed === 1) return false;
    sheet = { type: 'early', time: parseMed(o.med_night).t };
    renderOverlay();
    return true;
  }
  function earlySheetHTML() {
    return wrapSheet(`<h3>寝る前の薬 ${esc(sheet.time)}</h3>
      <p>18時より前の時刻です。この時刻で合っていますか？</p>
      <p class="help">合っていれば、この日を「早く休んだ日」として記録します。夕方からの眠りは、次の日の「昨夜の眠り」に1晩として入ります。</p>
      <div class="actions"><button class="btn primary" data-act="early-ok">合っている(早く休んだ)</button><button class="btn outline" data-act="early-fix">時刻を直す</button><button class="btn ghost" data-act="sheet-close">あとで</button></div>`);
  }
  const earlyPrevNote = (t) => (t ? `<p class="early-note">🌙 前の日は早く休みました(寝る前の薬 ${esc(t)})。夕方からの眠りも、この日の分として数えます。</p>` : '');
  function sleepCard(h, s, earlyPrev) {
    const hl = healthLink(s);
    if (!h || (h.sleep_min == null && h.steps == null && h.inbed_min == null && !SERIES_DEFS.some(([k]) => h[k] != null && h[k] !== ''))) {
      const last = s.health_last_at ? `最後に届いたのは ${fmtStamp(s.health_last_at, true)} です。` : '';
      const why = hl.consent ? last || '本人の iPhone の設定がすむと、毎日自動で届きます。'
        : '本人の同意と iPhone の設定がすむと、毎日自動で届きます(設定タブ)。';
      return card('昨夜の眠り <span class="link">自動</span>', `${earlyPrevNote(earlyPrev)}<p class="muted small">まだ届いていません。${esc(why)}</p>`);
    }
    const sl = h.sleep_min != null ? `${Math.floor(h.sleep_min / 60)}<small>時間</small>${pad(h.sleep_min % 60)}<small>分</small>` : '<span class="muted">—</span>';
    return card('昨夜の眠り <span class="link">自動</span>', `${earlyPrevNote(earlyPrev)}<div class="sleep-main">${sl}${h.awakenings != null ? `<small>目覚め ${h.awakenings}回</small>` : ''}</div>
      <dl class="kv">
        ${h.bed_start ? `<dt>寝た→起きた</dt><dd>${esc(h.bed_start)} → ${esc(h.bed_end || '')}</dd>` : ''}
        ${h.deep_min != null && h.deep_min > 0 ? `<dt>深い眠り</dt><dd>${h.deep_min}分</dd>` : ''}
        ${h.nap_min ? `<dt>昼寝など</dt><dd>${h.nap_min}分</dd>` : ''}
        ${h.steps != null ? `<dt>歩数</dt><dd>${Number(h.steps).toLocaleString()} 歩</dd>` : ''}
        ${metricRows(h)}
      </dl>${seriesDetails(h)}<p class="help">目覚め = 5分以上目が覚めた回数。歩き方は、iPhone をポケットに入れて歩いた時だけ測られます(きょうの分は途中まで)。かっこの中は1日の中の幅と測れた回数。</p>`);
  }

  function memoCard(data, date) {
    const items = (data.memos || []).map((m) => `<li class="row"><button class="memo-item" data-act="memo-edit" data-lp="memo-edit" data-id="${esc(m.id)}" aria-label="${hhmm(m.ts)} のメモを直す"><span class="muted small">${hhmm(m.ts)}</span><span class="memo-text">${esc(m.text)}</span></button><button class="icon-btn" data-act="memo-del" data-id="${esc(m.id)}" aria-label="削除">×</button></li>`).join('');
    // ほかの日のメモ(新しい順に 3 つまで)。押すと全文
    const past = (data.recent_memos || []).filter((m) => m && m.text);
    const pastHTML = past.length ? `<div class="note-ex" data-act="note-ex" role="button" aria-label="ほかの日の気になったこと(押すと全文)" style="margin-top:10px"><div class="h">ほかの日の気になったこと</div>${past.map((m) => `<div class="i"><span class="d">${jpShort(m.date)}</span>${hhmm(m.ts) ? `<span class="tm">${hhmm(m.ts)}</span>` : ''}${esc(m.text)}</div>`).join('')}</div>` : '';
    return `<section class="card"><h2>気になったこと <button class="link" data-act="memo-new" data-date="${date}">＋ メモする</button></h2>
      ${items ? `<ul style="list-style:none;margin:0;padding:0;display:grid;gap:6px">${items}</ul>` : '<p class="muted small">転んだ、むせた、動画を撮った、など。時刻つきで残ります。キーボードのマイクで声でも書けます。</p>'}${items ? '<p class="help">メモを押すと(長押しでも)、文と時刻を直せます。</p>' : ''}${pastHTML}
    </section>`;
  }

  /* ---- 一覧: 項目ごとの記録状況を 7 日ずつ ---- */
  const SYM3 = ['○', '△', '×'];
  const MED_SYM = { all: '●', yes: '●', noc: '◐', part: '◔', no: '○', '': '' };
  // 毎日つける項目(「記録した数」に数える)。間食・ことば・他の薬・仕事などは、あった日だけ押すので数えない
  const CORE = ['wake_time', 'getup', 'gait', 'lying', 'outing', 'meal', 'movement', 'med_morning', 'med_night', 'alcohol'];
  const filled = (v) => v != null && v !== '';
  // sl = その日の iPhone の睡眠の時刻 { wake, bed }。起きてきた時刻を入れていない日は、目が覚めた時刻があれば記録ありとする
  const coreCount = (o, sl) => CORE.filter((k) => filled(o && o[k]) || (k === 'wake_time' && sl && sl.wake)).length;
  // 時刻の行: 入れた時刻か、入れていない日は iPhone の睡眠の時刻({ auto } = 灰色で出す)
  const timeCell = (v, a) => (v ? String(v).replace(/^0/, '') : a ? { auto: String(a).replace(/^0/, '') } : '');
  const OBS_META = ['date', 'recorded_by', 'updated_at'];
  const anyObs = (o) => !!o && Object.keys(o).some((k) => !OBS_META.includes(k) && filled(o[k]));
  const sym = (list, v) => (v != null && list[v] != null ? list[v] : '');
  const setAbbr = (v, abbr) => { const set = String(v || '').split(','); return abbr.filter(([k]) => set.includes(k)).map(([, a]) => a).join(''); };
  const actAbbr = (v) => { const a = setAbbr(v, [['work', '出'], ['overtime', '残'], ['lesson', '習'], ['ballet', 'バ']]); return a.includes('残') ? a.replace('出', '') : a; };
  const fmtSteps = (n) => (n < 10000 ? String(n) : (n / 10000).toFixed(1).replace(/\.0$/, '') + '万');
  // [行の名前, 中身, 毎日つける項目か, その週に値がある時だけ出すか]。中身は (その日の観察, 眠りと歩数, メモの数) から作る
  const LIST_ROWS = {
    sleep: [['睡眠', (o, h) => (h && h.sleep_min != null ? (h.sleep_min / 60).toFixed(1) + 'h' : '')],
      ['歩数', (o, h) => (h && h.steps != null ? fmtSteps(h.steps) : '')],
      ['歩く速さ', (o, h) => (h && h.walking_speed != null ? h.walking_speed.toFixed(1) : ''), 0, 1],
      ['歩幅', (o, h) => (h && h.step_length != null ? String(Math.round(h.step_length)) : ''), 0, 1],
      ['左右差', (o, h) => (h && h.walk_asym != null ? h.walk_asym.toFixed(1) : ''), 0, 1],
      ['両足支持', (o, h) => (h && h.double_support != null ? String(Math.round(h.double_support)) : ''), 0, 1],
      ['歩行安定性', (o, h) => (h && h.steadiness ? String(h.steadiness) : ''), 0, 1],
      ['安静時心拍', (o, h) => (h && h.resting_hr != null ? String(Math.round(h.resting_hr)) : ''), 0, 1],
      ['心拍変動', (o, h) => (h && h.hrv != null ? String(Math.round(h.hrv)) : ''), 0, 1]],
    morning: [['起きた時刻', (o, h, n, sl) => timeCell(o.wake_time, sl && sl.wake), 1], ['起き上がり', (o) => sym(SYM3, o.getup), 1]],
    day: [['ふらつき', (o) => sym(SYM3, o.gait), 1], ['横になった', (o) => sym(['○', '少', '半', '全'], o.lying), 1],
      ['外出', (o) => sym(['無', '近', '外'], o.outing), 1], ['仕事など', (o) => actAbbr(o.activity)],
      ['食事', (o) => sym(['×', '少', '半', '普', '多'], o.meal), 1], ['間食', (o) => (o.night_snack === 1 ? '●' : '')]],
    night: [['寝るまで', (o) => sym(SYM3, o.evening)], ['お風呂', (o) => sym(['–', 'シ', '湯'], o.bath)],
      ['布団に入った', (o, h, n, sl) => timeCell(o.bed_time, sl && sl.bed)], ['寝つき', (o) => sym(SYM3, o.sleep_onset)]],
    look: [['見た目', (o) => (o.movement != null ? String(o.movement) : ''), 1],
      ['ことば', (o) => setAbbr(o.complaint, [['pain', '痛'], ['dizzy', 'ぐ'], ['other', '他']])]],
    easy: [['楽な時間', (o) => setAbbr(o.easy_times, [['morning', '朝'], ['noon', '昼'], ['evening', '夕'], ['night', '夜']])],
      ['できたこと', (o) => (o.good_note ? '✎' : '')]],
    meds: [['朝の薬', (o) => MED_SYM[parseMed(o.med_morning, true).st] || '', 1], ['寝る前の薬', (o) => MED_SYM[parseMed(o.med_night).st] || '', 1],
      ['早く休んだ', (o) => (o.early_bed === 1 ? '●' : ''), 0, 1],
      ['他の薬', (o) => { const n = prnList(o).length || o.prn || 0; return n ? n + '回' : ''; }]],
    alcohol: [['アルコール', (o) => sym(['無', '有'], o.alcohol), 1]],
    memo: [['メモ', (o, h, n) => (n ? n + '件' : '')]]
  };
  const LIST_NAMES = { sleep: '眠り・歩数・歩き方(自動)' };
  const NOTE_OF = { morning: 'note_morning', day: 'note_day', night: 'note_night', look: 'complaint_note', meds: 'note_meds', alcohol: 'note_alcohol' };
  const NOTE_LABELS = [['note_morning', '朝'], ['note_day', '日中'], ['note_night', '夜'], ['complaint_note', '見た目・ことば'], ['good_note', 'できたこと'], ['note_meds', '薬'], ['note_alcohol', 'アルコール']];
  // 一覧のいちばん下: 天気と気圧(その週に値がある時だけ)
  function weatherRows(days, td) {
    const wBy = {};
    ((listData && listData.weather) || []).forEach((w) => { wBy[w.date] = w; });
    if (!days.some((d) => wBy[d])) return '';
    const row = (label, fn) => `<tr><td class="lbl">${label}</td>${days.map((d) => td(d, wBy[d] ? fn(wBy[d]) : '')).join('')}</tr>`;
    return `<tr class="cat"><th colspan="${days.length + 1}">天気・気圧(自動)</th></tr>` +
      row('天気', (w) => wxLabel(w.wcode)[0]) +
      row('気温', (w) => (w.t_max != null && w.t_min != null ? `${Math.round(w.t_max)}<small>/${Math.round(w.t_min)}</small>` : '')) +
      row('気圧', (w) => (w.p_mean != null ? String(Math.round(w.p_mean)) : '')) +
      row('前日比', (w) => (w.p_diff != null ? signed(Math.round(w.p_diff), 0).replace('±', '') : '')) +
      row('下がった幅', (w) => (w.p_drop != null ? String(Math.round(w.p_drop)) : ''));
  }
  let listPage = 0;        // 0 = きょうまでの 7 日、1 = その前の 7 日 …
  let listLoading = false, listFailed = false;
  function viewList() {
    if (listFailed) return `<div class="card center"><p class="muted" style="margin-bottom:10px">一覧を読み込めませんでした。</p><button class="btn outline" data-act="list-retry">もう一度読み込む</button></div>`;
    if (!listData) { loadList(); return `<div class="card center muted">読み込んでいます…</div>`; }
    const s = listData.settings || {};
    const sd = startDate(s);
    const end = addDays(listData.to, -7 * listPage);
    let start = addDays(end, -6);
    if (sd && start < sd) start = sd;
    if (start < listData.from) { loadList(addDays(start, -21)); return `<div class="card center muted">読み込んでいます…</div>`; } // 前の週の分を読み足す
    const today = logicalToday();
    const days = [];
    for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
    const obsBy = {}, hBy = {}, memoBy = {};
    listData.obs.forEach((o) => { obsBy[o.date] = o; });
    listData.health.forEach((h) => { hBy[h.date] = h; });
    listData.memos.forEach((m) => { (memoBy[m.date] = memoBy[m.date] || []).push(m); });
    const slBy = listData.sleep_times || {};
    const td = (d, inner, cls) => `<td class="${cls || ''}${d === today ? ' today' : ''}" data-act="goto-date" data-date="${d}">${inner}</td>`;
    const miss = '<span class="miss">・</span>';
    const head = `<tr><th class="lbl"></th>${days.map((d, i) => {
      const [, m, dd] = d.split('-').map(Number); const w = dowOf(d);
      return `<th class="${w === 0 ? 'sun' : w === 6 ? 'sat' : ''}${d === today ? ' today' : ''}" data-act="goto-date" data-date="${d}">${i === 0 || dd === 1 ? `${m}/${dd}` : dd}<small>${DOW[w]}</small></th>`;
    }).join('')}</tr>`;
    const count = `<tr class="count"><td class="lbl">記録した数</td>${days.map((d) => {
      const n = coreCount(obsBy[d], slBy[d]);
      return td(d, n ? `${n}<small>/${CORE.length}</small>` : miss, n === CORE.length ? 'full' : n ? 'part' : '');
    }).join('')}</tr>`;
    const body = cardOrder(s).map((k) => {
      const name = LIST_NAMES[k] || (CARD_DEFS.find((c) => c[0] === k) || [k, k])[1];
      const val = (fn, d) => fn(obsBy[d] || {}, hBy[d], (memoBy[d] || []).length, slBy[d]);
      let rows = (LIST_ROWS[k] || []).filter(([, fn, , auto]) => !auto || days.some((d) => val(fn, d))).map(([label, fn, core]) => `<tr><td class="lbl">${label}</td>${days.map((d) => {
        const v = val(fn, d);
        // { auto } = 入れていないので iPhone の睡眠の時刻(灰色)
        return td(d, v && typeof v === 'object' ? `<span class="auto" title="iPhone の睡眠">${esc(v.auto)}</span>` : v ? esc(v) : core ? miss : '');
      }).join('')}</tr>`).join('');
      const nk = NOTE_OF[k];
      if (nk && days.some((d) => obsBy[d] && obsBy[d][nk])) rows += `<tr><td class="lbl">備考</td>${days.map((d) => td(d, obsBy[d] && obsBy[d][nk] ? '✎' : '')).join('')}</tr>`;
      return `<tr class="cat"><th colspan="${days.length + 1}">${esc(name)}</th></tr>${rows}`;
    }).join('') + weatherRows(days, td);
    const nav = `<div class="row date-nav"><button class="btn outline nav-btn" data-act="list-page" data-d="1" aria-label="前の7日" ${sd && start <= sd ? 'disabled' : ''}>◀</button>
      <div class="spacer center"><b>${jpShort(start)}〜${jpShort(end)}</b></div>
      <button class="btn outline nav-btn" data-act="list-page" data-d="-1" aria-label="次の7日" ${listPage === 0 ? 'disabled' : ''}>▶</button></div>`;
    const legend = `<details class="legend"><summary>記号の見かた</summary><ul>
      <li>・ まだ記録していない(毎日つける項目) / ✎ 書いた日 / 記録した数 = 毎日つける${CORE.length}項目のうち記録した数</li>
      <li>起き上がり・ふらつき: ○ スムーズ・なし △ ゆっくり・少し × つらそう・目立つ</li>
      <li>横になった: ○ ほとんどなし 少 2〜3時間 半 半日くらい 全 ほぼ一日 / 外出: 外 外出できた 近 近所だけ 無 なし</li>
      <li>仕事など: 出 会社出勤 残 出勤+残業 習 習い事 バ バレエ</li>
      <li>食事: 多 よく食べた 普 ふつう 半 半分くらい 少 少し × ほぼ食べず / 間食: ● 寝る前の間食</li>
      <li>寝るまで: ○ おだやか △ 少しつらそう × つらそう / お風呂: 湯 湯ぶね シ シャワー – 入らなかった / 布団に入った時刻(深夜 0〜3 時台はその日の夜) / 寝つき: ○ すぐ眠れた △ 少し時間がかかった × なかなか眠れなかった</li>
      <li>灰色の時刻 = 入れていない日の、iPhone の睡眠の時刻(起きた時刻 = 目が覚めた時刻、布団に入った = 眠り始めた時刻)。灰色の起きた時刻も「記録した数」に数えます</li>
      <li>見た目: 不随意運動 1〜5 / ことば: 痛 痛み ぐ ぐるぐる 他 その他</li>
      <li>楽な時間: 朝 昼 夕 夜 / 薬: ● 全部・飲んだ ◐ ${esc(medName(s))}以外 ◔ 一部 ○ 飲まなかった / 早く休んだ: ● 寝る前の薬が18時より前で「合っている」を押した日(その夜の眠りは次の日の列)</li>
      <li>歩く速さ km/時 / 歩幅 cm / 左右差(歩行非対称性)・両足支持(両足で支えている時間)・歩行安定性 % / 安静時心拍 回/分 / 心拍変動 ms(歩き方は iPhone をポケットに入れて歩いた日だけ)</li>
      <li>天気・気圧: 気温 = 最高/最低 ℃ / 気圧 = 1日の平均 hPa / 前日比 = 前の日の平均との差 / 下がった幅 = その日の中でいちばん下がった幅 hPa(0時〜24時の1日)</li></ul></details>`;
    const notes = days.slice().reverse().map((d) => {
      const o = obsBy[d] || {};
      const items = NOTE_LABELS.filter(([k]) => o[k]).map(([k, l]) => `<li><b>${l}</b>${esc(o[k])}</li>`)
        .concat((memoBy[d] || []).map((m) => `<li><b>メモ ${hhmm(m.ts)}</b>${esc(m.text)}</li>`));
      return items.length ? `<div class="day-notes" data-act="goto-date" data-date="${d}"><div class="d">${jpDate(d)}</div><ul>${items.join('')}</ul></div>` : '';
    }).join('');
    let from = s.last_appointment || addDays(listData.to, -41);
    if (sd && from < sd) from = sd;
    const table = days.length ? `<table class="grid"><colgroup><col class="lbl">${days.map(() => '<col>').join('')}</colgroup>
        <thead>${head}</thead><tbody>${count}${body}</tbody></table>` : `<p class="muted small">記録の開始日(${jpShort(sd)})から表示します。</p>`;
    return `<section class="card grid-card"><h2>記録の一覧 <span class="link">日付を押すと開きます</span></h2>${nav}${table}${legend}</section>
      ${notes ? `<section class="card"><h2>この7日の備考・メモ</h2>${notes}</section>` : ''}
      <section class="card"><h2>医師に見せるレポート</h2>
        <p class="small" style="margin-bottom:8px">PC のブラウザで開き、印刷 →「PDF に保存」。期間はレポート画面でも変えられます。</p>
        <a class="btn primary" href="report.html?from=${from}&to=${listData.to}" target="_blank" rel="noopener">レポートを開く(${jpShort(from)}〜${jpShort(listData.to)})</a></section>
      ${striveCardHTML()}
      ${exportCardHTML(s)}`;
  }

  /* ---- 一覧: StrivePD のスクショ(週ごとの枚数。押すとその週の画像) ---- */
  const weekLabel = (w) => `${jpShort(w)}〜${jpShort(addDays(w, 6))}`;
  function striveCardHTML() {
    if (!striveData) { loadStrive(); return ''; }
    const st = striveData.strive || {};
    const items = striveData.items || [];
    if (!st.on && !items.length) return '';
    const by = {};
    items.forEach((m) => { (by[m.week] = by[m.week] || []).push(m); });
    if (st.on && !by[st.week]) by[st.week] = [];
    const weeks = Object.keys(by).sort().reverse();
    const rows = weeks.map((w) => {
      const n = by[w].length;
      const cur = w === st.week;
      const mark = n >= st.full ? '<span class="chip ok">そろった ✓</span>' : cur && st.done ? '<span class="chip ok">送り終わり ✓</span>' : cur ? '<span class="chip">まだ</span>' : '';
      return `<li><button class="strive-week" data-act="strive-week" data-week="${w}"><span class="spacer"><b>${weekLabel(w)}</b>${cur ? ' <small class="muted">今回の分</small>' : ''}</span><span>${n}枚</span>${mark}<span class="muted" aria-hidden="true">›</span></button></li>`;
    }).join('');
    let ask = '';
    if (st.on && !st.done) {
      ask = st.show ? `<p class="help">きょうは本人の画面に案内が出ています(${weekLabel(st.week)}の分)。</p>`
        : `<button class="btn outline" data-act="strive-ask">きょう本人の画面に案内を出す</button>
          <p class="help">日曜日に送れなかった時に。${weekLabel(st.week)}の分の案内を、きょうだけ本人の画面と記録の画面に出します。</p>`;
    }
    // 今回の分に、記録する人の iPhone から足す(送り終わったあとでも。足した分ではお礼は送らない)
    const add = striveProg ? `<p class="strive-prog" role="status">送っています… ${striveProg.i} / ${striveProg.n}枚</p>`
      : shotPicker(`今回の分(${weekLabel(st.week)})に、この iPhone から足す`, 'outline');
    return `<section class="card"><h2>StrivePD のスクショ <span class="link">${st.on ? '毎週日曜日に案内' : '案内は止めています'}</span></h2>
      ${rows ? `<ul class="strive-weeks">${rows}</ul>` : ''}
      ${ask}
      <div class="btn-col" style="margin:6px 0 4px">${add}</div>
      <p class="help">週(月〜日)を押すと、その週の画像が見られます。分析用に保存するのは、下の「分析用にデータを保存」から。スクショは家族のスプレッドシートに入るので、保存したあとは古い週を消すと軽くなります。</p></section>`;
  }
  // その週の画像(小さく並べる。押すと大きく)
  function striveWeekSheetHTML() {
    const w = sheet.week;
    const items = ((striveData && striveData.items) || []).filter((m) => m.week === w);
    items.forEach((m) => loadShot(m.id));
    const cells = items.map((m, i) => `<button class="shot-cell" data-act="shot-open" data-id="${esc(m.id)}" aria-label="${i + 1}枚目を大きく見る">${shot.url[m.id] ? `<img src="${esc(shot.url[m.id])}" alt="">` : `<span class="muted small">${shot.failed[m.id] ? '読めません' : '読み込み中…'}</span>`}<small>${i + 1}</small></button>`).join('');
    return wrapSheet(`<h3>StrivePD ${weekLabel(w)} <span class="chip">${items.length}枚</span></h3>
      ${items.length ? `<div class="shot-grid">${cells}</div>` : '<p class="muted small">まだ届いていません。</p>'}
      <div class="actions">${items.length ? '<button class="btn danger" data-act="strive-week-del">この週の画像を全部消す</button>' : ''}<button class="btn ghost" data-act="sheet-close">閉じる</button></div>
      <p class="help">押すと大きく見られます。消すのは、分析用に保存したあとに。</p>`);
  }
  function shotSheetHTML() {
    const m = ((striveData && striveData.items) || []).find((x) => x.id === sheet.id);
    if (!m) { sheet = { type: 'striveweek', week: sheet.week }; return striveWeekSheetHTML(); }
    loadShot(m.id);
    const who = m.by === 'patient' ? '本人' : m.by === 'supporter' ? '記録する人' : '';
    return wrapSheet(`<div class="shot-big">${shot.url[m.id] ? `<img src="${esc(shot.url[m.id])}" alt="StrivePD のスクショ">` : `<p class="muted center">${shot.failed[m.id] ? '画像を読めませんでした' : '読み込んでいます…'}</p>`}</div>
      <p class="small">${weekLabel(m.week)}の分 ・ ${esc(fmtStamp(m.created_at, true))} に${who ? esc(who) + 'が' : ''}送信${m.w && m.h ? ` ・ ${m.w}×${m.h}` : ''}</p>
      <div class="actions two"><button class="btn outline" data-act="strive-week" data-week="${esc(m.week)}">‹ この週に戻る</button><button class="btn danger" data-act="shot-del">この画像を消す</button></div>`);
  }

  /* ---- 分析用にデータを保存(期間を選んでファイルに書き出す) ----
   * JSON = 分析用の一式(コードの意味つき、時刻ごとの値も入る)。CSV = Excel で見る日ごとの表 */
  let exportRange = null; // { from, to }
  function exportCardHTML(s) {
    const today = logicalToday();
    const sd = startDate(s) || addDays(today, -41);
    if (!exportRange) exportRange = { from: sd, to: today };
    return `<section class="card"><h2>分析用にデータを保存</h2>
      <p class="small" style="margin-bottom:8px">選んだ期間の記録(観察・薬・メモ・眠り・歩数・歩き方と心拍の時刻ごとの値・天気と気圧)をファイルに書き出します。パソコンで開いて押すと「ダウンロード」フォルダに入ります。</p>
      <div class="row"><div style="flex:1"><label class="field"><span>開始日</span><input type="date" data-export="from" value="${esc(exportRange.from)}" min="${sd}" max="${today}"></label></div>
        <div style="flex:1"><label class="field"><span>終了日</span><input type="date" data-export="to" value="${esc(exportRange.to)}" min="${sd}" max="${today}"></label></div></div>
      <div class="btn-col"><button class="btn" data-act="export" data-fmt="json">データ一式を保存(分析用・JSON)</button>
        <button class="btn outline" data-act="export" data-fmt="csv">日ごとの表を保存(Excel 用・CSV)</button>
        ${striveData && (striveData.items || []).length ? '<button class="btn outline" data-act="export" data-fmt="strive">StrivePD のスクショを保存(分析用・JSON)</button>' : ''}</div>
      <p class="help">健康の記録が入ったファイルです。家族の外には渡さないでください。${striveData && (striveData.items || []).length ? 'StrivePD のスクショは、期間に重なる週(月〜日)の分を 1 つのファイルにまとめます。' : ''}</p></section>`;
  }
  // StrivePD のスクショを 1 つのファイルに(画像は data URL のまま。分析の時に画像に戻す)
  async function exportStrive() {
    const r = exportRange || {};
    if (!r.from || !r.to || r.from > r.to) { toast('期間を選び直してください'); return; }
    toast('StrivePD のスクショを集めています…');
    let list;
    try { list = await call({ action: 'striveList' }); } catch (e) { toast('通信できませんでした'); return; }
    if (!list.ok) { toast(list.message || '書き出せませんでした'); return; }
    striveData = list;
    const items = list.items.filter((m) => m.week <= r.to && addDays(m.week, 6) >= r.from);
    if (!items.length) { toast('この期間の StrivePD のスクショはありません'); return; }
    const out = [];
    for (let i = 0; i < items.length; i++) {
      toast(`StrivePD のスクショを読み込んでいます… ${i + 1} / ${items.length}枚`);
      const m = items[i];
      try { out.push({ week: m.week, week_end: addDays(m.week, 6), no: i + 1, created_at: m.created_at, by: m.by, name: m.name, w: m.w, h: m.h, data: await blobToDataUrl(await shotBlob(m.id)) }); }
      catch (e) { toast('読み込めない画像がありました。通信を確かめて、もう一度お試しください'); return; }
    }
    downloadText(`kuma-strive_${r.from}_${r.to}.json`, JSON.stringify({ format: 'kuma-strive-1', exported_at: new Date().toISOString(), from: r.from, to: r.to,
      note: 'StrivePD の「週」と「日」の画面のスクショ。week = その週の月曜日(月〜日)。data は JPEG の data URL', items: out }), 'application/json');
    toast(`${out.length}枚を保存しました`);
  }
  async function exportData(fmt) {
    const r = exportRange || {};
    if (!r.from || !r.to || r.from > r.to) { toast('期間を選び直してください'); return; }
    toast('書き出しています…');
    let data;
    try { data = await call({ action: 'report', from: r.from, to: r.to }); } catch (e) { toast('通信できませんでした'); return; }
    if (!data.ok) { toast(data.message || '書き出せませんでした'); return; }
    const name = `kuma-data_${data.from}_${data.to}`;
    if (fmt === 'csv') downloadText(name + '.csv', '\ufeff' + exportCsv(data), 'text/csv;charset=utf-8'); // 先頭の印で Excel が文字化けしない
    else downloadText(name + '.json', JSON.stringify(exportJson(data), null, 1), 'application/json');
    toast(`保存しました(${jpShort(data.from)}〜${jpShort(data.to)})`);
  }
  function downloadText(filename, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  // 数字のコードの意味(あとで読む人や分析のため、ファイルに一緒に入れる)
  function exportCodes(s) {
    const codes = {};
    Object.keys(SCALES).forEach((k) => { codes[k] = { label: SCALES[k].label, values: Object.fromEntries(SCALES[k].opts.map(([v, l]) => [v, l])) }; });
    codes.night_snack = { label: '寝る前の間食', values: { 1: 'あり' } };
    codes.bed_time = { label: '布団に入った時刻(記録する人が見た時刻。深夜 0〜3 時台は、その日の夜の続き)。Apple Watch の寝た時刻は health の bed_start' };
    codes.sleep_times = { label: '起きてきた時刻・布団に入った時刻を入れていない日に、代わりに使う iPhone の睡眠の時刻(画面・レポート・CSV で使う)。wake = その日の朝に目が覚めた時刻(その日の health の bed_end)、bed = その日の夜に眠り始めた時刻(次の日の health の bed_start)。observe には入れていない' };
    codes.sleep_onset.label = '寝つき(記録する人が見ていて分かった日だけ)';
    codes.evening.label = '寝るまでのようす(夕食のあとから布団に入るまで。記録する人が見た印象)';
    codes.early_bed = { label: '早く休んだ日(寝る前の薬が18時より前で、記録した人が「合っている」と確かめた日)。夕方からの眠りは次の日の health に1晩として入る', values: { 1: 'はい' } };
    codes.activity = { label: '仕事・習い事(カンマ区切り)', values: Object.fromEntries(ACTIVITY) };
    codes.easy_times = { label: '楽そうだった時間帯', values: Object.fromEntries(EASY) };
    codes.complaint = { label: '本人が自分から口にしたこと(こちらからはたずねていない)', values: Object.fromEntries(COMPLAINT) };
    medRows(s).forEach(([f, label, states]) => { codes[f] = { label: label + '(「状態 時刻」)', values: Object.fromEntries(states.concat([['no', '飲まなかった']])) }; });
    codes.prn_times = { label: '他の薬(頓服など)を飲んだ記録。1回分は「時刻」か「時刻 薬の名前」で、カンマ区切り。prn はその回数' };
    codes.health = {
      sleep_min: '眠った時間(分)', awakenings: '5分以上目が覚めた回数', deep_min: '深い眠り(分)', rem_min: 'レム睡眠(分)', inbed_min: 'ベッドにいた時間(分)',
      nap_min: '昼寝など(分)', bed_start: '寝た時刻', bed_end: '起きた時刻', steps: '歩数', walking_speed: '歩く速さ(km/時)', step_length: '歩幅(cm)',
      walk_asym: '歩行非対称性(%)', double_support: '両足支持時間(%)', steadiness: '歩行安定性(%)', resting_hr: '安静時心拍数(回/分)', hrv: '心拍変動(ms)',
      metric_series: '1日の中の時刻ごとの値 { 項目: [[時刻, 値], ...] }(単位は上と同じ)'
    };
    codes.weather = {
      note: '住まいの地域の気象データ(Open-Meteo)。日付は 0 時〜24 時の1日(観察の日付は朝4時区切り)',
      weather: 'その日のうちで、いちばん崩れた時の天気(wcode = WMO の番号)', t_max: '最高気温(℃)', t_min: '最低気温(℃)', t_mean: '平均気温(℃)',
      humidity: '平均湿度(%)', precip: '降水量(mm)', p_mean: '海面気圧の1日の平均(hPa)', p_min: '気圧の最低(hPa)', p_max: '気圧の最高(hPa)',
      p_drop: 'その日の中で、それまでの最高から下がったいちばん大きな幅(hPa)', p_diff: '前の日の平均気圧との差(hPa)',
      hourly: '1時間ごとの値 { p: 気圧 hPa [0時, 1時, …], t: 気温 ℃ [...] }', final: '1 = その日の分がそろっている(0 = 取った時点では途中で、予報を含む)'
    };
    return codes;
  }
  function exportJson(data) {
    const s = data.settings || {};
    return {
      format: 'kuma-export-1', exported_at: new Date().toISOString(), from: data.from, to: data.to,
      settings: Object.fromEntries(['start_date', 'med2_label', 'last_appointment', 'next_appointment'].map((k) => [k, s[k] || ''])),
      codes: exportCodes(s),
      observe: data.obs, health: data.health, sleep_times: data.sleep_times || {}, memos: (data.memos || []).map((m) => ({ date: m.date, ts: m.ts, text: m.text })),
      weather: (data.weather || []).map((w) => ({ date: w.date, weather: wxLabel(w.wcode)[1], wcode: w.wcode, t_max: w.t_max, t_min: w.t_min, t_mean: w.t_mean,
        humidity: w.humidity, precip: w.precip, p_mean: w.p_mean, p_min: w.p_min, p_max: w.p_max, p_drop: w.p_drop, p_diff: w.p_diff, hourly: w.hourly, final: w.final }))
    };
  }
  function exportCsv(data) {
    const s = data.settings || {};
    const name = (k, v) => (v == null || !SCALES[k] ? '' : ((SCALES[k].opts.find(([x]) => x === v) || [])[1] || String(v)));
    const setNames = (v, list) => list.filter(([k]) => String(v || '').split(',').includes(k)).map(([, l]) => l).join('・');
    const medState = { all: `${medName(s)}全部`, part: '一部', noc: `${medName(s)}以外`, yes: '飲んだ', no: '飲まなかった' };
    const obsBy = {}, hBy = {}, memoBy = {}, wBy = {};
    data.obs.forEach((o) => { obsBy[o.date] = o; });
    data.health.forEach((h) => { hBy[h.date] = h; });
    (data.memos || []).forEach((m) => { (memoBy[m.date] = memoBy[m.date] || []).push(`${hhmm(m.ts)} ${m.text}`); });
    (data.weather || []).forEach((w) => { wBy[w.date] = w; });
    const wx = (k) => (d) => (wBy[d] ? wBy[d][k] : '');
    const slt = (d, k) => ((data.sleep_times || {})[d] || {})[k] || ''; // 入れていない日に使う iPhone の睡眠の時刻
    const cols = [
      ['日付', (d) => d], ['曜日', (d) => DOW[dowOf(d)]],
      ['起きてきた時刻', (d, o) => o.wake_time || slt(d, 'wake')], ['起きてきた時刻の出どころ', (d, o) => (o.wake_time ? '記録' : slt(d, 'wake') ? 'iPhone の睡眠' : '')], ['起き上がり', (d, o) => name('getup', o.getup)], ['ふらつき', (d, o) => name('gait', o.gait)],
      ['横になっていた時間', (d, o) => name('lying', o.lying)], ['外出', (d, o) => name('outing', o.outing)], ['仕事・習い事', (d, o) => setNames(o.activity, ACTIVITY)],
      ['食事の量', (d, o) => name('meal', o.meal)], ['寝る前の間食', (d, o) => (o.night_snack === 1 ? 'あり' : '')],
      ['寝るまでのようす', (d, o) => name('evening', o.evening)], ['お風呂', (d, o) => name('bath', o.bath)],
      ['布団に入った時刻', (d, o) => o.bed_time || slt(d, 'bed')], ['布団に入った時刻の出どころ', (d, o) => (o.bed_time ? '記録' : slt(d, 'bed') ? 'iPhone の睡眠' : '')],
      ['寝つき', (d, o) => name('sleep_onset', o.sleep_onset)],
      ['見た目(1-5)', (d, o) => (o.movement != null ? o.movement : '')], ['本人が口にしたこと', (d, o) => setNames(o.complaint, COMPLAINT)],
      ['楽そうだった時間帯', (d, o) => setNames(o.easy_times, EASY)],
      ['朝の薬', (d, o) => medState[parseMed(o.med_morning, true).st] || ''], ['朝の薬の時刻', (d, o) => parseMed(o.med_morning, true).t],
      ['寝る前の薬', (d, o) => medState[parseMed(o.med_night).st] || ''], ['寝る前の薬の時刻', (d, o) => parseMed(o.med_night).t],
      ['早く休んだ', (d, o) => (o.early_bed === 1 ? 'はい' : '')],
      ['他の薬(時刻と名前)', (d, o) => prnList(o).join(' / ')], ['アルコール', (d, o) => name('alcohol', o.alcohol)],
      ['睡眠(分)', (d, o, h) => h.sleep_min], ['目覚め(回)', (d, o, h) => h.awakenings], ['深い眠り(分)', (d, o, h) => h.deep_min], ['昼寝など(分)', (d, o, h) => h.nap_min],
      ['寝た時刻', (d, o, h) => h.bed_start], ['起きた時刻(眠り)', (d, o, h) => h.bed_end], ['歩数', (d, o, h) => h.steps],
      ['歩く速さ(km/時)', (d, o, h) => h.walking_speed], ['歩幅(cm)', (d, o, h) => h.step_length], ['歩行非対称性(%)', (d, o, h) => h.walk_asym],
      ['両足支持時間(%)', (d, o, h) => h.double_support], ['歩行安定性(%)', (d, o, h) => h.steadiness], ['安静時心拍数', (d, o, h) => h.resting_hr], ['心拍変動(ms)', (d, o, h) => h.hrv],
      ['備考(朝)', (d, o) => o.note_morning], ['備考(日中)', (d, o) => o.note_day], ['備考(夜)', (d, o) => o.note_night], ['備考(見た目・ことば)', (d, o) => o.complaint_note],
      ['できたこと', (d, o) => o.good_note], ['備考(薬)', (d, o) => o.note_meds], ['備考(アルコール)', (d, o) => o.note_alcohol], ['気になったこと(メモ)', (d) => (memoBy[d] || []).join(' / ')],
      ['天気', (d) => (wBy[d] ? wxLabel(wBy[d].wcode)[1] : '')], ['最高気温(℃)', wx('t_max')], ['最低気温(℃)', wx('t_min')], ['降水量(mm)', wx('precip')],
      ['気圧(1日の平均 hPa)', wx('p_mean')], ['気圧の前日比(hPa)', wx('p_diff')], ['気圧のその日の中で下がった幅(hPa)', wx('p_drop')]
    ];
    const cell = (v) => { const t = v == null ? '' : String(v); return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
    const lines = [cols.map(([h]) => cell(h)).join(',')];
    for (let d = data.from; d <= data.to; d = addDays(d, 1)) lines.push(cols.map(([, f]) => cell(f(d, obsBy[d] || {}, hBy[d] || {}))).join(','));
    return lines.join('\r\n') + '\r\n';
  }
  async function loadList(from) {
    if (listLoading) return;
    listLoading = true;
    const to = logicalToday();
    try {
      const data = await call({ action: 'report', from: from || addDays(to, -27), to });
      if (data.ok) listData = data;
      else if (data.error === 'unauthorized') { listLoading = false; logout('ログインし直してください'); return; }
      else listFailed = true;
    } catch (e) { listFailed = true; }
    listLoading = false;
    if (tab === 'list') render();
  }

  /* ---- カレンダー(記録の画面で日付を押すと出る。印 = その日の記録の状況) ---- */
  const calMarks = {}; // 'YYYY-MM' → { 日付: 'full' | 'part' }
  function openCal() { sheet = { type: 'cal', month: curDate.slice(0, 7) }; renderOverlay(); loadCalMonth(sheet.month); }
  async function loadCalMonth(ym) {
    const today = logicalToday();
    const from = ym + '-01';
    if (from > today) return;
    const [y, m] = ym.split('-').map(Number);
    let to = `${ym}-${pad(new Date(y, m, 0).getDate())}`;
    if (to > today) to = today;
    try {
      const data = await call({ action: 'report', from, to });
      if (!data.ok) return;
      const marks = {};
      data.obs.forEach((o) => { if (anyObs(o)) marks[o.date] = coreCount(o, (data.sleep_times || {})[o.date]) === CORE.length ? 'full' : 'part'; });
      data.memos.forEach((mm) => { if (!marks[mm.date]) marks[mm.date] = 'part'; });
      calMarks[ym] = marks;
      if (sheet && sheet.type === 'cal' && sheet.month === ym) renderOverlay();
    } catch (e) { /* 印なしのまま出す */ }
  }
  function calSheetHTML() {
    const ym = sheet.month;
    const [y, m] = ym.split('-').map(Number);
    const today = logicalToday();
    const sd = startDate();
    const marks = calMarks[ym] || {};
    const first = new Date(y, m - 1, 1).getDay();
    const last = new Date(y, m, 0).getDate();
    let cells = DOW.map((w, i) => `<span class="cal-w${i === 0 ? ' sun' : i === 6 ? ' sat' : ''}">${w}</span>`).join('');
    for (let i = 0; i < first; i++) cells += '<span></span>';
    for (let d = 1; d <= last; d++) {
      const ds = `${ym}-${pad(d)}`;
      const w = (first + d - 1) % 7;
      const off = ds > today || (sd && ds < sd);
      const cls = [ds === curDate ? 'sel' : '', ds === today ? 'today' : '', w === 0 ? 'sun' : w === 6 ? 'sat' : ''].join(' ');
      cells += `<button class="cal-d ${cls}" data-act="cal-pick" data-date="${ds}" ${off ? 'disabled' : ''} aria-label="${m}月${d}日">${d}${marks[ds] ? `<i class="${marks[ds]}"></i>` : ''}</button>`;
    }
    const canPrev = !sd || addDays(ym + '-01', -1) >= sd;
    const nd = new Date(y, m, 1);
    const canNext = `${nd.getFullYear()}-${pad(nd.getMonth() + 1)}-01` <= today;
    return wrapSheet(`<div class="cal-head"><button class="icon-btn" data-act="cal-month" data-d="-1" aria-label="前の月" ${canPrev ? '' : 'disabled'}>◀</button>
        <b>${y}年${m}月</b><button class="icon-btn" data-act="cal-month" data-d="1" aria-label="次の月" ${canNext ? '' : 'disabled'}>▶</button></div>
      <div class="cal-grid">${cells}</div>
      <p class="help cal-legend"><i class="full"></i>毎日の${CORE.length}項目を全部記録 <i class="part"></i>一部だけ記録</p>
      <div class="actions two"><button class="btn outline" data-act="cal-pick" data-date="${today}">きょうへ</button><button class="btn ghost" data-act="sheet-close">閉じる</button></div>`);
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
        ${uploadButton('lib', '＋ 画像を登録する', true)}
        <p class="help">iPhone の写真やファイルから選べます。何枚かまとめて選ぶと、1枚ずつ順番に登録します(1枚に数秒かかります)。小さく縮めて、家族のスプレッドシートに保存します(GitHub には上がらないので、外からは見えません)。正方形で背景が透明の PNG だと、きれいに出ます。</p>`);
  }
  // multi: 何枚でも一度に選べる(「登録した画像」だけ。場面やひとことに使う時は1枚)
  const uploadButton = (target, label, multi) => `<label class="btn outline upload-btn">${label}<input type="file" accept="image/*"${multi ? ' multiple' : ''} data-upload="${esc(target)}"></label>`;

  /* ---- 設定 ---- */
  function viewSettings(data) {
    const s = (data && data.settings) || settingsNow();
    const f = (name, label, type, help, ph) => `<label class="field"><span>${label}</span><input type="${type || 'text'}" name="${name}" value="${esc(s[name] || '')}" ${ph ? `placeholder="${esc(ph)}"` : ''}>${help ? `<div class="help">${help}</div>` : ''}</label>`;
    return `<form id="settings-form" class="card">
      <h2>設定</h2>
      ${f('app_title', 'アプリのタイトル', 'text', 'この画面(記録する人)のいちばん上に出ます。本人の画面には出ません。空欄なら「くまの記録」', '例: くまの記録')}
      ${f('patient_name', '本人の名前', 'text', 'レポートに印字します(空欄でも可)。ログイン画面の本人のボタンにも出ます')}
      ${f('supporter_name', '記録する人の名前', 'text', '本人の同意の画面に「届く先: ○○さん」と出ます。ログイン画面の記録する人のボタンにも出ます')}
      ${f('start_date', '記録の開始日', 'date', 'この日より前は、記録・一覧・レポートに出ません')}
      ${f('med2_label', '朝の薬で分けて書く薬の名前', 'text', '朝の薬のボタン(「○○全部飲んだ」「○○一部飲んだ」「○○以外飲んだ」)の○○に出ます。名前はスプレッドシートにだけ保存され、GitHub には出ません', '例: お薬の名前')}
      <div class="row"><div style="flex:1">${f('last_appointment', '前回の診察日', 'date')}</div><div style="flex:1">${f('next_appointment', '次の診察日', 'date')}</div></div>
      <label class="field"><span>先生に伝えたいこと</span><textarea name="report_note" maxlength="2000" placeholder="例: 本人に症状を尋ねると痛みが強くなるため、家族の観察で記録しています。">${esc(s.report_note || '')}</textarea><div class="help">レポートのいちばん上に印刷されます。</div></label>
      <button type="submit" class="btn primary" style="margin-top:4px">設定を保存</button>
    </form>
    ${orderCardHTML(s)}
    ${weatherCardHTML(s)}
    ${striveSettingsHTML(s)}
    ${healthAdminHTML(s)}
    <section class="card"><h2>この端末</h2><p class="small">ログイン中: ${esc(cfg.name || '')}(記録する人)</p>
      <button class="btn ghost" data-act="logout" style="margin-top:8px">ログアウト</button></section>`;
  }

  // 天気と気圧: 調べる場所(数字か市の名前)
  function weatherCardHTML(s) {
    const on = !!s.weather_place;
    return `<section class="card"><h2>天気と気圧 <span class="link">自動</span></h2>
      <p class="small" style="margin-bottom:8px">記録する人のアプリを開いた時に、その日の天気・気温・気圧(1時間ごと)を天気のサービス(Open-Meteo。登録なし・無料)から取り、記録と一緒に残します。気圧の変化と体調の関係を見るためです。記録の画面のいちばん上、一覧、レポート、分析用のファイルに出ます。</p>
      <form id="weather-form">
        <label class="field"><span>天気を調べる場所</span><input type="text" name="weather_place" value="${esc(s.weather_place || '')}" placeholder="例: 35.68,139.77 または 横浜市" autocomplete="off" enterkeyhint="done">
          <div class="help">「緯度,経度」の数字か、市の名前。区の名前では探せないので、区で決めたい時は数字で入れます(地図アプリで場所を長押しすると出ます)。天気のサービスに送るのは、この位置(約1kmの粗さ)だけです。空にして保存すると止まります。</div></label>
        <button type="submit" class="btn">場所を保存</button>
      </form>
      <p class="help">${on ? `いまの場所: ${esc(s.weather_place)}。記録の開始日の前の日から、きょうまでの分が入ります(3か月より前の分は取れません)。` : 'いまは取り込んでいません。'}</p></section>`;
  }

  // StrivePD のスクショ: 日曜日の案内と、送り終えた時のお礼のスタンプ
  function striveSettingsHTML(s) {
    const on = s.strive_on === '1';
    const t = thanksNow(s);
    const list = reactionsNow();
    const cur = t ? list.find((r) => r.id === t.type) || { id: t.type, label: t.label, image: t.image } : null;
    const cells = [`<button class="cell ${!t ? 'sel' : ''}" data-act="strive-thanks" data-type="" aria-pressed="${!t}"><span class="remoji">ー</span><span>なし</span></button>`]
      .concat(list.map((r) => `<button class="cell ${t && t.type === r.id ? 'sel' : ''}" data-act="strive-thanks" data-type="${esc(r.id)}" aria-pressed="${!!(t && t.type === r.id)}">${reactionVisual(r)}<span>${esc(r.label)}</span></button>`)).join('');
    const from = String(s.supporter_name || '').trim() || cfg.name || '家族';
    return `<section class="card"><h2>StrivePD のスクショ</h2>
      <p class="small" style="margin-bottom:8px">毎週日曜日に、本人の画面(くまの部屋)とこの記録の画面に「StrivePD の『週』と『日』の画面のスクショを送ってね」という案内を出します。本人は一度に${SHOT_BATCH}枚まで選べます。本人が送り終わると(8枚そろうか「これでおしまい」を押すと)案内は消え、下で選んだお礼のスタンプが本人に届きます。届いた画像は「一覧」タブで見られて、分析用に保存できます。</p>
      <label class="field"><span>日曜日の案内</span>
        <select data-setting="strive_on"><option value="1" ${on ? 'selected' : ''}>出す</option><option value="0" ${on ? '' : 'selected'}>出さない</option></select></label>
      <div class="field"><span>お礼のスタンプ</span></div>
      <div class="img-grid">${cells}</div>
      <label class="field" style="margin-top:12px"><span>スタンプに添えることば(任意)</span>
        <input type="text" id="strive-thanks-msg" maxlength="200" value="${esc(t ? t.message || '' : '')}" placeholder="例: ありがとう！たすかるよ" ${t ? '' : 'disabled'} enterkeyhint="done" autocomplete="off"></label>
      ${cur ? `<div class="thanks-preview"><span class="muted small">本人の画面では:</span><div class="bubble reaction"><span class="from">${esc(from)}さんから</span>${reactionVisual(cur, 'in-bubble')} ${esc(cur.label)}${t.message ? '<br>' + esc(t.message) : ''}</div></div>` : ''}
      <p class="help">スタンプの絵とことばは「くま」タブの「ひとことの種類」で変えられます。お礼は、ふだんのひとことと同じように本人のふきだしに出ます(本人が送り終えた時だけ。こちらの iPhone から足した時は送りません)。</p></section>`;
  }

  // 記録画面のカテゴリーの並び順(↑↓ で入れ替え、すぐ保存)
  function orderCardHTML(s) {
    const order = cardOrder(s);
    const name = (k) => (CARD_DEFS.find((d) => d[0] === k) || [k, k])[1];
    return `<section class="card"><h2>記録画面の並び順</h2>
      <ol class="order-list">${order.map((k, i) => `<li><span class="spacer">${esc(name(k))}</span>
        <button class="icon-btn" data-act="order" data-k="${k}" data-d="-1" aria-label="${esc(name(k))}を上へ" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="icon-btn" data-act="order" data-k="${k}" data-d="1" aria-label="${esc(name(k))}を下へ" ${i === order.length - 1 ? 'disabled' : ''}>↓</button></li>`).join('')}</ol>
      <button class="btn ghost" data-act="order-reset" style="margin-top:6px">最初の並びに戻す</button></section>`;
  }
  function saveOrder(order) {
    const settings = { card_order: order.join(',') };
    enqueue({ action: 'saveSettings', settings }, (c) => { c.settings = Object.assign({}, c.settings, settings); });
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
          <span class="help">本人がよく開くアプリ(LINE など)を開いた時に、裏で送られるようにします(SHORTCUTS.md の 6)。何度開いても、実際に送るのは下の回数だけです。</span></li>
      </ol>
      <label class="field" style="margin-top:14px"><span>自動で送る回数</span>
        <select data-setting="health_per_day">
          <option value="2" ${s.health_per_day !== '1' ? 'selected' : ''}>1日2回(朝4時〜と夕方4時〜に1回ずつ)</option>
          <option value="1" ${s.health_per_day === '1' ? 'selected' : ''}>1日1回(朝4時を過ぎて最初の1回)</option>
        </select>
        <div class="help">本人の iPhone の設定を変えずに、ここで変えられます。歩数はその日の途中の数で届き、翌日の送信で1日分にそろいます。</div></label>
      ${hl.consent ? '<button class="btn danger" data-act="health-stop" style="margin-top:14px">連携を止める</button>' : ''}
      <p class="help">API の URL: <code style="word-break:break-all">${esc(cfg.apiUrl)}</code></p></section>`;
  }

  /* ========== 下から出るシート ========== */
  const wrapSheet = (inner) => `<div class="sheet-bg" data-act="sheet-bg"><div class="sheet" role="dialog" aria-modal="true">${inner}</div></div>`;

  // メモを書く・直す(sheet.id があれば直す)。時刻は 4 桁の数字
  function memoSheetHTML() {
    return wrapSheet(`<h3>${sheet.id ? '気になったことを直す' : '気になったこと'}</h3>
      <textarea id="memo-text" placeholder="例: 夕方に少しむせた / 立ちくらみで壁に手をついた / 動画を撮った">${esc(sheet.text || '')}</textarea>
      <p class="help">キーボードのマイクで声でも入力できます。</p>
      <label class="field" style="margin-top:10px"><span>時刻(4桁の数字。例: 1320 = 13時20分)</span>${hmInput('id="memo-time" aria-label="メモの時刻(4桁)" style="max-width:140px"', sheet.time)}</label>
      <p class="help" id="memo-time-view">${esc(hmView(sheet.time))}</p>
      <div class="actions"><button class="btn primary" data-act="memo-save">${sheet.id ? 'この内容に直す' : '保存'}</button><button class="btn ghost" data-act="sheet-close">閉じる</button></div>`);
  }
  // メモの日付と時刻から ts を作る。深夜 0〜3 時台は、その日の夜の続き(日付は次の日)
  const memoTs = (date, hm) => `${hm < '04:00' ? addDays(date, 1) : date}T${hm}`;
  const byTs = (a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);
  function openMemo(id) {
    const m = (obsMemos()).find((x) => x.id === id);
    if (!m) return;
    sheet = { type: 'memo', id, date: m.date || curDate, text: m.text, time: hhmm(m.ts), focused: true };
    renderOverlay();
  }
  const obsMemos = () => (cache && cache.memos) || [];

  function keySheetHTML() {
    return wrapSheet(`<h3>連携キー</h3>
      <p class="small">この画面を閉じると二度と表示されません。ショートカットに貼り付けてから閉じてください。</p>
      <label class="field" style="margin-top:12px"><span>連携キー</span><input type="text" id="key-token" value="${esc(sheet.token)}" readonly></label>
      <label class="field"><span>送信先URL</span><input type="text" id="api-url" value="${esc(cfg.apiUrl)}" readonly></label>
      <label class="field"><span>確認用URL(ショートカットの ⓪ に貼る)</span><input type="text" id="need-url" value="${esc(cfg.apiUrl + '?action=need&token=' + sheet.token)}" readonly></label>
      <p class="help">キーはショートカットの ⑨「URLの内容を取得」の <b>token</b> の欄に、確認用URLは ⓪「URLの内容を取得」の URL の欄に貼ります(SHORTCUTS.md の 2)。</p>
      <div class="actions"><button class="btn" data-act="copy" data-target="key-token">キーをコピー</button><button class="btn" data-act="copy" data-target="need-url">確認用URLをコピー</button><button class="btn" data-act="copy" data-target="api-url">送信先URLをコピー</button><button class="btn ghost" data-act="sheet-close">閉じる</button></div>`);
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
        <p class="small" style="margin-bottom:12px">Apple Watch と iPhone が記録している「眠り」「歩いた量と歩き方」「心拍」を、毎日自動で${sup}のメモに届けます。診察のときに先生に見せる資料にもなります。</p>
        <dl class="kv consent">
          <dt>届けるもの</dt><dd>眠った時間、寝た時刻と起きた時刻、途中で目が覚めた回数、歩数、歩き方(歩く速さ・歩幅・左右の差・両足で支えている時間・歩行安定性)、安静時の心拍数と心拍変動(それぞれ測った時刻も)</dd>
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

  // 薬を飲んだ時刻を入れる(長押し・前の日・「時刻を変える」から)
  // 他の薬(prn)は、replace に直したい記録("13:20 痛み止め")を渡す。新しく記録する時は、入れかけの名前を使う
  function openMedTime(f, v, label, replace) {
    let time = nowHm(), name = '';
    if (f === 'prn') {
      if (replace) { const p = prnItem(replace); time = p.t; name = p.name; }
      else {
        const inp = document.getElementById('prn-name');
        if (inp) { prnDraft = inp.value; if (document.activeElement === inp) inp.blur(); } // 入力中のままだと、記録したあと描き直されない
        name = prnDraft;
      }
    } else { const m = parseMed(obsNow()[f], f === 'med_morning'); if (m.st === v && m.t) time = m.t; }
    sheet = { type: 'medtime', f, v, label, time, name, replace: replace || null };
    renderOverlay();
  }
  function medTimeSheetHTML() {
    const isPrn = sheet.f === 'prn';
    const recent = isPrn ? prnRecent(obsNow()) : [];
    const nameField = isPrn ? `<label class="field"><span>薬の名前(空でも記録できます)</span><input type="text" id="med-name" maxlength="30" value="${esc(sheet.name || '')}" placeholder="例: 痛み止め" enterkeyhint="done" autocomplete="off"></label>
      ${prnChips(recent, sheet.name, 'margin:-4px 0 10px')}` : '';
    return wrapSheet(`<h3>${esc(sheet.label)}</h3>
      ${nameField}
      <label class="field"><span>飲んだ時刻(4桁の数字。例: 0815 = 8時15分)</span>${hmInput('id="med-time" aria-label="飲んだ時刻(4桁)"', sheet.time)}</label>
      <p class="help" id="med-time-view">${esc(hmView(sheet.time))}</p>
      ${curDate !== logicalToday() ? `<p class="help">${jpDate(curDate)}の分として記録します。深夜 0〜3 時台の時刻は、その前の日の夜の分になります。</p>` : ''}
      <div class="actions"><button class="btn primary" data-act="medtime-save">${isPrn && sheet.replace ? 'この内容に直す' : 'この時刻で記録'}</button><button class="btn ghost" data-act="sheet-close">やめる</button></div>`);
  }
  function hmView(v) {
    const t = parseHm(v);
    if (t === '') return '時刻を4桁の数字で入れてください';
    if (t === null) return '時刻が読めません。4桁の数字で入れてください(例: 0815)';
    const [h, m] = t.split(':').map(Number);
    return `→ ${h}時${m}分`;
  }
  function medTimeSave() {
    const t = parseHm(sheet.time);
    if (!t) { toast('時刻を4桁の数字で入れてください(例: 0815)'); return; }
    const { f, v, label, replace, name } = sheet;
    sheet = null; renderOverlay();
    if (f === 'prn') { addPrn(t, name, replace); return; }
    saveObs({ [f]: `${v} ${t}` });
    if (!askEarly(f)) toast(`${label} ${t} で記録しました`);
  }

  // 他の薬(頓服など): 入れかけの名前と、前に使った名前の候補(この端末に覚える。最大 8 つ。× で消せる)
  const PRN_NAMES_MAX = 8;
  let prnDraft = '';
  let prnNames = load(KEYS.prnNames, []);
  if (!Array.isArray(prnNames)) prnNames = [];
  const prnRecent = () => prnNames.filter((n) => typeof n === 'string' && n);
  function prnRemember(n, forget) {
    const next = (n ? [n] : []).concat(prnNames.filter((x) => x !== n && x !== forget)).slice(0, PRN_NAMES_MAX);
    if (JSON.stringify(next) !== JSON.stringify(prnNames)) { prnNames = next; save(KEYS.prnNames, prnNames); }
  }
  // 名前の候補のボタン。名前を押すと欄に入り、× で候補から消す(記録は消えない)
  const prnChips = (names, cur, style) => (names.length ? `<div class="chips prn-recent"${style ? ` style="${style}"` : ''}>${names.map((n) =>
    `<span class="name-chip ${n === cur ? 'sel' : ''}"><button class="nc-name" data-act="prn-name" data-name="${esc(n)}" aria-pressed="${n === cur}">${esc(n)}</button><button class="nc-x" data-act="prn-forget" data-name="${esc(n)}" aria-label="「${esc(n)}」を候補から消す">×</button></span>`).join('')}</div>` : '');
  // 記録を足す(replace があれば、その記録を直す)。名前を直した時は、前の名前(打ちまちがい)を候補から外す
  function addPrn(t, name, replace) {
    const item = prnStr(t, name);
    const nm = prnItem(item).name;
    const list = prnList(obsNow());
    if (replace) { const i = list.indexOf(replace); if (i >= 0) list.splice(i, 1); }
    else prnDraft = '';
    list.push(item);
    const old = replace ? prnItem(replace).name : '';
    // 名前を変えずに時刻だけ直した時は、候補を増やさない(× で消した名前が戻らないように)
    prnRemember(replace && nm === old ? '' : nm, old && !list.some((s) => prnItem(s).name === old) ? old : '');
    savePrn(list);
    const what = `他の薬${nm ? `(${nm})` : ''} ${t}`;
    if (replace) toast(`${what} に直しました`);
    else toast(`${what} で記録しました`, { label: '直す', onClick: () => { if (prnList(obsNow()).includes(item)) openMedTime('prn', '', '他の薬を直す', item); } });
  }
  function savePrn(list) {
    list.sort((a, b) => hmKey(prnItem(a).t) - hmKey(prnItem(b).t));
    saveObs({ prn_times: list.join(','), prn: list.length || null });
  }

  function renderOverlay() {
    const el = document.getElementById('overlay');
    if (!sheet) { el.innerHTML = ''; return; }
    const map = { memo: memoSheetHTML, key: keySheetHTML, psettings: patientSettingsHTML, health: healthSheetHTML, slot: slotSheetHTML, react: reactSheetHTML, image: imageSheetHTML, medtime: medTimeSheetHTML, cal: calSheetHTML, early: earlySheetHTML,
      striveweek: striveWeekSheetHTML, shot: shotSheetHTML };
    el.innerHTML = map[sheet.type] ? map[sheet.type]() : '';
    if (sheet && sheet.type === 'memo') { const ta = el.querySelector('textarea'); if (ta && !sheet.focused) { sheet.focused = true; setTimeout(() => ta.focus(), 50); } }
  }

  /* ========== 操作 ========== */
  const obsNow = () => (cache && cache.obs) || {};
  function saveObs(patch) {
    const date = curDate;
    // 寝る前の薬を夕方より後に直した・取り消した時は「早く休んだ日」も外す(サーバーも同じように外す)
    if ('med_night' in patch && !isEarlyNight(patch.med_night) && obsNow().early_bed === 1) patch.early_bed = null;
    enqueue(Object.assign({ action: 'saveObs', date }, patch), (c) => { if (c.date === date) c.obs = Object.assign({ date }, c.obs || {}, patch); });
  }
  function memoSave() {
    const text = (sheet.text || '').trim();
    if (!text && !sheet.id) { sheet = null; renderOverlay(); return; }
    if (!text) { toast('メモが空です。消す時は、メモの横の × を押してください'); return; }
    const hm = parseHm(sheet.time);
    if (!hm) { toast('時刻を4桁の数字で入れてください(例: 1320)'); return; }
    const date = sheet.date; const ts = memoTs(date, hm);
    if (sheet.id) { // 直す
      const id = sheet.id;
      enqueue({ action: 'updateMemo', id, text, ts }, (c) => { c.memos = (c.memos || []).map((m) => (m.id === id ? Object.assign({}, m, { text, ts }) : m)).sort(byTs); });
      sheet = null; renderOverlay();
      toast(`${hm} のメモに直しました`);
      return;
    }
    const clientId = uid();
    enqueue({ action: 'addMemo', date, ts, text, clientId }, (c) => { if (date === c.date) c.memos = (c.memos || []).concat([{ id: clientId, date, ts, text }]).sort(byTs); });
    sheet = null; renderOverlay();
    toast(`${hm} でメモしました`);
  }
  function saveSettings(form) {
    const f = new FormData(form);
    const settings = {};
    ['app_title', 'start_date', 'patient_name', 'supporter_name', 'med2_label', 'last_appointment', 'next_appointment', 'report_note'].forEach((k) => { settings[k] = String(f.get(k) || '').trim().slice(0, k === 'report_note' ? 2000 : 40); });
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
    const name = String(f.get('health_shortcut_name') || '').trim() || 'KMヘルスチェック送信';
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
  const decodeImage = (url) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('decode')); i.src = url; });
  async function shrinkImage(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await decodeImage(url);
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
  // 1枚を縮めて送る。登録できたら 'u:<id>' を返す。できなければ、理由の文を持った Error を投げる
  async function uploadOne(file) {
    let img;
    try { img = await shrinkImage(file); } catch (e) {
      throw new Error(e.message === 'big' ? '画像が大きすぎます' : 'この画像は読めませんでした');
    }
    const name = String(file.name || '画像').replace(/\.[^.]+$/, '').slice(0, 30) || '画像';
    let data;
    try { data = await call({ action: 'uploadImage', name, data: img.data, w: img.w, h: img.h }); } catch (e) {
      throw Object.assign(new Error('通信できませんでした。もう一度お試しください'), { stop: true });
    }
    if (!data.ok) throw Object.assign(new Error(data.message || '登録できませんでした'), { stop: data.error === 'too_many' || data.error === 'auth' });
    const meta = data.image;
    const blob = dataUrlToBlob(img.data);
    await cachePut(meta.id, blob);
    up.url[meta.id] = URL.createObjectURL(blob);
    if (cache) { cache.images = (cache.images || []).concat([meta]); save(KEYS.state, cache); }
    return 'u:' + meta.id;
  }
  // 画像を登録する。「登録した画像」からは何枚でも一度に選べるので、1枚ずつ順番に送る
  async function uploadImages(files, target) {
    if (!files.length) return;
    if (uploading) { toast('いま画像を送っています。終わるまでお待ちください'); return; }
    uploading = true;
    const n = files.length;
    let done = 0, ref = '', rest = 0;
    const fails = [];
    try {
      for (let i = 0; i < n; i++) {
        toast(n > 1 ? `画像を縮めて送っています… ${i + 1} / ${n}枚` : '画像を縮めて送っています…');
        try {
          ref = await uploadOne(files[i]);
          done++;
          render();
        } catch (e) {
          fails.push(e.message);
          if (e.stop) { rest = n - i - 1; break; }
        }
      }
    } finally {
      uploading = false;
    }
    if (done && n === 1) {
      if (target.startsWith('slot:')) { setSlot(target.slice(5), ref); sheet = null; renderOverlay(); }
      else if (target === 'react' && sheet && sheet.type === 'react') { sheet.draft = ref; sheet.emoji = ''; renderOverlay(); }
    }
    if (!fails.length) toast(n > 1 ? `${done}枚の画像を登録しました` : '画像を登録しました');
    else if (n === 1) toast(fails[0]);
    else {
      const why = fails.filter((m, i) => fails.indexOf(m) === i).join(' / ');
      const ng = fails.length + rest;
      toast(`${done}枚を登録しました。${ng}枚は登録できませんでした(${why})`, { label: 'OK', onClick: () => {} });
    }
  }

  /* ---- StrivePD のスクショを送る ----
   * 文字やグラフが読めるように、幅 760px までに縮めた JPEG にする(1枚 約 100〜250KB)。大きすぎたら画質と幅を下げる */
  async function shrinkShot(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await decodeImage(url);
      const w = img.naturalWidth || 760, h = img.naturalHeight || 1600;
      for (const [mw, mh, q] of [[760, 1700, 0.8], [760, 1700, 0.66], [640, 1400, 0.66], [540, 1200, 0.6]]) {
        const sc = Math.min(1, mw / w, mh / h);
        const cw = Math.max(1, Math.round(w * sc)), ch = Math.max(1, Math.round(h * sc));
        const c = document.createElement('canvas'); c.width = cw; c.height = ch;
        const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch); ctx.drawImage(img, 0, 0, cw, ch);
        const data = c.toDataURL('image/jpeg', q);
        if (data.startsWith('data:image/jpeg') && data.length <= 390000) return { data, w: cw, h: ch };
      }
      throw new Error('big');
    } finally { URL.revokeObjectURL(url); }
  }
  let striveProg = null; // 送っている途中 { i: 何枚目, n: 全部で }
  let striveData = null; // 一覧の「StrivePD のスクショ」(striveList の結果)
  let striveLoading = false;
  const isPatient = () => cfg.role === 'patient';
  const SHOT_BATCH = 24; // 一度に選べる枚数
  async function uploadShots(files) {
    if (!files.length) return;
    if (uploading) { toast(isPatient() ? 'いま おくっているところ。おわるまで まってね' : 'いま画像を送っています。終わるまでお待ちください'); return; }
    if (files.length > SHOT_BATCH) {
      toast(isPatient() ? `いちどに えらべるのは ${SHOT_BATCH}まい までだよ(いま ${files.length}まい)。えらびなおしてね` : `一度に選べるのは ${SHOT_BATCH}枚までです(${files.length}枚選ばれました)。選び直してください`, { label: 'OK', onClick: () => {} });
      return;
    }
    uploading = true; striveProg = { i: 0, n: files.length };
    let done = 0, stop = '', thanks = null;
    const fails = [];
    try {
      for (let i = 0; i < files.length && !stop; i++) {
        striveProg.i = i + 1; render();
        let img;
        try { img = await shrinkShot(files[i]); } catch (e) { fails.push(e.message === 'big' ? '大きすぎる画像' : '読めない画像'); continue; }
        let r;
        try { r = await call({ action: 'striveUpload', name: String(files[i].name || '').replace(/\.[^.]+$/, '').slice(0, 40), data: img.data, w: img.w, h: img.h }); }
        catch (e) { stop = 'net'; break; }
        if (!r.ok) {
          if (r.error === 'unauthorized') { stop = 'auth'; break; }
          fails.push(r.message || '保存できない画像');
          if (r.error === 'too_many') stop = 'full';
          continue;
        }
        done++;
        if (r.thanks) thanks = r.thanks;
        await cachePutKey(shotKey(r.item.id), dataUrlToBlob(img.data));
        if (cache) { cache.strive = r.strive; save(KEYS.state, cache); }
        if (striveData) { striveData.items = striveData.items.concat([r.item]); striveData.strive = r.strive; }
      }
    } finally {
      uploading = false; striveProg = null;
    }
    if (stop === 'auth') { logout('ログインし直してください'); return; }
    const rest = files.length - done - fails.length;
    if (isPatient()) {
      if (done) {
        // お礼のスタンプが届いた時は、そちらがふきだしに出る(下の refresh で届く)
        if (!thanks) { patMsg = `しゃしん ${done}まい、とどいたよ。ありがとう！`; clearTimeout(patTimer); patTimer = setTimeout(() => { patMsg = null; render(); }, 8000); }
        if (fails.length || rest) toast(`${done}まい とどいたよ。${fails.length + rest}まいは おくれなかったので、あとで もう一度 えらんでね`, { label: 'OK', onClick: () => {} });
      } else toast(stop === 'net' ? 'つながらなかったので、あとで もう一度 えらんでね' : stop === 'full' ? fails[fails.length - 1] : 'しゃしんを おくれませんでした', { label: 'OK', onClick: () => {} });
    } else if (done && !fails.length && !rest) toast(`${done}枚を送りました`);
    else if (done) toast(`${done}枚を送りました。${fails.length + rest}枚は送れませんでした(${stop === 'net' ? '通信できませんでした' : fails.filter((m, i) => fails.indexOf(m) === i).join(' / ')})`, { label: 'OK', onClick: () => {} });
    else toast(stop === 'net' ? '通信できませんでした。もう一度お試しください' : fails[0] || '送れませんでした');
    render(); refresh(true);
  }
  // 「これでおしまい」(8 枚そろわなくても送り終わりにする)
  function striveDone() {
    enqueue({ action: 'striveDone' }, (c) => { if (c.strive) c.strive = Object.assign({}, c.strive, { done: true, show: false }); });
    if (isPatient()) { patMsg = 'とどけてくれて、ありがとう！'; clearTimeout(patTimer); patTimer = setTimeout(() => { patMsg = null; render(); }, 8000); render(); }
  }
  // 一覧の「StrivePD のスクショ」を読む
  async function loadStrive() {
    if (striveLoading) return;
    striveLoading = true;
    try {
      const d = await call({ action: 'striveList' });
      if (d.ok) striveData = d;
    } catch (e) { /* 次に開いた時に */ }
    striveLoading = false;
    if (tab === 'list') render();
    if (sheet && sheet.type === 'striveweek') renderOverlay();
  }
  // お礼のスタンプを選ぶ(type = '' ならなし)。本人の画面で同じ見た目を出せるよう、ことばと絵の控えも一緒に保存する
  function saveThanks(type, message) {
    let v = '';
    if (type) {
      const def = reactionsNow().find((r) => r.id === type);
      if (!def) { toast('この種類は使えません'); return; }
      const image = def.image && STATIC.library[def.image] ? STATIC.library[def.image] : def.image;
      v = JSON.stringify({ type, label: def.label, image, message: String(message || '').trim().slice(0, 200) });
    }
    const settings = { strive_thanks: v };
    enqueue({ action: 'saveSettings', settings }, (c) => { c.settings = Object.assign({}, c.settings, settings); });
  }
  function thanksNow(s) { try { const t = s && s.strive_thanks ? JSON.parse(s.strive_thanks) : null; return t && t.type ? t : null; } catch (e) { return null; } }

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
    document.title = cfg.token && cfg.role === 'supporter' ? appTitle() : 'くま'; // ブラウザのタブの名前
    if (!cfg.token) { root.innerHTML = viewLogin(); renderOverlay(); return; }
    if (cache && cache.settings) rememberLook();
    let data = null;
    if (cfg.role === 'supporter') data = cache && cache.date === curDate && 'obs' in cache ? cache : null;
    else data = cache && cache.room ? cache : null;
    root.innerHTML = cfg.role === 'supporter' ? viewSupporter(data) : viewPatient(data);
    root.querySelectorAll('textarea.note').forEach((t) => { if (t.value) fitNote(t); });
    renderOverlay(); renderSync();
    if (!data) refresh(true);
  }
  document.addEventListener('focusout', () => { setTimeout(() => { if (pendingRender && !isEditing()) render(); }, 200); });

  /* ========== イベント ========== */
  // 長押し(薬のボタン): 0.5 秒押し続けると時刻を入れる欄を開く。そのあとのクリックは無視する
  let lpTimer = null, lpFired = false, lpPos = null;
  const lpCancel = () => { clearTimeout(lpTimer); lpTimer = null; };
  document.addEventListener('pointerdown', (e) => {
    lpFired = false;
    const el = e.target.closest && e.target.closest('[data-lp]');
    if (!el) return;
    lpPos = [e.clientX, e.clientY]; lpCancel();
    lpTimer = setTimeout(() => {
      lpTimer = null; lpFired = true;
      try { if (navigator.vibrate) navigator.vibrate(15); } catch (err) { /* 無視 */ }
      if (el.dataset.lp === 'prn') openMedTime('prn', '', el.dataset.label);
      else if (el.dataset.lp === 'prn-edit') { const s = prnList(obsNow())[parseInt(el.dataset.i, 10)]; if (s) openMedTime('prn', '', '他の薬を直す', s); }
      else if (el.dataset.lp === 'memo-edit') openMemo(el.dataset.id);
      else openMedTime(el.dataset.f, el.dataset.v, el.dataset.label);
    }, 500);
  });
  document.addEventListener('pointermove', (e) => { if (lpTimer && lpPos && Math.hypot(e.clientX - lpPos[0], e.clientY - lpPos[1]) > 10) lpCancel(); });
  ['pointerup', 'pointercancel'].forEach((t) => document.addEventListener(t, lpCancel));
  document.addEventListener('contextmenu', (e) => { if (e.target.closest && e.target.closest('[data-lp]')) e.preventDefault(); });

  document.addEventListener('click', (e) => {
    if (lpFired) { lpFired = false; e.preventDefault(); return; } // 長押しのあとのクリック
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
        if (nm) {
          nm.placeholder = loginNamePh(loginRole);
          // 名前が空か、もう一方の人の名前のままなら、選んだ人の名前に入れ替える
          const other = lookName(loginRole === 'patient' ? 'supporter' : 'patient');
          const v = nm.value.trim();
          if (lookName(loginRole) && (!v || v === other || v === String(cfg.name || '').trim())) nm.value = lookName(loginRole);
        }
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
        if (f === 'activity') { // 残業は出勤した日だけ: 残業を選ぶと出勤も、出勤を外すと残業も
          if (v === 'overtime' && cur.has('overtime')) cur.add('work');
          if (v === 'work' && !cur.has('work')) cur.delete('overtime');
        }
        saveObs({ [f]: SET_OPTS[f].map((x) => x[0]).filter((x) => cur.has(x)).join(',') });
        break;
      }
      case 'med': {
        const f = el.dataset.f; const v = el.dataset.v; const label = el.dataset.label;
        const m = parseMed(obsNow()[f], f === 'med_morning');
        if (m.st === v) { saveObs({ [f]: '' }); toast(`「${label}」を取り消しました`); break; } // もう一度押すと取り消し
        if (v === 'no') { saveObs({ [f]: 'no' }); break; }
        if (curDate !== logicalToday()) { openMedTime(f, v, label); break; } // 前の日は時刻を入れてもらう
        const t = nowHm();
        saveObs({ [f]: `${v} ${t}` });
        if (!askEarly(f)) toast(`${label} ${t} で記録しました`, { label: '時刻を変える', onClick: () => openMedTime(f, v, label) });
        break;
      }
      case 'early-ok': saveObs({ early_bed: 1 }); sheet = null; renderOverlay(); toast('早く休んだ日として記録しました'); break;
      case 'early-fix': {
        const m = parseMed(obsNow().med_night); const st = m.st === 'part' ? 'part' : 'yes';
        sheet = null;
        openMedTime('med_night', st, `寝る前の薬: ${st === 'part' ? '一部' : '飲んだ'}`);
        break;
      }
      case 'prn-add': {
        if (curDate !== logicalToday()) { openMedTime('prn', '', '他の薬を飲んだ'); break; } // 前の日は時刻を入れてもらう
        const inp = document.getElementById('prn-name'); if (inp) prnDraft = inp.value;
        addPrn(nowHm(), prnDraft);
        break;
      }
      case 'prn-name': { // 前に使った名前を押すと、名前の欄に入る(もう一度押すと空に)
        const n = el.dataset.name;
        if (sheet && sheet.type === 'medtime' && el.closest('#overlay')) { sheet.name = sheet.name === n ? '' : n; renderOverlay(); break; }
        const inp = document.getElementById('prn-name'); if (inp) prnDraft = inp.value;
        prnDraft = prnClean(prnDraft) === n ? '' : n;
        render();
        break;
      }
      case 'note-ex': el.classList.toggle('open'); break; // ほかの日の備考: 押すと全文、もう一度押すと 1 行ずつ
      case 'prn-forget': {
        const n = el.dataset.name;
        if (!n || !confirm(`「${n}」を名前の候補から消しますか？\n(これまでの記録は消えません)`)) break;
        prnNames = prnNames.filter((x) => x !== n); save(KEYS.prnNames, prnNames);
        if (prnClean(prnDraft) === n) prnDraft = '';
        if (sheet && sheet.type === 'medtime') renderOverlay();
        render();
        break;
      }
      case 'prn-edit': {
        const s = prnList(obsNow())[parseInt(el.dataset.i, 10)];
        if (s) openMedTime('prn', '', '他の薬を直す', s);
        break;
      }
      case 'prn-del': {
        const list = prnList(obsNow()); const s = list[parseInt(el.dataset.i, 10)];
        if (s && confirm(`他の薬「${prnItem(s).name ? prnItem(s).t + ' ' + prnItem(s).name : prnItem(s).t}」を取り消しますか？`)) { list.splice(list.indexOf(s), 1); savePrn(list); }
        break;
      }
      case 'medtime-save': medTimeSave(); break;
      case 'order': {
        const order = cardOrder(settingsNow()); const i = order.indexOf(el.dataset.k); const j = i + parseInt(el.dataset.d, 10);
        if (i < 0 || j < 0 || j >= order.length) break;
        [order[i], order[j]] = [order[j], order[i]];
        saveOrder(order);
        break;
      }
      case 'order-reset': saveOrder(CARD_DEFS.map((d) => d[0])); toast('最初の並びに戻しました'); break;
      case 'wake-now': saveObs({ wake_time: nowHm() }); break;
      case 'bed-now': saveObs({ bed_time: nowHm() }); break;
      case 'memo-new': sheet = { type: 'memo', date: el.dataset.date, text: '', time: nowHm() }; renderOverlay(); break;
      case 'memo-edit': openMemo(el.dataset.id); break;
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
      case 'tab': tab = el.dataset.tab; if (tab === 'list') { listData = null; listPage = 0; listFailed = false; loadStrive(); } render(); break;
      case 'list-page': listPage = Math.max(0, listPage + parseInt(el.dataset.d, 10)); render(); break;
      case 'list-retry': listFailed = false; listData = null; render(); break;
      case 'export': if (el.dataset.fmt === 'strive') exportStrive(); else exportData(el.dataset.fmt); break;
      case 'strive-done': striveDone(); break;
      case 'strive-ask': {
        const settings = { strive_ask: logicalToday() };
        enqueue({ action: 'saveSettings', settings }, (c) => { c.settings = Object.assign({}, c.settings, settings); if (c.strive) c.strive = Object.assign({}, c.strive, { asked: true, show: !c.strive.done && c.strive.on }); });
        if (striveData && striveData.strive) striveData.strive = Object.assign({}, striveData.strive, { asked: true, show: true });
        render();
        toast('きょうだけ、本人の画面に案内を出しました');
        break;
      }
      case 'strive-week': sheet = { type: 'striveweek', week: el.dataset.week }; renderOverlay(); break;
      case 'shot-open': sheet = { type: 'shot', id: el.dataset.id, week: sheet && sheet.week }; renderOverlay(); break;
      case 'shot-del': {
        const m = ((striveData && striveData.items) || []).find((x) => x.id === sheet.id);
        if (!m || !confirm('この画像を消しますか？(元に戻せません)')) break;
        enqueue({ action: 'striveDelete', id: m.id });
        striveData.items = striveData.items.filter((x) => x.id !== m.id);
        sheet = { type: 'striveweek', week: m.week }; renderOverlay(); render();
        toast('消しました');
        break;
      }
      case 'strive-week-del': {
        const w = sheet.week;
        const n = ((striveData && striveData.items) || []).filter((x) => x.week === w).length;
        if (!n || !confirm(`${weekLabel(w)}の画像 ${n}枚を全部消しますか？(元に戻せません。分析用に保存したあとに消してください)`)) break;
        enqueue({ action: 'striveDelete', week: w });
        striveData.items = striveData.items.filter((x) => x.week !== w);
        sheet = null; renderOverlay(); render();
        toast(`${n}枚を消しました`);
        break;
      }
      case 'strive-thanks': {
        const inp = document.getElementById('strive-thanks-msg');
        saveThanks(el.dataset.type, inp ? inp.value : '');
        toast(el.dataset.type ? 'お礼のスタンプを選びました' : 'お礼のスタンプは送らないようにしました');
        break;
      }
      case 'cal-open': openCal(); break;
      case 'cal-month': {
        const [y, m] = sheet.month.split('-').map(Number);
        const d = new Date(y, m - 1 + parseInt(el.dataset.d, 10), 1);
        sheet.month = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
        renderOverlay(); loadCalMonth(sheet.month);
        break;
      }
      case 'cal-pick': {
        if (el.disabled) break;
        const d = el.dataset.date;
        sheet = null; renderOverlay();
        if (d !== curDate) { curDate = d; cache = null; }
        tab = 'today'; render(); window.scrollTo(0, 0);
        break;
      }
      case 'date': {
        if (el.disabled) break;
        const next = addDays(curDate, parseInt(el.dataset.delta, 10));
        if (startDate() && next < startDate()) break; // 記録の開始日より前には戻らない
        curDate = next; cache = null; render(); break;
      }
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

  // 画像を選んだ時。写真を選んでいる間に画面が描き直されても(選ぶ欄が入れ替わっても)届くように、
  // 選ぶ欄を押した時に、その欄そのものに受け取り役を付けておく
  function onFilesPicked(t) {
    const files = Array.from(t.files || []); const target = t.dataset.upload; t.value = '';
    if (target === 'strive') uploadShots(files); else uploadImages(files, target);
  }
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t && t.matches && t.matches('input[type=file][data-upload]')) t.onchange = (ev) => { ev.stopPropagation(); onFilesPicked(t); };
  }, true);
  // 入力欄: 観察の文字と時刻は、入力し終わった時(欄から離れた時)に保存する
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches && t.matches('input[type=file][data-upload]')) { onFilesPicked(t); return; }
    if (t.dataset && t.dataset.export) { exportRange = Object.assign({}, exportRange, { [t.dataset.export]: t.value }); return; }
    if (t.id === 'strive-thanks-msg') { const th = thanksNow(settingsNow()); if (th) { saveThanks(th.type, t.value); toast('ことばを保存しました'); } return; }
    if (t.dataset && t.dataset.obs) { saveObs({ [t.dataset.obs]: t.value.trim() }); return; }
    if (t.dataset && t.dataset.setting) {
      const settings = { [t.dataset.setting]: t.value };
      enqueue({ action: 'saveSettings', settings }, (c) => { c.settings = Object.assign({}, c.settings, settings); });
      toast('保存しました');
      return;
    }
    if (t.dataset && t.dataset.obsHm) {
      const hm = parseHm(t.value);
      if (hm === null) { toast('時刻は4桁の数字で入れてください(例: 0730)'); t.value = String(obsNow()[t.dataset.obsHm] || '').replace(':', ''); return; }
      t.value = hm.replace(':', '');
      saveObs({ [t.dataset.obsHm]: hm });
    }
  });
  // シートの入力中の文字を覚えておく(描き直しても消えないように)
  document.addEventListener('input', (e) => {
    if (e.target.classList && e.target.classList.contains('note')) fitNote(e.target);
    if (e.target.id === 'prn-name') { prnDraft = e.target.value; return; }
    if (!sheet) return;
    const t = e.target;
    if (t.id === 'med-name') sheet.name = t.value;
    if (t.id === 'memo-time') { sheet.time = t.value; const v = document.getElementById('memo-time-view'); if (v) v.textContent = hmView(t.value); }
    if (t.id === 'memo-text') sheet.text = t.value;
    if (t.id === 'med-time') { sheet.time = t.value; const v = document.getElementById('med-time-view'); if (v) v.textContent = hmView(t.value); }
    if (t.id === 'react-label') { sheet.label = t.value; const b = document.querySelector('.react-preview b'); if (b) b.textContent = t.value || '…'; }
    if (t.id === 'react-emoji') sheet.emoji = t.value;
  });

  // 時刻の欄を押したら中身を全部選ぶ(そのまま 4 桁を打てば入れ替わる)。時刻のシートでは Enter で記録
  document.addEventListener('focusin', (e) => {
    const t = e.target;
    if (t && t.classList && t.classList.contains('hm')) setTimeout(() => { try { t.setSelectionRange(0, t.value.length); } catch (err) { /* 無視 */ } }, 0);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target && e.target.id === 'med-time') { e.preventDefault(); medTimeSave(); }
    else if (e.key === 'Enter' && e.target && e.target.dataset && e.target.dataset.obsHm) e.target.blur();
    else if (e.key === 'Enter' && e.target && (e.target.id === 'prn-name' || e.target.id === 'med-name' || e.target.id === 'memo-time' || e.target.id === 'strive-thanks-msg')) { e.preventDefault(); e.target.blur(); }
  });

  document.addEventListener('submit', (e) => {
    if (e.target.id === 'login-form') { e.preventDefault(); doLogin(e.target); }
    if (e.target.id === 'settings-form') { e.preventDefault(); saveSettings(e.target); }
    if (e.target.id === 'health-form') { e.preventDefault(); saveHealthLink(e.target); }
    if (e.target.id === 'weather-form') { e.preventDefault(); const i = e.target.querySelector('input'); if (i) i.blur(); saveWeatherPlace(e.target); }
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
