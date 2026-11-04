/**
 * @OnlyCurrentDoc
 *
 * kuma-api.gs — くまの記録 の API(Google Apps Script に貼る、ただ 1 つのファイル)
 *
 * 使い方(くわしくは SETUP.md の 1)
 *   1. Google スプレッドシートの「拡張機能 → Apps Script」を開き、最初からある「コード.gs」の中身を
 *      全部消して、このファイルの中身を全部貼る
 *   2. 「プロジェクトの設定(歯車)→ スクリプト プロパティ」に FAMILY_CODE(家族コード)を追加する
 *   3. 関数 setup を一度実行する(シートが作られ、確認の結果が「実行ログ」に出る)
 *   4. デプロイ → 新しいデプロイ → ウェブアプリ(次のユーザーとして実行: 自分 / アクセスできるユーザー: 全員)
 *
 * このファイルは書き換えなくてよい。家族コードはコードではなくスクリプト プロパティに置くので、
 * 新しい版のコードに貼り替えても家族コードは消えない。
 * 先頭の @OnlyCurrentDoc は「このスプレッドシートだけを使う」という宣言(許可の範囲が狭くなる)。
 *
 * 後半の Core(API 本体)は、ローカル開発サーバー(dev/server.js)からも同じコードで呼ばれる。
 * Apps Script の V8 で確実に動くよう、?. や ?? は使わない。
 */

var TIME_ZONE = 'Asia/Tokyo';

/* =====================================================================
 * 1. Apps Script の入口
 * ===================================================================== */

/** 初回に一度だけ実行: シートを作り、設定を確かめて結果を実行ログに出す。何度実行しても壊れない */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('スプレッドシートのメニュー「拡張機能 → Apps Script」から開いたプロジェクトで実行してください');
  var store = new SheetStore(ss);
  Object.keys(Core.TABLES).forEach(function (name) { store.sheet(name); });
  var existing = store.all('settings').map(function (r) { return String(r.key); });
  Object.keys(Core.DEFAULT_SETTINGS).forEach(function (k) {
    if (existing.indexOf(k) < 0) store.insert('settings', { key: k, value: Core.DEFAULT_SETTINGS[k] });
  });
  // 最初からある空の「シート1」は紛らわしいので消す(中身があるシートには触らない)
  ss.getSheets().forEach(function (sh) {
    if (!Core.TABLES[sh.getName()] && sh.getLastRow() === 0 && ss.getSheets().length > 1) {
      try { ss.deleteSheet(sh); } catch (e) { /* 消せなくても害はない */ }
    }
  });

  var lines = ['', '===== setup の結果 ====='];
  lines.push('✓ シート: ' + ss.getSheets().map(function (s) { return s.getName(); }).join(', '));
  var code = familyCode();
  if (!code) lines.push('✗ 家族コードがまだです。左の歯車「プロジェクトの設定」→「スクリプト プロパティ」に FAMILY_CODE を追加してください');
  else if (code.length < 8) lines.push('△ 家族コード: 設定済み(' + code.length + '文字)。8文字以上にするとより安全です');
  else lines.push('✓ 家族コード: 設定済み(' + code.length + '文字)');
  var tz = Session.getScriptTimeZone();
  // Etc/GMT-9 なども日本時間(+09:00、夏時間なし)と同じなので ✓ とする
  var jst = tz === TIME_ZONE || Utilities.formatDate(new Date(), tz, 'Z') === '+0900';
  lines.push(jst ? '✓ タイムゾーン: ' + tz + (tz === TIME_ZONE ? '' : '(日本時間と同じ +09:00)')
    : '△ タイムゾーン: ' + tz + '(このままでも動きます。気になる時は SETUP.md の「タイムゾーンを日本にする」)');
  lines.push(code ? '→ 次は右上の「デプロイ → 新しいデプロイ」です' : '→ 家族コードを追加したら、もう一度 setup を実行して ✓ になるか確かめてください');
  Logger.log(lines.join('\n'));
}

function familyCode() {
  var v = PropertiesService.getScriptProperties().getProperty('FAMILY_CODE');
  return v ? String(v).trim() : '';
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (!p.action) {
    return respond({ ok: true, message: 'Recording Health API', family_code: familyCode() ? '設定済み' : '未設定', time: new Date().toISOString() });
  }
  var req = {};
  Object.keys(p).forEach(function (k) { req[k] = p[k]; });
  if (p.payload) { try { Object.assign(req, JSON.parse(p.payload)); } catch (err) { /* 無視 */ } }
  return respond(handleRequest(req));
}

function doPost(e) {
  var req = {};
  var body = e && e.postData ? e.postData.contents : '';
  if (body) {
    try { req = JSON.parse(body); } catch (err) { req = (e && e.parameter) || {}; }
  } else {
    req = (e && e.parameter) || {};
  }
  return respond(handleRequest(req));
}

function handleRequest(req) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(30000); }
  catch (err) { return { ok: false, error: 'busy', message: '混み合っています。少し待ってもう一度お試しください' }; }
  try {
    return Core.handle(req, new SheetStore(SpreadsheetApp.getActiveSpreadsheet()), makeEnv());
  } finally {
    lock.releaseLock();
  }
}

function respond(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function makeEnv() {
  return {
    familyCode: familyCode(),
    now: function () { return new Date().toISOString(); },
    // 論理日(午前4時区切り)
    today: function () { return Utilities.formatDate(new Date(Date.now() - 4 * 3600 * 1000), TIME_ZONE, 'yyyy-MM-dd'); },
    uuid: function () { return Utilities.getUuid(); },
    sha256: function (s) {
      var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8);
      return bytes.map(function (b) { var v = (b < 0 ? b + 256 : b).toString(16); return v.length < 2 ? '0' + v : v; }).join('');
    },
    randomToken: function () { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''); }
  };
}

/**
 * SheetStore — シートをテーブルとして読み書きする。
 * すべてのセルを「書式なしテキスト」にして、日付や数字の自動変換を防ぐ。
 */
function SheetStore(ss) {
  this.ss = ss;
  this.cache = {};
  this.checked = {};
}

SheetStore.prototype.sheet = function (name) {
  var sh = this.ss.getSheetByName(name);
  var headers = Core.TABLES[name];
  if (!headers) throw new Error('不明なテーブル: ' + name);
  if (!sh) {
    sh = this.ss.insertSheet(name);
    sh.getRange(1, 1, sh.getMaxRows(), Math.max(headers.length, sh.getMaxColumns())).setNumberFormat('@');
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  } else if (!this.checked[name]) {
    // コードの更新で列が増えた時は、足りない見出しを右端に足す(既存の列と記録はそのまま)
    var cols = sh.getLastColumn();
    if (cols < headers.length) {
      if (sh.getMaxColumns() < headers.length) sh.insertColumnsAfter(sh.getMaxColumns(), headers.length - sh.getMaxColumns());
      sh.getRange(1, cols + 1, sh.getMaxRows(), headers.length - cols).setNumberFormat('@');
      sh.getRange(1, cols + 1, 1, headers.length - cols).setValues([headers.slice(cols)]).setFontWeight('bold');
    }
  }
  this.checked[name] = true;
  return sh;
};

SheetStore.prototype.all = function (name) {
  if (this.cache[name]) return this.cache[name];
  var sh = this.sheet(name);
  var headers = Core.TABLES[name];
  var rows = [];
  var lastRow = sh.getLastRow();
  if (lastRow >= 2) {
    var values = sh.getRange(2, 1, lastRow - 1, headers.length).getValues();
    for (var i = 0; i < values.length; i++) {
      var obj = {}, empty = true;
      for (var c = 0; c < headers.length; c++) {
        var v = values[i][c];
        if (v instanceof Date) v = Utilities.formatDate(v, TIME_ZONE, "yyyy-MM-dd'T'HH:mm");
        if (v !== '' && v !== null && v !== undefined) empty = false;
        obj[headers[c]] = v;
      }
      if (!empty) { obj._row = i + 2; rows.push(obj); }
    }
  }
  this.cache[name] = rows;
  return rows;
};

SheetStore.prototype.insert = function (name, obj) {
  var sh = this.sheet(name);
  var headers = Core.TABLES[name];
  var row = headers.map(function (h) { return toCell(obj[h]); });
  var r = sh.getLastRow() + 1;
  sh.getRange(r, 1, 1, headers.length).setNumberFormat('@').setValues([row]);
  delete this.cache[name];
};

SheetStore.prototype.update = function (name, keyField, keyValue, patch) {
  var rows = this.all(name);
  var found = null;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][keyField]) === String(keyValue)) { found = rows[i]; break; }
  }
  if (!found) return false;
  var headers = Core.TABLES[name];
  Object.keys(patch).forEach(function (k) { if (headers.indexOf(k) >= 0) found[k] = patch[k]; });
  var row = headers.map(function (h) { return toCell(found[h]); });
  this.sheet(name).getRange(found._row, 1, 1, headers.length).setNumberFormat('@').setValues([row]);
  return true;
};

function toCell(v) {
  if (v === null || v === undefined) return '';
  if (v === true) return '1';
  if (v === false) return '0';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/* =====================================================================
 * 2. Core — API 本体(プラットフォーム非依存)
 *
 *   Core.handle(req, store, env) -> レスポンスオブジェクト
 *     req   : { action, token, ...パラメータ }
 *     store : { all(table), insert(table,obj), update(table,keyField,keyValue,patch) }
 *     env   : { familyCode, now(), today(), uuid(), sha256(str), randomToken() }
 *
 * 日付は「論理日」(午前4時区切り)の "YYYY-MM-DD" 文字列。時刻は "YYYY-MM-DDTHH:MM" のローカル時刻文字列。
 * ===================================================================== */
var Core = (function () {
  var TABLES = {
    devices:      ['id', 'token_hash', 'role', 'name', 'created_at', 'last_seen'],
    daily_log:    ['date', 'dizziness', 'pain', 'alcohol', 'sleep_feel', 'meds_answer', 'note', 'duration_sec', 'updated_at'],
    med_event:    ['id', 'date', 'kind', 'taken_at', 'partial', 'deleted', 'created_at', 'updated_at'],
    health_daily: ['date', 'sleep_min', 'inbed_min', 'awakenings', 'deep_min', 'rem_min', 'bed_start', 'bed_end',
                   'steps', 'steadiness', 'resting_hr', 'hrv', 'dyskinesia', 'source', 'updated_at'],
    memo:         ['id', 'date', 'ts', 'text', 'deleted', 'created_at'],
    reaction:     ['id', 'date', 'from_name', 'type', 'message', 'seen', 'created_at', 'label', 'image'],
    settings:     ['key', 'value']
  };

  var DEFAULT_SETTINGS = {
    patient_name: '',
    supporter_name: '',
    meds_morning: '',
    meds_night: '',
    concerta_label: 'コンサータ',
    notify_morning: '08:00',
    notify_night: '21:30',
    next_appointment: '',
    last_appointment: '',
    ask_sleep_feel: '0',
    ask_dyskinesia: '0',
    health_shortcut_url: '',               // サポーターが作って共有したショートカットの iCloud リンク
    health_shortcut_name: 'くまヘルス送信', // そのショートカットの名前(アプリから実行するのに使う)
    health_consent: '0',                   // 本人の同意(1 = 同意している)。本人だけが consentHealth で変えられる
    health_consent_at: '',
    health_consent_by: ''
  };
  // saveSettings では変えられない設定(本人の同意は本人の操作でだけ変わる)
  var PROTECTED_SETTINGS = { health_consent: 1, health_consent_at: 1, health_consent_by: 1 };

  var MED_KINDS = { morning: 1, concerta: 1, night: 1, prn: 1 };
  // リアクションの種類は docs/images/images.js で増やせるので、ここでは id の形だけを確かめる
  function isReactionType(s) { return typeof s === 'string' && /^[a-z0-9_-]{1,32}$/i.test(s); }
  var HEALTH_FIELDS = ['sleep_min', 'inbed_min', 'awakenings', 'deep_min', 'rem_min', 'bed_start', 'bed_end',
                       'steps', 'steadiness', 'resting_hr', 'hrv', 'dyskinesia'];
  var HEALTH_TEXT_FIELDS = { bed_start: 1, bed_end: 1, steadiness: 1 };

  // ---------- 小さなユーティリティ ----------
  function isBlank(v) { return v === null || v === undefined || v === ''; }
  // "4,021" や "4021 歩" のような値も数字として読む
  function numText(v) { return String(v).replace(/[,\s]/g, ''); }
  function toInt(v) {
    if (isBlank(v)) return null;
    var n = parseInt(numText(v), 10);
    return isNaN(n) ? null : n;
  }
  function toNum(v) {
    if (isBlank(v)) return null;
    var n = parseFloat(numText(v));
    return isNaN(n) ? null : n;
  }
  function toStr(v) { return isBlank(v) ? '' : String(v); }
  function truthy(v) { return v === true || v === 1 || v === '1' || v === 'true'; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function isDateStr(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
  function isTimeStr(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s); }
  function commas(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  function addDays(dateStr, n) {
    var p = dateStr.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }
  function daysBetween(a, b) { // b - a (日数)
    var pa = a.split('-').map(Number), pb = b.split('-').map(Number);
    return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
  }

  function fail(code, message) {
    var e = new Error(message || code);
    e.code = code;
    return e;
  }

  // ---------- レコードの型を整える ----------
  function normLog(r) {
    return {
      date: toStr(r.date), dizziness: toInt(r.dizziness), pain: toInt(r.pain),
      alcohol: isBlank(r.alcohol) ? null : (truthy(r.alcohol) ? 1 : 0),
      sleep_feel: toInt(r.sleep_feel), meds_answer: toStr(r.meds_answer) || null,
      note: toStr(r.note), duration_sec: toInt(r.duration_sec), updated_at: toStr(r.updated_at)
    };
  }
  function normMed(r) {
    var partial = null;
    if (!isBlank(r.partial)) {
      try { partial = typeof r.partial === 'string' ? JSON.parse(r.partial) : r.partial; } catch (e) { partial = null; }
    }
    return {
      id: toStr(r.id), date: toStr(r.date), kind: toStr(r.kind), taken_at: toStr(r.taken_at),
      partial: partial, deleted: truthy(r.deleted) ? 1 : 0, created_at: toStr(r.created_at), updated_at: toStr(r.updated_at)
    };
  }
  function normHealth(r) {
    return {
      date: toStr(r.date), sleep_min: toInt(r.sleep_min), inbed_min: toInt(r.inbed_min), awakenings: toInt(r.awakenings),
      deep_min: toInt(r.deep_min), rem_min: toInt(r.rem_min), bed_start: toStr(r.bed_start) || null, bed_end: toStr(r.bed_end) || null,
      steps: toInt(r.steps), steadiness: toStr(r.steadiness) || null, resting_hr: toNum(r.resting_hr), hrv: toNum(r.hrv),
      dyskinesia: toNum(r.dyskinesia), source: toStr(r.source), updated_at: toStr(r.updated_at)
    };
  }
  function normMemo(r) {
    return { id: toStr(r.id), date: toStr(r.date), ts: toStr(r.ts), text: toStr(r.text), deleted: truthy(r.deleted) ? 1 : 0, created_at: toStr(r.created_at) };
  }
  function normReaction(r) {
    return { id: toStr(r.id), date: toStr(r.date), from_name: toStr(r.from_name), type: toStr(r.type), label: toStr(r.label), image: toStr(r.image),
      message: toStr(r.message), seen: truthy(r.seen) ? 1 : 0, created_at: toStr(r.created_at) };
  }

  // ---------- データ取得ヘルパー ----------
  function getSettings(store) {
    var out = {};
    for (var k in DEFAULT_SETTINGS) out[k] = DEFAULT_SETTINGS[k];
    store.all('settings').forEach(function (r) { if (!isBlank(r.key)) out[toStr(r.key)] = toStr(r.value); });
    return out;
  }
  function setSetting(store, key, value) {
    var rows = store.all('settings');
    for (var i = 0; i < rows.length; i++) {
      if (toStr(rows[i].key) === key) { store.update('settings', 'key', key, { value: value }); return; }
    }
    store.insert('settings', { key: key, value: value });
  }
  function logsBetween(store, from, to) {
    return store.all('daily_log').map(normLog).filter(function (r) { return r.date >= from && r.date <= to; });
  }
  function medsBetween(store, from, to) {
    return store.all('med_event').map(normMed).filter(function (r) { return !r.deleted && r.date >= from && r.date <= to; })
      .sort(function (a, b) { return a.taken_at < b.taken_at ? -1 : a.taken_at > b.taken_at ? 1 : 0; });
  }
  function healthBetween(store, from, to) {
    return store.all('health_daily').map(normHealth).filter(function (r) { return r.date >= from && r.date <= to; });
  }
  function memosBetween(store, from, to) {
    return store.all('memo').map(normMemo).filter(function (r) { return !r.deleted && r.date >= from && r.date <= to; })
      .sort(function (a, b) { return a.ts < b.ts ? -1 : 1; });
  }
  function findOne(list, field, value) {
    for (var i = 0; i < list.length; i++) if (list[i][field] === value) return list[i];
    return null;
  }

  // ---------- 認証 ----------
  function authenticate(req, store, env) {
    if (!req.token) throw fail('unauthorized', 'ログインが必要です');
    var hash = env.sha256(String(req.token).trim());
    var devices = store.all('devices');
    var d = null;
    for (var i = 0; i < devices.length; i++) if (toStr(devices[i].token_hash) === hash) { d = devices[i]; break; }
    if (!d) throw fail('unauthorized', 'ログイン情報が無効です。もう一度ログインしてください(ショートカットの場合は連携キーを確かめてください)');
    return { id: toStr(d.id), role: toStr(d.role), name: toStr(d.name) };
  }
  function requireRole(device, roles) {
    if (roles.indexOf(device.role) < 0) throw fail('forbidden', 'この操作はできません');
  }

  // ---------- ヘルスケアサンプルの集計 ----------
  function parseWhen(s) {
    if (s instanceof Date) return s.getTime();
    if (typeof s === 'number') return s;
    if (!s) return NaN;
    var t = String(s).trim()
      .replace(/(\d{4})年(\d{1,2})月(\d{1,2})日/, '$1-$2-$3') // 「2026年10月31日 23:12」の形も読む
      .replace(/\//g, '-').replace(/\s+/, 'T');
    // "2026-10-31T23:12:05" (タイムゾーンなし) はローカル時刻として扱う
    var m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0).getTime();
    return Date.parse(t);
  }
  function hm(ms) { var d = new Date(ms); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function sleepCategory(v) {
    if (v === null || v === undefined) return 'core';
    if (typeof v === 'number') return ['inbed', 'core', 'awake', 'core', 'deep', 'rem'][v] || 'core';
    var s = String(v).toLowerCase();
    if (/^\d+$/.test(s)) return sleepCategory(parseInt(s, 10));
    if (s.indexOf('bed') >= 0 || s.indexOf('ベッド') >= 0 || s.indexOf('就床') >= 0) return 'inbed';
    if (s.indexOf('awake') >= 0 || s.indexOf('覚醒') >= 0 || s.indexOf('目覚') >= 0) return 'awake';
    if (s.indexOf('deep') >= 0 || s.indexOf('深') >= 0) return 'deep';
    if (s.indexOf('rem') >= 0 || s.indexOf('レム') >= 0) return 'rem';
    return 'core';
  }
  function aggregateSamples(samples) {
    var out = {};
    var sleep = { inbed: 0, core: 0, deep: 0, rem: 0, awake: 0 };
    var awakeSegments = 0, lastWasSleep = false;
    var minStart = Infinity, maxEnd = -Infinity, anySleep = false;
    var steps = 0, anySteps = false;
    var hrs = [], hrvs = [], steadiness = null, dysk = null;
    var sleepSamples = samples.filter(function (s) { return toStr(s.type).toLowerCase().indexOf('sleep') === 0 || toStr(s.type) === '睡眠'; })
      .map(function (s) { return { start: parseWhen(s.start), end: parseWhen(s.end), cat: sleepCategory(s.value) }; })
      .filter(function (s) { return !isNaN(s.start) && !isNaN(s.end) && s.end > s.start; })
      .sort(function (a, b) { return a.start - b.start; });
    sleepSamples.forEach(function (s) {
      var min = (s.end - s.start) / 60000;
      sleep[s.cat] += min;
      if (s.cat !== 'inbed') {
        anySleep = true;
        if (s.start < minStart) minStart = s.start;
        if (s.end > maxEnd) maxEnd = s.end;
        if (s.cat === 'awake') { if (lastWasSleep) awakeSegments++; lastWasSleep = false; }
        else lastWasSleep = true;
      }
    });
    samples.forEach(function (s) {
      var t = toStr(s.type).toLowerCase();
      var v = toNum(s.value);
      if (t === 'steps' || t === '歩数') { if (v !== null) { steps += v; anySteps = true; } }
      else if (t === 'resting_hr' || t === 'restingheartrate') { if (v !== null) hrs.push(v); }
      else if (t === 'hrv') { if (v !== null) hrvs.push(v); }
      else if (t === 'steadiness' || t === 'walkingsteadiness') { if (!isBlank(s.value)) steadiness = String(s.value); }
      else if (t === 'dyskinesia') { if (v !== null) dysk = v; }
    });
    if (anySleep) {
      var asleep = sleep.core + sleep.deep + sleep.rem;
      out.sleep_min = Math.round(asleep);
      out.inbed_min = Math.round(sleep.inbed > 0 ? sleep.inbed : asleep + sleep.awake);
      out.awakenings = awakeSegments;
      out.deep_min = Math.round(sleep.deep);
      out.rem_min = Math.round(sleep.rem);
      out.bed_start = hm(minStart);
      out.bed_end = hm(maxEnd);
    }
    if (anySteps) out.steps = Math.round(steps);
    if (hrs.length) out.resting_hr = Math.round(hrs.reduce(function (a, b) { return a + b; }, 0) / hrs.length * 10) / 10;
    if (hrvs.length) out.hrv = Math.round(hrvs.reduce(function (a, b) { return a + b; }, 0) / hrvs.length * 10) / 10;
    if (steadiness !== null) out.steadiness = steadiness;
    if (dysk !== null) out.dyskinesia = dysk;
    return out;
  }
  // "start|end|value" を1行ずつ書いたテキスト(ショートカットで作りやすい)をサンプル配列へ
  function linesToSamples(text, type) {
    if (isBlank(text)) return [];
    return String(text).split(/\r?\n/).map(function (line) {
      var parts = line.split(/\s*[|\t]\s*/);
      if (parts.length < 2) return null;
      return { type: type, start: parts[0], end: parts[1], value: parts.length > 2 ? parts[2] : null };
    }).filter(Boolean);
  }
  // ショートカットの通知に出す短い説明
  function describeHealth(h) {
    var parts = [];
    var sm = toInt(h.sleep_min);
    if (sm !== null) parts.push('眠り ' + Math.floor(sm / 60) + '時間' + (sm % 60) + '分');
    if (toInt(h.awakenings) !== null && sm !== null) parts.push('途中で起きた ' + toInt(h.awakenings) + '回');
    if (toNum(h.steps) !== null) parts.push('歩数 ' + commas(toNum(h.steps)) + '歩');
    if (toNum(h.dyskinesia) !== null) parts.push('StrivePD ' + toNum(h.dyskinesia));
    return parts.length ? parts.join('、') : '数値なし';
  }

  // ---------- 各アクション ----------
  var actions = {};

  actions.ping = function (req, store, env) {
    return { ok: true, time: env.now(), version: 2 };
  };

  actions.login = function (req, store, env) {
    if (!env.familyCode) throw fail('setup', 'サーバーの家族コードがまだ設定されていません(SETUP.md の 1-5)');
    if (String(req.code || '').trim() !== String(env.familyCode)) throw fail('bad_code', '家族コードが違います');
    var role = req.role === 'supporter' ? 'supporter' : 'patient';
    var token = env.randomToken();
    var now = env.now();
    store.insert('devices', { id: env.uuid(), token_hash: env.sha256(token), role: role, name: toStr(req.name), created_at: now, last_seen: now });
    return { ok: true, token: token, role: role, name: toStr(req.name), settings: getSettings(store) };
  };

  actions.me = function (req, store, env, device) {
    return { ok: true, role: device.role, name: device.name, settings: getSettings(store) };
  };

  actions.state = function (req, store, env, device) {
    var date = isDateStr(req.date) ? req.date : null;
    if (!date) throw fail('bad_request', 'date が必要です');
    var yesterday = addDays(date, -1);
    var logs = store.all('daily_log').map(normLog);
    var log = findOne(logs, 'date', date);
    var ylog = findOne(logs, 'date', yesterday);
    var meds = medsBetween(store, yesterday, date);
    var health = findOne(healthBetween(store, date, date), 'date', date);
    var memos = memosBetween(store, date, date);
    var reactions = store.all('reaction').map(normReaction).filter(function (r) { return !r.seen; })
      .sort(function (a, b) { return a.created_at < b.created_at ? -1 : 1; }).slice(-5);
    var since = addDays(date, -41);
    var stampDates = logs.filter(function (r) { return r.date >= since && r.date <= date; }).map(function (r) { return r.date; });
    return {
      ok: true, date: date,
      log: log, meds: meds.filter(function (m) { return m.date === date; }),
      yesterday: { date: yesterday, log: ylog, meds: meds.filter(function (m) { return m.date === yesterday; }) },
      health: health, memos: memos, reactions: reactions,
      stamps: { dates: stampDates, total: logs.length },
      settings: getSettings(store)
    };
  };

  actions.saveLog = function (req, store, env, device) {
    if (!isDateStr(req.date)) throw fail('bad_request', 'date が必要です');
    var existing = findOne(store.all('daily_log').map(normLog), 'date', req.date);
    var row = existing ? existing : { date: req.date };
    function score(v) { var n = toInt(v); return n === null ? null : Math.max(0, Math.min(10, n)); }
    if ('dizziness' in req) row.dizziness = score(req.dizziness);
    if ('pain' in req) row.pain = score(req.pain);
    if ('alcohol' in req) row.alcohol = isBlank(req.alcohol) ? null : (truthy(req.alcohol) ? 1 : 0);
    if ('sleep_feel' in req) row.sleep_feel = toInt(req.sleep_feel);
    if ('meds_answer' in req) row.meds_answer = toStr(req.meds_answer) || null;
    if ('note' in req) row.note = toStr(req.note);
    if ('duration_sec' in req) row.duration_sec = toInt(req.duration_sec);
    row.updated_at = env.now();
    if (existing) store.update('daily_log', 'date', req.date, row); else store.insert('daily_log', row);
    return { ok: true, log: normLog(row) };
  };

  actions.addMed = function (req, store, env, device) {
    if (!isDateStr(req.date)) throw fail('bad_request', 'date が必要です');
    if (!MED_KINDS[req.kind]) throw fail('bad_request', 'kind が不正です');
    if (!isTimeStr(req.taken_at)) throw fail('bad_request', 'taken_at が不正です');
    var now = env.now();
    var row = { id: env.uuid(), date: req.date, kind: req.kind, taken_at: req.taken_at,
      partial: Array.isArray(req.partial) && req.partial.length ? JSON.stringify(req.partial) : '', deleted: 0, created_at: now, updated_at: now };
    store.insert('med_event', row);
    return { ok: true, med: normMed(row), clientId: req.clientId || null };
  };

  actions.updateMed = function (req, store, env, device) {
    if (!req.id) throw fail('bad_request', 'id が必要です');
    var patch = { updated_at: env.now() };
    if ('taken_at' in req) { if (!isTimeStr(req.taken_at)) throw fail('bad_request', 'taken_at が不正です'); patch.taken_at = req.taken_at; }
    if ('date' in req) { if (!isDateStr(req.date)) throw fail('bad_request', 'date が不正です'); patch.date = req.date; }
    if ('partial' in req) patch.partial = Array.isArray(req.partial) && req.partial.length ? JSON.stringify(req.partial) : '';
    if ('kind' in req) { if (!MED_KINDS[req.kind]) throw fail('bad_request', 'kind が不正です'); patch.kind = req.kind; }
    if (!store.update('med_event', 'id', String(req.id), patch)) throw fail('not_found', '記録が見つかりません');
    return { ok: true };
  };

  actions.deleteMed = function (req, store, env, device) {
    if (!req.id) throw fail('bad_request', 'id が必要です');
    if (!store.update('med_event', 'id', String(req.id), { deleted: 1, updated_at: env.now() })) throw fail('not_found', '記録が見つかりません');
    return { ok: true };
  };

  actions.addMemo = function (req, store, env, device) {
    if (!isDateStr(req.date)) throw fail('bad_request', 'date が必要です');
    var text = toStr(req.text).trim();
    if (!text) throw fail('bad_request', 'メモが空です');
    var row = { id: env.uuid(), date: req.date, ts: isTimeStr(req.ts) ? req.ts : req.date + 'T00:00', text: text.slice(0, 2000), deleted: 0, created_at: env.now() };
    store.insert('memo', row);
    return { ok: true, memo: normMemo(row), clientId: req.clientId || null };
  };

  actions.deleteMemo = function (req, store, env, device) {
    if (!req.id) throw fail('bad_request', 'id が必要です');
    if (!store.update('memo', 'id', String(req.id), { deleted: 1 })) throw fail('not_found', 'メモが見つかりません');
    return { ok: true };
  };

  actions.health = function (req, store, env, device) {
    var date = isDateStr(req.date) ? req.date : env.today();
    var patch = {};
    var samples = Array.isArray(req.samples) ? req.samples.slice() : [];
    samples = samples.concat(linesToSamples(req.sleep_lines, 'sleep'));
    samples = samples.concat(linesToSamples(req.steps_lines, 'steps'));
    if (samples.length) {
      var agg = aggregateSamples(samples);
      for (var k in agg) patch[k] = agg[k];
    }
    HEALTH_FIELDS.forEach(function (f) {
      if (!(f in req) || isBlank(req[f])) return;
      var v = HEALTH_TEXT_FIELDS[f] ? toStr(req[f]) : toNum(req[f]);
      if (v !== null && v !== '') patch[f] = v;
    });
    if (!Object.keys(patch).length) {
      throw fail('bad_request', '取り込めるデータがありません(Apple Watch を着けて寝た翌朝に、もう一度試してください)');
    }
    // ショートカット(連携キー)からの送信は、本人が「同意」している時だけ保存する
    if (device.role === 'health' && getSettings(store).health_consent !== '1') {
      return { ok: false, error: 'no_consent', preview: patch,
        message: '本人の同意がまだないので、保存しませんでした。読み取れた内容: ' + describeHealth(patch) };
    }
    patch.source = toStr(req.source) || device.role;
    patch.updated_at = env.now();
    var existing = findOne(healthBetween(store, date, date), 'date', date);
    if (existing) store.update('health_daily', 'date', date, patch);
    else { patch.date = date; store.insert('health_daily', patch); }
    return { ok: true, date: date, health: normHealth(existing ? Object.assign(existing, patch) : patch),
      message: describeHealth(patch) + ' を、くまの記録に届けました' };
  };

  // 本人による、ヘルスケア連携への同意(agree: 1)と取り消し(agree: 0)
  actions.consentHealth = function (req, store, env, device) {
    var agree = truthy(req.agree);
    setSetting(store, 'health_consent', agree ? '1' : '0');
    setSetting(store, 'health_consent_at', env.now());
    setSetting(store, 'health_consent_by', device.name);
    return { ok: true, settings: getSettings(store) };
  };

  actions.react = function (req, store, env, device) {
    requireRole(device, ['supporter']);
    if (!isReactionType(req.type)) throw fail('bad_request', 'type が不正です');
    // label / image は送信時の見た目の控え(本人の端末の images.js が古くても、種類を消した後でも表示できるようにする)
    var row = { id: env.uuid(), date: isDateStr(req.date) ? req.date : env.today(), from_name: device.name, type: req.type,
      message: toStr(req.message).slice(0, 200), seen: 0, created_at: env.now(),
      label: toStr(req.label).slice(0, 30), image: toStr(req.image).slice(0, 300) };
    store.insert('reaction', row);
    return { ok: true, reaction: normReaction(row) };
  };

  actions.seenReactions = function (req, store, env, device) {
    var ids = Array.isArray(req.ids) ? req.ids : [];
    ids.forEach(function (id) { store.update('reaction', 'id', String(id), { seen: 1 }); });
    return { ok: true };
  };

  actions.reactions = function (req, store, env, device) {
    var from = isDateStr(req.from) ? req.from : addDays(env.today(), -30);
    var list = store.all('reaction').map(normReaction).filter(function (r) { return r.date >= from; });
    return { ok: true, reactions: list };
  };

  actions.getSettings = function (req, store, env, device) {
    return { ok: true, settings: getSettings(store) };
  };

  actions.saveSettings = function (req, store, env, device) {
    var s = req.settings || {};
    if ('health_shortcut_url' in s) {
      var u = toStr(s.health_shortcut_url).trim();
      if (u && !/^https:\/\/(www\.)?icloud\.com\/shortcuts\/[A-Za-z0-9]+/.test(u)) {
        throw fail('bad_request', 'ショートカットのリンクは https://www.icloud.com/shortcuts/… の形です');
      }
      s.health_shortcut_url = u;
    }
    for (var k in s) {
      if (!(k in DEFAULT_SETTINGS) || PROTECTED_SETTINGS[k]) continue;
      setSetting(store, k, toStr(s[k]));
    }
    return { ok: true, settings: getSettings(store) };
  };

  actions.report = function (req, store, env, device) {
    var to = isDateStr(req.to) ? req.to : env.today();
    var from = isDateStr(req.from) ? req.from : addDays(to, -41);
    if (daysBetween(from, to) > 400) throw fail('bad_request', '期間が長すぎます');
    return {
      ok: true, from: from, to: to,
      logs: logsBetween(store, from, to), meds: medsBetween(store, from, to),
      health: healthBetween(store, from, to), memos: memosBetween(store, from, to),
      settings: getSettings(store)
    };
  };

  actions.createKey = function (req, store, env, device) {
    requireRole(device, ['supporter']);
    var token = env.randomToken();
    var now = env.now();
    store.insert('devices', { id: env.uuid(), token_hash: env.sha256(token), role: 'health', name: toStr(req.name) || 'ヘルスケア連携', created_at: now, last_seen: now });
    return { ok: true, token: token };
  };

  // 役割ごとに許可するアクション。health(ショートカットの連携キー)は健康データを送ることしかできない
  var ALLOW = {
    patient:   ['me', 'state', 'saveLog', 'addMed', 'updateMed', 'deleteMed', 'addMemo', 'deleteMemo', 'health', 'seenReactions', 'getSettings', 'saveSettings', 'report', 'consentHealth'],
    supporter: ['me', 'state', 'saveLog', 'addMed', 'updateMed', 'deleteMed', 'addMemo', 'deleteMemo', 'health', 'react', 'reactions', 'seenReactions', 'getSettings', 'saveSettings', 'report', 'createKey'],
    health:    ['health']
  };

  function handle(req, store, env) {
    try {
      req = req || {};
      var action = toStr(req.action);
      if (!action) return { ok: false, error: 'bad_request', message: 'action が必要です' };
      if (action === 'ping' || action === 'login') return actions[action](req, store, env);
      if (!actions[action]) return { ok: false, error: 'bad_request', message: '不明な action: ' + action };
      var device = authenticate(req, store, env);
      if ((ALLOW[device.role] || []).indexOf(action) < 0) return { ok: false, error: 'forbidden', message: 'この操作はできません' };
      return actions[action](req, store, env, device);
    } catch (e) {
      return { ok: false, error: e.code || 'error', message: e.message || String(e) };
    }
  }

  return { TABLES: TABLES, DEFAULT_SETTINGS: DEFAULT_SETTINGS, handle: handle, addDays: addDays, aggregateSamples: aggregateSamples };
})();
