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
 * 記録するのは家族(サポーター)。本人の端末には「くまとひとこと」だけを返し、記録の中身は渡さない。
 * 後半の Core(API 本体)は、ローカル開発サーバー(dev/server.js)からも同じコードで呼ばれる。
 * Apps Script の V8 で確実に動くよう、?. や ?? は使わない。
 */

var TIME_ZONE = 'Asia/Tokyo';

/* =====================================================================
 * 1. Apps Script の入口
 * ===================================================================== */

/** 初回(とプログラムを貼り替えた時)に一度だけ実行: シートを作り、設定を確かめて結果を実行ログに出す。何度実行しても壊れない */
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
  var old = ss.getSheets().map(function (s) { return s.getName(); }).filter(function (n) { return n === 'daily_log' || n === 'med_event'; });
  if (old.length) lines.push('・ ' + old.join(', ') + ' は前の版のシートです。今の版では使わないので、消してもかまいません');
  var code = familyCode();
  if (!code) lines.push('✗ 家族コードがまだです。左の歯車「プロジェクトの設定」→「スクリプト プロパティ」に FAMILY_CODE を追加してください');
  else if (code.length < 8) lines.push('△ 家族コード: 設定済み(' + code.length + '文字)。8文字以上にするとより安全です');
  else lines.push('✓ 家族コード: 設定済み(' + code.length + '文字)');
  var tz = Session.getScriptTimeZone();
  // Etc/GMT-9 なども日本時間(+09:00、夏時間なし)と同じなので ✓ とする
  var jst = tz === TIME_ZONE || Utilities.formatDate(new Date(), tz, 'Z') === '+0900';
  lines.push(jst ? '✓ タイムゾーン: ' + tz + (tz === TIME_ZONE ? '' : '(日本時間と同じ +09:00)')
    : '△ タイムゾーン: ' + tz + '(このままでも動きます。気になる時は SETUP.md の「タイムゾーンを日本にする」)');
  lines.push(code ? '→ 次は右上の「デプロイ」です(初めては「新しいデプロイ」、貼り替えた時は「デプロイを管理」→ 新バージョン)'
    : '→ 家族コードを追加したら、もう一度 setup を実行して ✓ になるか確かめてください');
  Logger.log(lines.join('\n'));
}

function familyCode() {
  var v = PropertiesService.getScriptProperties().getProperty('FAMILY_CODE');
  return v ? String(v).trim() : '';
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (!p.action) {
    return respond({ ok: true, message: 'Recording Health API', version: Core.VERSION, family_code: familyCode() ? '設定済み' : '未設定', time: new Date().toISOString() });
  }
  var req = {};
  Object.keys(p).forEach(function (k) { req[k] = p[k]; });
  if (p.payload) { try { Object.assign(req, JSON.parse(p.payload)); } catch (err) { /* 無視 */ } }
  if (p.action === 'need') {
    // ショートカットの最初の確認: いま眠りと歩数を送る必要があるか(1 日 1〜2 回にするため)
    var r = handleRequest(req);
    return ContentService.createTextOutput(r && r.ok ? r.send : 'yes').setMimeType(ContentService.MimeType.TEXT);
  }
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
    if (sh.getMaxColumns() < headers.length) sh.insertColumnsAfter(sh.getMaxColumns(), headers.length - sh.getMaxColumns());
    sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).setNumberFormat('@');
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

// 先頭の n 列を、空でない行だけ読む(n を省くと全部の列)
SheetStore.prototype.readRows = function (name, n) {
  var sh = this.sheet(name);
  var headers = Core.TABLES[name].slice(0, n || Core.TABLES[name].length);
  var rows = [];
  var lastRow = sh.getLastRow();
  if (lastRow >= 2) {
    var values = sh.getRange(2, 1, lastRow - 1, headers.length).getValues();
    for (var i = 0; i < values.length; i++) {
      var obj = rowObject(headers, values[i]);
      if (obj) { obj._row = i + 2; rows.push(obj); }
    }
  }
  return rows;
};

SheetStore.prototype.all = function (name) {
  if (!this.cache[name]) this.cache[name] = this.readRows(name);
  return this.cache[name];
};

// 先頭の n 列だけを読む(画像の一覧など、大きなデータの列まで読みたくない時)
SheetStore.prototype.head = function (name, n) {
  if (this.cache[name]) return this.cache[name];
  var key = name + '#' + n;
  if (!this.cache[key]) this.cache[key] = this.readRows(name, n);
  return this.cache[key];
};

// keyField が keyValue の行を 1 行だけ読む(全部は読まない)
SheetStore.prototype.find = function (name, keyField, keyValue) {
  var headers = Core.TABLES[name];
  var sh = this.sheet(name);
  var col = headers.indexOf(keyField) + 1;
  var lastRow = sh.getLastRow();
  if (col < 1 || lastRow < 2) return null;
  var keys = sh.getRange(2, col, lastRow - 1, 1).getValues();
  for (var i = 0; i < keys.length; i++) {
    if (String(keys[i][0]) === String(keyValue)) {
      var obj = rowObject(headers, sh.getRange(i + 2, 1, 1, headers.length).getValues()[0]) || {};
      obj._row = i + 2;
      return obj;
    }
  }
  return null;
};

// キャッシュを捨てる。keepAll のときは、全部の列を読んだキャッシュ(書き換えた行も反映ずみ)は残す
SheetStore.prototype.forget = function (name, keepAll) {
  var self = this;
  Object.keys(this.cache).forEach(function (k) {
    if (k.indexOf(name + '#') === 0 || (k === name && !keepAll)) delete self.cache[k];
  });
};

SheetStore.prototype.insert = function (name, obj) {
  var sh = this.sheet(name);
  var headers = Core.TABLES[name];
  var row = headers.map(function (h) { return toCell(obj[h]); });
  var r = sh.getLastRow() + 1;
  sh.getRange(r, 1, 1, headers.length).setNumberFormat('@').setValues([row]);
  this.forget(name);
};

SheetStore.prototype.update = function (name, keyField, keyValue, patch) {
  var headers = Core.TABLES[name];
  var found = null;
  if (this.cache[name]) {
    var rows = this.cache[name];
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][keyField]) === String(keyValue)) { found = rows[i]; break; }
    }
  } else {
    found = this.find(name, keyField, keyValue);
  }
  if (!found) return false;
  Object.keys(patch).forEach(function (k) { if (headers.indexOf(k) >= 0) found[k] = patch[k]; });
  var row = headers.map(function (h) { return toCell(found[h]); });
  this.sheet(name).getRange(found._row, 1, 1, headers.length).setNumberFormat('@').setValues([row]);
  this.forget(name, true);
  return true;
};

function rowObject(headers, values) {
  var obj = {}, empty = true;
  for (var c = 0; c < headers.length; c++) {
    var v = values[c];
    if (v instanceof Date) v = Utilities.formatDate(v, TIME_ZONE, "yyyy-MM-dd'T'HH:mm");
    if (v !== '' && v !== null && v !== undefined) empty = false;
    obj[headers[c]] = v;
  }
  return empty ? null : obj;
}

function toCell(v) {
  if (v === null || v === undefined) return '';
  if (v === true) return '1';
  if (v === false) return '0';
  if (typeof v === 'object') v = JSON.stringify(v);
  v = String(v);
  // = + - @ で始まる文字はスプレッドシートが数式として読もうとするので、先頭に ' を付けて文字のまま入れる
  // (' はセルに表示されず、読み出した値にも入らない)。-5 のような数字はそのまま
  if (/^[=+\-@]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v)) return "'" + v;
  return v;
}

/* =====================================================================
 * 2. Core — API 本体(プラットフォーム非依存)
 *
 *   Core.handle(req, store, env) -> レスポンスオブジェクト
 *     req   : { action, token, ...パラメータ }
 *     store : { all(table), insert(table,obj), update(table,keyField,keyValue,patch) }
 *             あれば head(table, n) と find(table, keyField, keyValue) も使う(大きな画像のデータを読まないため)
 *     env   : { familyCode, now(), today(), uuid(), sha256(str), randomToken() }
 *
 * 日付は「論理日」(午前4時区切り)の "YYYY-MM-DD" 文字列。時刻は "HH:MM"。
 * ===================================================================== */
var Core = (function () {
  var VERSION = 9;
  var IMAGE_PARTS = 10;       // 1 枚の画像を最大 10 個のセルに分けて入れる
  var IMAGE_CHUNK = 40000;    // 1 セルに入れる文字数(セルの上限は 50,000 文字)
  var IMAGE_META_COLS = 7;    // 画像の表の、データ以外の列の数
  var imageCols = ['id', 'name', 'mime', 'w', 'h', 'created_at', 'deleted'];
  for (var ic = 0; ic < IMAGE_PARTS; ic++) imageCols.push('d' + ic);

  var TABLES = {
    devices:      ['id', 'token_hash', 'role', 'name', 'created_at', 'last_seen'],
    // 家族の観察(1 日 1 行)。本人には何もたずねない
    observe:      ['date', 'wake_time', 'getup', 'gait', 'lying', 'outing', 'meal', 'movement',
                   'med_morning', 'med_extra', 'med_night', 'prn', 'alcohol',
                   'easy_times', 'good_note', 'complaint', 'complaint_note', 'recorded_by', 'updated_at',
                   // v4 で右に足した列(カテゴリーごとの備考、寝る前の間食、頓服の時刻)
                   'note_morning', 'note_day', 'note_meds', 'note_alcohol', 'night_snack', 'prn_times',
                   // v5: 仕事・習い事(会社出勤、残業、習い事、バレエ)
                   'activity'],
    // iPhone / Apple Watch から自動で届く値(1 日 1 行)。列は右に足していく(前の版のシートとそろえるため)
    health_daily: ['date', 'sleep_min', 'inbed_min', 'awakenings', 'deep_min', 'rem_min', 'bed_start', 'bed_end',
                   'steps', 'steadiness', 'resting_hr', 'hrv', 'move_score', 'source', 'updated_at', 'nap_min', 'walking_speed',
                   'walk_asym', 'double_support', 'step_length', 'metric_series'],
    memo:         ['id', 'date', 'ts', 'text', 'deleted', 'created_at'],
    reaction:     ['id', 'date', 'from_name', 'type', 'message', 'seen', 'created_at', 'label', 'image'],
    settings:     ['key', 'value'],
    image:        imageCols
  };

  var DEFAULT_SETTINGS = {
    app_title: '',                         // 記録する人の画面のタイトル(空なら「くまの記録」。本人の画面には出ない)
    patient_name: '',
    supporter_name: '',
    med2_label: '',                        // 3 つ目の薬のボタン名(空なら「朝の薬」「寝る前の薬」の 2 つだけ)
    next_appointment: '',
    last_appointment: '',
    report_note: '',                       // レポートの最初に印刷する、家族から先生へのひとこと
    card_order: '',                        // 記録画面のカテゴリーの並び順(カンマ区切り。空なら最初の並び)
    start_date: '2026-10-31',              // 記録の正式な開始日。これより前の日は記録・表示しない
    health_per_day: '2',                   // 眠りと歩数を自動で送る回数(1 = 朝4時以降に1回、2 = 朝4時〜と夕方4時〜に1回ずつ)
    health_shortcut_url: '',               // サポーターが作って共有したショートカットの iCloud リンク
    health_shortcut_name: 'KMヘルスチェック送信', // そのショートカットの名前(アプリから試しに実行するのに使う)
    health_consent: '0',                   // 本人の同意(1 = 同意している)。同意できるのは本人の端末だけ
    health_consent_at: '',
    health_consent_by: '',
    health_last_at: '',                    // 最後に健康データを保存した時刻と、その内容の短い説明
    health_last: '',
    health_try_at: '',                     // 同意の前に届いた(保存しなかった)試しの送信
    health_try: '',
    image_config: ''                       // サイトで選んだ画像とリアクションの種類(JSON)
  };
  // saveSettings では変えられない設定(それぞれ専用の操作でだけ変わる)
  var PROTECTED_SETTINGS = { health_consent: 1, health_consent_at: 1, health_consent_by: 1, health_last_at: 1, health_last: 1,
    health_try_at: 1, health_try: 1, image_config: 1 };
  // 本人の端末に渡す設定(記録の中身や、先生へのメモは渡さない)
  var PATIENT_SETTINGS = ['supporter_name', 'health_shortcut_url', 'health_shortcut_name', 'health_consent', 'health_consent_at', 'health_last_at', 'image_config'];

  // 観察の項目。数字の範囲は [最小, 最大]
  var OBS_SCALES = { getup: [0, 2], gait: [0, 2], lying: [0, 3], outing: [0, 2], meal: [0, 4], movement: [1, 5], alcohol: [0, 1], night_snack: [0, 1] };
  var OBS_SETS = { easy_times: ['morning', 'noon', 'evening', 'night'], complaint: ['pain', 'dizzy', 'other'],
    activity: ['work', 'overtime', 'lesson', 'ballet'] };
  // 備考: good_note = 楽そうだった時間・できたこと、complaint_note = 見た目と本人のことば、ほかはカテゴリーの名前どおり
  var OBS_TEXTS = { good_note: 500, complaint_note: 500, note_morning: 500, note_day: 500, note_meds: 500, note_alcohol: 500 };
  var MED_FIELDS = ['med_morning', 'med_extra', 'med_night'];
  // 薬: 朝は "all" (分けて書く薬も)全部 / "part" 一部 / "noc" その薬以外を飲んだ。夜は "yes" 飲んだ / "part" 一部 / "no" 飲まなかった。
  // 時刻は "all 08:10" のように後ろに付ける(v3 の朝の "yes" も読めるように残す)
  var MED_RE = /^(?:(?:yes|all|part|noc)(?: (?:[01]\d|2[0-3]):[0-5]\d)?|no)$/;
  var PRN_TIMES_RE = /^(?:(?:[01]\d|2[0-3]):[0-5]\d)(?:,(?:[01]\d|2[0-3]):[0-5]\d){0,19}$/;
  var SLOT_KEYS = ['title', 'loading', 'normal', 'sleepy', 'love', 'happy', 'role_patient', 'role_supporter'];
  var HEALTH_SCALARS = ['steadiness', 'resting_hr', 'hrv', 'move_score', 'walking_speed', 'walk_asym', 'double_support', 'step_length'];
  var HEALTH_TEXT = { steadiness: 1 };
  var SLEEP_FIELDS = ['sleep_min', 'inbed_min', 'awakenings', 'deep_min', 'rem_min', 'bed_start', 'bed_end', 'nap_min'];

  function isReactionType(s) { return typeof s === 'string' && /^[a-z0-9_-]{1,32}$/i.test(s); }

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
  function isHm(s) { return typeof s === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s); }
  function commas(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function md(ds) { var p = ds.split('-'); return parseInt(p[1], 10) + '/' + parseInt(p[2], 10); }

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
  function normObs(r) {
    var o = { date: toStr(r.date), wake_time: toStr(r.wake_time) };
    for (var k in OBS_SCALES) o[k] = toInt(r[k]);
    MED_FIELDS.forEach(function (f) { o[f] = toStr(r[f]); });
    o.prn = toInt(r.prn);
    o.prn_times = toStr(r.prn_times);
    for (var s in OBS_SETS) o[s] = toStr(r[s]);
    for (var t in OBS_TEXTS) o[t] = toStr(r[t]);
    o.recorded_by = toStr(r.recorded_by);
    o.updated_at = toStr(r.updated_at);
    return o;
  }
  function hasObs(o) {
    if (o.wake_time || o.complaint || o.easy_times || o.activity || o.prn_times || o.prn !== null) return true;
    for (var t in OBS_TEXTS) if (o[t]) return true;
    for (var k in OBS_SCALES) if (o[k] !== null) return true;
    for (var i = 0; i < MED_FIELDS.length; i++) if (o[MED_FIELDS[i]]) return true;
    return false;
  }
  function normHealth(r) {
    return {
      date: toStr(r.date), sleep_min: toInt(r.sleep_min), inbed_min: toInt(r.inbed_min), awakenings: toInt(r.awakenings),
      deep_min: toInt(r.deep_min), rem_min: toInt(r.rem_min), bed_start: toStr(r.bed_start) || null, bed_end: toStr(r.bed_end) || null,
      nap_min: toInt(r.nap_min), steps: toInt(r.steps), steadiness: toStr(r.steadiness) || null, walking_speed: toNum(r.walking_speed),
      walk_asym: toNum(r.walk_asym), double_support: toNum(r.double_support), step_length: toNum(r.step_length),
      metric_series: parseSeries(r.metric_series), // 1 日の中の時刻ごとの値(歩き方・心拍)
      resting_hr: toNum(r.resting_hr), hrv: toNum(r.hrv), move_score: toNum(r.move_score), source: toStr(r.source), updated_at: toStr(r.updated_at)
    };
  }
  function normMemo(r) {
    return { id: toStr(r.id), date: toStr(r.date), ts: toStr(r.ts), text: toStr(r.text), deleted: truthy(r.deleted) ? 1 : 0, created_at: toStr(r.created_at) };
  }
  function normReaction(r) {
    return { id: toStr(r.id), date: toStr(r.date), from_name: toStr(r.from_name), type: toStr(r.type), label: toStr(r.label), image: toStr(r.image),
      message: toStr(r.message), seen: truthy(r.seen) ? 1 : 0, created_at: toStr(r.created_at) };
  }
  function normImageMeta(r) {
    return { id: toStr(r.id), name: toStr(r.name), mime: toStr(r.mime), w: toInt(r.w), h: toInt(r.h),
      created_at: toStr(r.created_at), deleted: truthy(r.deleted) ? 1 : 0 };
  }

  // ---------- データ取得ヘルパー ----------
  function getSettings(store) {
    var out = {};
    for (var k in DEFAULT_SETTINGS) out[k] = DEFAULT_SETTINGS[k];
    store.all('settings').forEach(function (r) { if (!isBlank(r.key)) out[toStr(r.key)] = toStr(r.value); });
    return out;
  }
  function patientSettings(s) {
    var out = {};
    PATIENT_SETTINGS.forEach(function (k) { out[k] = s[k] === undefined ? '' : s[k]; });
    return out;
  }
  function settingsFor(device, store) {
    var s = getSettings(store);
    return device.role === 'supporter' ? s : patientSettings(s);
  }
  function setSetting(store, key, value) {
    var rows = store.all('settings');
    for (var i = 0; i < rows.length; i++) {
      if (toStr(rows[i].key) === key) {
        if (toStr(rows[i].value) !== value) store.update('settings', 'key', key, { value: value });
        return;
      }
    }
    store.insert('settings', { key: key, value: value });
  }
  function obsBetween(store, from, to) {
    return store.all('observe').map(normObs).filter(function (r) { return r.date >= from && r.date <= to; })
      .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
  }
  function healthBetween(store, from, to) {
    return store.all('health_daily').map(normHealth).filter(function (r) { return r.date >= from && r.date <= to; });
  }
  function memosBetween(store, from, to) {
    return store.all('memo').map(normMemo).filter(function (r) { return !r.deleted && r.date >= from && r.date <= to; })
      .sort(function (a, b) { return a.ts < b.ts ? -1 : 1; });
  }
  function imageMeta(store) {
    var rows = store.head ? store.head('image', IMAGE_META_COLS) : store.all('image');
    return rows.map(normImageMeta).filter(function (r) { return r.id && !r.deleted; });
  }
  function startDate(s) { return isDateStr(s.start_date) ? s.start_date : ''; }
  // 自動送信の「区切り」: 午前4時を日の境目にし、1日2回なら 4時〜16時 と 16時〜翌4時 に分ける
  function slotKey(ms, perDay) {
    var d = new Date(ms - 4 * 3600000);
    var key = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    return perDay === 2 ? key + (d.getHours() < 12 ? 'A' : 'B') : key;
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

  // ---------- ヘルスケアの値の集計 ----------
  // ショートカットの日付("2026-11-03 23:12" など、タイムゾーンなし)は日本時間として読む
  function parseWhen(s) {
    if (s instanceof Date) return s.getTime();
    if (typeof s === 'number') return s;
    if (!s) return NaN;
    var t = String(s).trim();
    // 「2026-11-14 23:05」「2026/11/14 23:05」「2026年11月14日土 23:05:00 +0900」「2026/11/14 午後11:05」などを、
    // その土地の時刻として読む(曜日や +0900 は読み飛ばす)
    var m = t.match(/^(\d{4})\D(\d{1,2})\D(\d{1,2})\D*?(午前|午後|AM|PM)?\s*(?:(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*(午前|午後|AM|PM)?(?:\s*[+-]\d{2}:?\d{2})?$/i);
    if (m) {
      var h = m[5] ? +m[5] : 0;
      var ap = String(m[4] || m[8] || '').toUpperCase();
      if ((ap === '午後' || ap === 'PM') && h < 12) h += 12;
      if ((ap === '午前' || ap === 'AM') && h === 12) h = 0;
      return new Date(+m[1], +m[2] - 1, +m[3], h, m[6] ? +m[6] : 0, m[7] ? +m[7] : 0).getTime();
    }
    return Date.parse(t);
  }
  function ymdOf(ms) { var d = new Date(ms); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function hm(ms) { var d = new Date(ms); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function sleepCategory(v) {
    if (v === null || v === undefined) return 'core';
    if (typeof v === 'number') return ['inbed', 'core', 'awake', 'core', 'deep', 'rem'][v] || 'core';
    var s = String(v).toLowerCase();
    if (/^\d+$/.test(s)) return sleepCategory(parseInt(s, 10));
    // iOS の版や言語で言葉が変わるので、ベッド内(就寝・就床)と起きている(覚醒・目が覚めた)は広めに拾う
    if (s.indexOf('bed') >= 0 || s.indexOf('ベッド') >= 0 || s.indexOf('就床') >= 0 || s.indexOf('就寝') >= 0) return 'inbed';
    if (s.indexOf('awake') >= 0 || s.indexOf('覚') >= 0 || s.indexOf('目覚') >= 0 || s.indexOf('起き') >= 0) return 'awake';
    if (s.indexOf('deep') >= 0 || s.indexOf('深') >= 0) return 'deep';
    if (s.indexOf('rem') >= 0 || s.indexOf('レム') >= 0) return 'rem';
    return 'core';
  }
  // 区間 [[開始,終了], ...] を重なりのない形にまとめる(iPhone と Watch の記録が重なっても二重に数えない)
  function union(list) {
    var a = list.slice().sort(function (x, y) { return x[0] - y[0]; });
    var out = [];
    a.forEach(function (iv) {
      var last = out[out.length - 1];
      if (last && iv[0] <= last[1]) { if (iv[1] > last[1]) last[1] = iv[1]; }
      else out.push([iv[0], iv[1]]);
    });
    return out;
  }
  function spanMin(list) { return list.reduce(function (a, iv) { return a + (iv[1] - iv[0]); }, 0) / 60000; }
  function clip(list, s, e) {
    return list.map(function (iv) { return [Math.max(iv[0], s), Math.min(iv[1], e)]; }).filter(function (iv) { return iv[1] > iv[0]; });
  }
  // 2 時間より長く空いたら別の眠り(昼寝など)とする
  function splitSessions(merged) {
    var out = [], cur = [];
    merged.forEach(function (iv) {
      if (cur.length && iv[0] - cur[cur.length - 1][1] > 2 * 3600000) { out.push(cur); cur = []; }
      cur.push(iv);
    });
    if (cur.length) out.push(cur);
    return out;
  }
  function longest(sessions) {
    var best = sessions[0];
    sessions.forEach(function (s) { if (spanMin(s) > spanMin(best)) best = s; });
    return best;
  }
  // 1 晩分(前日 18 時〜当日 18 時に始まった記録)の眠りをまとめる。いちばん長い眠りを「夜の眠り」、残りを昼寝などとする
  function summarizeNight(samples) {
    function pick(cats) {
      return union(samples.filter(function (s) { return cats.indexOf(s.cat) >= 0; }).map(function (s) { return [s.start, s.end]; }));
    }
    var asleep = pick(['core', 'deep', 'rem']);
    var inbed = pick(['inbed']);
    var out = {};
    SLEEP_FIELDS.forEach(function (f) { out[f] = null; });
    if (!asleep.length) {
      if (!inbed.length) return null;
      var ib = longest(splitSessions(inbed));
      out.inbed_min = Math.round(spanMin(ib));
      out.bed_start = hm(ib[0][0]);
      out.bed_end = hm(ib[ib.length - 1][1]);
      return out;
    }
    var main = longest(splitSessions(asleep));
    var ms = main[0][0], me = main[main.length - 1][1];
    out.sleep_min = Math.round(spanMin(main));
    out.nap_min = Math.round(spanMin(asleep) - spanMin(main));
    var aw = 0;
    for (var i = 1; i < main.length; i++) if (main[i][0] - main[i - 1][1] >= 5 * 60000) aw++; // 5 分以上目が覚めた回数
    out.awakenings = aw;
    var deep = pick(['deep']), rem = pick(['rem']);
    if (deep.length || rem.length) {
      out.deep_min = Math.round(spanMin(clip(deep, ms, me)));
      out.rem_min = Math.round(spanMin(clip(rem, ms, me)));
    }
    var ibc = clip(inbed, ms - 2 * 3600000, me + 2 * 3600000);
    out.inbed_min = Math.round(ibc.length ? spanMin(union(ibc.concat([[ms, me]]))) : (me - ms) / 60000);
    out.bed_start = hm(ms);
    out.bed_end = hm(me);
    return out;
  }
  // "開始|終了|値" を 1 行ずつ書いたテキスト(ショートカットで作りやすい)を配列へ
  function splitLines(text) {
    if (isBlank(text)) return [];
    // 区切りは半角の | かタブ。日本語キーボードで打ちやすい全角の ｜ も受け付ける
    return String(text).split(/\r?\n/).map(function (line) { return line.trim().split(/\s*[|\t｜]\s*/); })
      .filter(function (parts) { return parts.length >= 2 && parts[0]; });
  }
  function isSleepType(t) { t = toStr(t).toLowerCase(); return t.indexOf('sleep') === 0 || t === '睡眠' || t === '睡眠分析'; }
  function isStepsType(t) { t = toStr(t).toLowerCase(); return t === 'steps' || t === '歩数'; }
  function sleepSamplesFrom(req) {
    var raw = (Array.isArray(req.samples) ? req.samples : []).filter(function (s) { return s && isSleepType(s.type); });
    splitLines(req.sleep_lines).forEach(function (p) { raw.push({ start: p[0], end: p[1], value: p.length > 2 ? p[2] : null }); });
    return raw.map(function (s) { return { start: parseWhen(s.start), end: parseWhen(s.end), cat: sleepCategory(s.value) }; })
      .filter(function (s) { return !isNaN(s.start) && !isNaN(s.end) && s.end > s.start && s.end - s.start < 24 * 3600000; });
  }
  // 歩数は日ごと(0 時区切り)に足す。ショートカットで「日ごとにグループ化」すれば 1 日 1 行で届く
  function stepsByDate(req) {
    var out = {};
    function add(when, value) {
      var t = parseWhen(when), v = toNum(value);
      if (isNaN(t) || v === null) return;
      var d = ymdOf(t);
      out[d] = (out[d] || 0) + v;
    }
    splitLines(req.steps_lines).forEach(function (p) { add(p[0], p[p.length - 1]); });
    (Array.isArray(req.samples) ? req.samples : []).forEach(function (s) { if (s && isStepsType(s.type)) add(s.start, s.value); });
    return out;
  }
  // ---------- 歩き方・心拍(metrics_lines) ----------
  // 1 行 = 「種類|開始日|値|単位」。種類の名前は日本語でも英語でも読む。同じ日の値は平均する
  var METRIC_NAMES = [
    ['hrv', ['心拍変動', 'variability', 'hrv']],
    ['resting_hr', ['安静時心拍', 'resting heart']],
    ['walk_asym', ['非対称', 'asymmetry']],
    ['double_support', ['両足', 'double support']],
    ['step_length', ['歩幅', 'step length']],
    ['steadiness', ['安定性', 'steadiness']],
    ['walking_speed', ['歩行速度', '歩く速さ', 'walking speed']]
  ];
  function metricOf(name) {
    var t = toStr(name).toLowerCase();
    for (var i = 0; i < METRIC_NAMES.length; i++) {
      for (var j = 0; j < METRIC_NAMES[i][1].length; j++) if (t.indexOf(METRIC_NAMES[i][1][j]) >= 0) return METRIC_NAMES[i][0];
    }
    return '';
  }
  // 戻り値: byDate { 日付: { 項目: 平均 } }、raw { 項目: 届いた数 }、series { 日付: { 項目: [[時刻, 値], ...] } }
  function metricsByDate(req) {
    var acc = {}; // 項目 → [{ d, v, unit }]
    splitLines(req.metrics_lines).forEach(function (parts) {
      var key = '', when = NaN, value = null, unit = '';
      parts.forEach(function (x) {
        if (!key && metricOf(x)) { key = metricOf(x); return; }
        if (isNaN(when) && /\d{4}\D\d{1,2}\D\d{1,2}/.test(x)) { var t = parseWhen(x); if (!isNaN(t)) { when = t; return; } }
        if (value === null && toNum(x) !== null) { value = toNum(x); unit += ' ' + String(x).replace(/[\d.,\s-]/g, ''); return; }
        unit += ' ' + x;
      });
      if (!key || isNaN(when) || value === null) return;
      if (!acc[key]) acc[key] = [];
      acc[key].push({ d: ymdOf(when), t: hm(when), v: value, unit: unit.toLowerCase() });
    });
    // 割合(%)の項目は、0〜1 で届く iPhone と 0〜100 で届く iPhone があるので、どちらかを見分けて % にそろえる。
    // 両足支持時間(だいたい 20〜40%)と歩行安定性で見分け、無ければその項目の値の大きさで決める
    function allSmall(key) { return acc[key].every(function (x) { return x.v <= 1; }); }
    var fraction = acc.double_support ? allSmall('double_support') : acc.steadiness ? allSmall('steadiness') : null;
    var out = {}, raw = {}, series = {};
    Object.keys(acc).forEach(function (key) {
      var list = acc[key];
      raw[key] = list.length;
      var unitText = list.map(function (x) { return x.unit; }).join(' ');
      var scale = 1;
      if (key === 'walk_asym' || key === 'double_support' || key === 'steadiness') {
        // 1 を超える値があれば 0〜100 で届いている。無ければ、両足支持時間などで見分けた方に合わせる(それも無ければ 0〜1)
        var frac = !allSmall(key) ? false : fraction !== null ? fraction : true;
        scale = frac ? 100 : 1;
      } else if (key === 'step_length') {
        scale = /cm/.test(unitText) ? 1 : /in/.test(unitText) ? 2.54 : list.every(function (x) { return x.v < 3; }) ? 100 : 1; // m → cm
      } else if (key === 'walking_speed') {
        scale = /m\/s|m\/秒/.test(unitText) ? 3.6 : /mi/.test(unitText) ? 1.609 : 1; // km/時にそろえる
      } else if (key === 'hrv') {
        scale = list.every(function (x) { return x.v < 1; }) ? 1000 : 1; // 秒 → ミリ秒
      }
      list.forEach(function (x) {
        if (!series[x.d]) series[x.d] = {};
        (series[x.d][key] = series[x.d][key] || []).push([x.t, metricRound(key, x.v * scale)]);
      });
    });
    // 日ごとの平均は、時刻ごとの値から出す
    Object.keys(series).forEach(function (d) {
      series[d] = mergeSeries(null, series[d]);
      out[d] = seriesAverages(series[d]);
    });
    return { byDate: out, raw: raw, series: series };
  }
  // 項目ごとの小数の桁(歩く速さ 0.01、左右差・両足支持 0.1、ほかは整数)
  function metricRound(key, v) {
    var digits = key === 'walking_speed' ? 100 : (key === 'walk_asym' || key === 'double_support') ? 10 : 1;
    return Math.round(v * digits) / digits;
  }
  // 1 日の「時刻ごとの値」{ 項目: [[時刻, 値], ...] } を合わせる。同じ時刻・同じ値は 1 つにし、時刻順に並べる
  // (送るたびに過去 2 日分が届くので、前に届いた分と重ねても増えないように)
  var SERIES_MAX = 300; // 1 日 1 項目あたりの上限(セルに入る大きさにするため)
  function mergeSeries(a, b) {
    var out = {};
    [a, b].forEach(function (src) {
      if (!src || typeof src !== 'object') return;
      Object.keys(src).forEach(function (k) {
        if (!Array.isArray(src[k])) return;
        if (!out[k]) out[k] = {};
        src[k].forEach(function (p) { if (Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'number') out[k][p[0] + '|' + p[1]] = p; });
      });
    });
    var res = {};
    Object.keys(out).sort().forEach(function (k) {
      res[k] = Object.keys(out[k]).map(function (x) { return out[k][x]; })
        .sort(function (p, q) { return p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : p[1] - q[1]; }).slice(0, SERIES_MAX);
    });
    return res;
  }
  function seriesAverages(sr) {
    var out = {};
    Object.keys(sr).forEach(function (k) {
      if (!sr[k].length) return;
      out[k] = metricRound(k, sr[k].reduce(function (a, p) { return a + p[1]; }, 0) / sr[k].length);
    });
    return out;
  }
  function parseSeries(v) {
    if (isBlank(v)) return null;
    try { var o = JSON.parse(String(v)); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch (e) { return null; }
  }
  var METRIC_LABEL = { walking_speed: ['速さ', 'km/時'], step_length: ['歩幅', 'cm'], walk_asym: ['左右差', '%'], double_support: ['両足支持', '%'],
    steadiness: ['安定性', '%'], resting_hr: ['安静心拍', ''], hrv: ['心拍変動', 'ms'] };
  function describeMetrics(patches) {
    var ds = Object.keys(patches).sort();
    var parts = [];
    Object.keys(METRIC_LABEL).forEach(function (k) {
      var d = ds.filter(function (x) { return patches[x][k] !== undefined && patches[x][k] !== null; }).pop();
      if (d) parts.push(METRIC_LABEL[k][0] + ' ' + patches[d][k] + METRIC_LABEL[k][1]);
    });
    return parts.join('・');
  }

  function describeAll(patches) {
    var ds = Object.keys(patches).sort();
    var parts = [];
    var sd = ds.filter(function (d) { return patches[d].sleep_min !== null && patches[d].sleep_min !== undefined; }).pop();
    if (sd) {
      var p = patches[sd];
      parts.push(md(sd) + 'の眠り ' + Math.floor(p.sleep_min / 60) + '時間' + (p.sleep_min % 60) + '分' + (p.awakenings !== null && p.awakenings !== undefined ? '(目覚め ' + p.awakenings + '回)' : ''));
    }
    var std = ds.filter(function (d) { return patches[d].steps !== undefined; }).pop();
    if (std) parts.push(md(std) + 'の歩数 ' + commas(patches[std].steps) + '歩');
    var mt = describeMetrics(patches);
    if (mt) parts.push('歩き方・心拍 ' + mt);
    if (!parts.length && ds.length) parts.push(md(ds[ds.length - 1]) + 'の値 ' + Object.keys(patches[ds[ds.length - 1]]).length + '項目');
    return parts.length ? parts.join('、') : '数値なし';
  }

  // ---------- 各アクション ----------
  var actions = {};

  actions.ping = function (req, store, env) {
    return { ok: true, time: env.now(), version: VERSION };
  };

  actions.login = function (req, store, env) {
    if (!env.familyCode) throw fail('setup', 'サーバーの家族コードがまだ設定されていません(SETUP.md の 1-5)');
    if (String(req.code || '').trim() !== String(env.familyCode)) throw fail('bad_code', '家族コードが違います');
    var role = req.role === 'supporter' ? 'supporter' : 'patient';
    var token = env.randomToken();
    var now = env.now();
    var device = { id: env.uuid(), token_hash: env.sha256(token), role: role, name: toStr(req.name).slice(0, 30), created_at: now, last_seen: now };
    store.insert('devices', device);
    return { ok: true, token: token, role: role, name: device.name, settings: settingsFor(device, store) };
  };

  actions.me = function (req, store, env, device) {
    return { ok: true, role: device.role, name: device.name, settings: settingsFor(device, store) };
  };

  // 本人の画面(くまの部屋): まだ見ていないひとことと、画像の設定だけ
  actions.room = function (req, store, env, device) {
    var reactions = store.all('reaction').map(normReaction).filter(function (r) { return !r.seen; })
      .sort(function (a, b) { return a.created_at < b.created_at ? -1 : 1; }).slice(-5);
    return { ok: true, room: true, reactions: reactions, settings: patientSettings(getSettings(store)), images: imageMeta(store) };
  };

  // 記録する人の画面: その日の観察・自動の値・メモ
  actions.state = function (req, store, env, device) {
    var date = isDateStr(req.date) ? req.date : null;
    if (!date) throw fail('bad_request', 'date が必要です');
    var s = getSettings(store);
    var all = store.all('observe').map(normObs);
    var since = isDateStr(s.last_appointment) && s.last_appointment <= date ? s.last_appointment : addDays(date, -27);
    var sd = startDate(s);
    if (sd && since < sd) since = sd;
    if (since > date) since = date;
    var recorded = all.filter(function (r) { return r.date >= since && r.date <= date && hasObs(r); }).length;
    var sent = store.all('reaction').map(normReaction).sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; }).slice(0, 5);
    return {
      ok: true, date: date,
      obs: findOne(all, 'date', date),
      health: findOne(healthBetween(store, date, date), 'date', date),
      memos: memosBetween(store, date, date),
      sent: sent,
      progress: { since: since, recorded: recorded, days: daysBetween(since, date) + 1 },
      settings: s, images: imageMeta(store)
    };
  };

  actions.saveObs = function (req, store, env, device) {
    if (!isDateStr(req.date)) throw fail('bad_request', 'date が必要です');
    if (req.date > env.today()) throw fail('bad_request', '先の日付には記録できません');
    var sd = startDate(getSettings(store));
    if (sd && req.date < sd) throw fail('bad_request', '記録の開始日(' + md(sd) + ')より前の日には記録できません');
    var existing = findOne(store.all('observe').map(normObs), 'date', req.date);
    var row = existing ? existing : normObs({ date: req.date });
    var changed = false;
    function set(k, v) { if (row[k] !== v) { row[k] = v; changed = true; } }
    if ('wake_time' in req) {
      var w = toStr(req.wake_time).trim();
      if (w && !isHm(w)) throw fail('bad_request', '起きてきた時刻は 07:30 の形です');
      set('wake_time', w);
    }
    for (var k in OBS_SCALES) {
      if (!(k in req)) continue;
      var n = toInt(req[k]);
      if (n !== null && (n < OBS_SCALES[k][0] || n > OBS_SCALES[k][1])) throw fail('bad_request', k + ' の値が範囲の外です');
      set(k, n);
    }
    MED_FIELDS.forEach(function (f) {
      if (!(f in req)) return;
      var v = toStr(req[f]).trim();
      if (v && !MED_RE.test(v)) throw fail('bad_request', '薬の記録の形が正しくありません');
      set(f, v);
    });
    if ('prn_times' in req) {
      // 頓服を飲んだ時刻の一覧("13:20,18:05")。回数は時刻の数
      var pt = (Array.isArray(req.prn_times) ? req.prn_times.join(',') : toStr(req.prn_times)).replace(/\s/g, '');
      if (pt && !PRN_TIMES_RE.test(pt)) throw fail('bad_request', '頓服の時刻の形が正しくありません');
      set('prn_times', pt);
      set('prn', pt ? pt.split(',').length : null);
    } else if ('prn' in req) {
      var p = toInt(req.prn);
      if (p !== null && (p < 0 || p > 20)) throw fail('bad_request', '頓服の回数が範囲の外です');
      set('prn', p);
    }
    for (var sk in OBS_SETS) {
      if (!(sk in req)) continue;
      var vals = (Array.isArray(req[sk]) ? req[sk] : toStr(req[sk]).split(',')).map(function (v) { return toStr(v).trim(); });
      if (sk === 'activity' && vals.indexOf('overtime') >= 0 && vals.indexOf('work') < 0) vals.push('work'); // 残業は出勤した日だけ
      set(sk, OBS_SETS[sk].filter(function (a) { return vals.indexOf(a) >= 0; }).join(',')); // 決まった順に並べる
    }
    for (var tk in OBS_TEXTS) if (tk in req) set(tk, toStr(req[tk]).trim().slice(0, OBS_TEXTS[tk]));
    if (!changed) return { ok: true, obs: row };
    row.recorded_by = device.name;
    row.updated_at = env.now();
    if (existing) store.update('observe', 'date', req.date, row); else store.insert('observe', row);
    return { ok: true, obs: row };
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

  // iPhone のショートカット(連携キー)から届く健康データ。
  // 何度届いてもよい: 眠りは前より短い計算結果では上書きせず、歩数は大きい方を残す
  actions.health = function (req, store, env, device) {
    // ショートカットのキー名の打ち間違い(s の付け忘れ)も受け付ける
    if (isBlank(req.steps_lines) && !isBlank(req.step_lines)) req.steps_lines = req.step_lines;
    if (isBlank(req.sleep_lines) && !isBlank(req.sleep_line)) req.sleep_lines = req.sleep_line;
    var today = env.today();
    var oldest = addDays(today, -31);
    var patches = {};
    function patchFor(d) { if (!patches[d]) patches[d] = {}; return patches[d]; }
    var sd = startDate(getSettings(store));
    function inRange(d) { return d >= oldest && d <= today && (!sd || d >= sd); }

    var nights = {};
    sleepSamplesFrom(req).forEach(function (s) {
      var d = ymdOf(s.start + 6 * 3600000); // 18 時を区切りに「どの日の朝の眠りか」を決める
      if (!nights[d]) nights[d] = [];
      nights[d].push(s);
    });
    Object.keys(nights).forEach(function (d) {
      if (!inRange(d)) return; // 今まさに寝ている途中の夜(明日の分)は、明日の送信で入る
      var n = summarizeNight(nights[d]);
      if (n) { var p = patchFor(d); SLEEP_FIELDS.forEach(function (f) { p[f] = n[f]; }); }
    });
    var steps = stepsByDate(req);
    Object.keys(steps).forEach(function (d) { if (inRange(d)) patchFor(d).steps = Math.round(steps[d]); });
    if (!Object.keys(steps).length && !isBlank(req.steps) && toNum(req.steps) !== null) patchFor(today).steps = Math.round(toNum(req.steps));
    var metrics = metricsByDate(req);
    Object.keys(metrics.byDate).forEach(function (d) {
      if (!inRange(d)) return;
      var m = metrics.byDate[d];
      Object.keys(m).forEach(function (k) { patchFor(d)[k] = k === 'steadiness' ? String(m[k]) : m[k]; });
      patchFor(d).metric_series = metrics.series[d];
    });
    HEALTH_SCALARS.forEach(function (f) {
      if (!(f in req) || isBlank(req[f])) return;
      var v = HEALTH_TEXT[f] ? toStr(req[f]).slice(0, 40) : toNum(req[f]);
      if (v !== null && v !== '') patchFor(today)[f] = v;
    });
    if (!Object.keys(patches).length) {
      throw fail('bad_request', '取り込めるデータがありません(Apple Watch を着けて寝た翌朝に、もう一度試してください)');
    }
    var summary = describeAll(patches);
    // ショートカット(連携キー)からの送信は、本人が「同意」している時だけ保存する
    if (device.role === 'health' && getSettings(store).health_consent !== '1') {
      // 試しの送信では、眠りの段階の数と届いた 1 行目も残す(ショートカットが正しく作れたかを、記録する人が確かめるため)
      var cats = { core: 0, deep: 0, rem: 0, awake: 0, inbed: 0 };
      var catNames = { core: 'コア', deep: '深い', rem: 'レム', awake: '覚醒', inbed: 'ベッド内' };
      sleepSamplesFrom(req).forEach(function (s) { cats[s.cat]++; });
      var stages = Object.keys(cats).filter(function (k) { return cats[k]; }).map(function (k) { return catNames[k] + cats[k]; }).join(' ');
      var firstSleep = toStr(req.sleep_lines).split(/\r?\n/)[0].slice(0, 60);
      var firstSteps = toStr(req.steps_lines).split(/\r?\n/)[0].slice(0, 40);
      var firstMetric = toStr(req.metrics_lines).split(/\r?\n/)[0].slice(0, 70);
      var counts = Object.keys(metrics.raw).map(function (k) { return METRIC_LABEL[k][0] + metrics.raw[k]; }).join(' ');
      var detail = (stages ? ' / 眠りの段階: ' + stages : '') + (firstSleep ? ' / 眠りの1行目: ' + firstSleep : '') + (firstSteps ? ' / 歩数の1行目: ' + firstSteps : '') +
        (counts ? ' / 歩き方・心拍の件数: ' + counts : '') + (firstMetric ? ' / 歩き方・心拍の1行目: ' + firstMetric : '');
      setSetting(store, 'health_try_at', env.now());
      setSetting(store, 'health_try', summary + detail);
      return { ok: false, error: 'no_consent', preview: patches, message: '本人の同意がまだないので、保存しませんでした。読み取れた内容: ' + summary };
    }

    var rows = store.all('health_daily').map(normHealth);
    var saved = [];
    Object.keys(patches).sort().forEach(function (d) {
      var p = patches[d];
      var ex = findOne(rows, 'date', d);
      var write = {};
      if ('sleep_min' in p) {
        var exSleep = ex ? ex.sleep_min : null;
        var useSleep = p.sleep_min !== null
          ? (exSleep === null || p.sleep_min >= exSleep)
          : (exSleep === null && (!ex || ex.inbed_min === null || p.inbed_min >= ex.inbed_min));
        if (useSleep) SLEEP_FIELDS.forEach(function (f) { if (!ex || ex[f] !== p[f]) write[f] = p[f]; });
      }
      if ('steps' in p && (!ex || ex.steps === null || p.steps > ex.steps)) write.steps = p.steps;
      if (p.metric_series) {
        // 前に届いた時刻ごとの値と合わせ、その日の平均も全部から出し直す
        var merged = mergeSeries(ex ? ex.metric_series : null, p.metric_series);
        var json = JSON.stringify(merged);
        if (!ex || JSON.stringify(ex.metric_series) !== json) write.metric_series = json;
        var avgs = seriesAverages(merged);
        Object.keys(avgs).forEach(function (k) { p[k] = k === 'steadiness' ? String(avgs[k]) : avgs[k]; });
      }
      HEALTH_SCALARS.forEach(function (f) { if (f in p && (!ex || ex[f] !== p[f])) write[f] = p[f]; });
      if (!Object.keys(write).length) return;
      write.source = toStr(req.source).slice(0, 20) || device.role;
      write.updated_at = env.now();
      if (ex) store.update('health_daily', 'date', d, write);
      else { write.date = d; store.insert('health_daily', write); }
      saved.push(d);
    });
    setSetting(store, 'health_last_at', env.now());
    setSetting(store, 'health_last', summary);
    return { ok: true, dates: saved, message: summary + ' を受け取りました' };
  };

  // ショートカットの最初の確認。同じ「区切り」の中ですでに受け取っていれば "no"(送らなくてよい)
  // 同意の前(試しの送信)と、まだ一度も受け取っていない時は、いつでも "yes"
  actions.need = function (req, store, env, device) {
    var s = getSettings(store);
    if (s.health_consent !== '1' || !s.health_last_at) return { ok: true, send: 'yes' };
    var last = Date.parse(s.health_last_at);
    if (isNaN(last)) return { ok: true, send: 'yes' };
    var per = s.health_per_day === '1' ? 1 : 2;
    return { ok: true, send: slotKey(Date.parse(env.now()), per) === slotKey(last, per) ? 'no' : 'yes' };
  };

  // ヘルスケア連携の同意(agree: 1)と取り消し(agree: 0)。同意できるのは本人の端末だけ。止めるのは家族もできる
  actions.consentHealth = function (req, store, env, device) {
    var agree = truthy(req.agree);
    if (agree && device.role !== 'patient') throw fail('forbidden', '同意は本人の iPhone で行います');
    setSetting(store, 'health_consent', agree ? '1' : '0');
    setSetting(store, 'health_consent_at', env.now());
    setSetting(store, 'health_consent_by', device.name);
    return { ok: true, settings: settingsFor(device, store) };
  };

  actions.react = function (req, store, env, device) {
    if (!isReactionType(req.type)) throw fail('bad_request', 'type が不正です');
    // label / image は送信時の見た目の控え(種類を消した後でも、本人の画面で同じように表示できるようにする)
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
      setSetting(store, k, toStr(s[k]).slice(0, 2000));
    }
    return { ok: true, settings: getSettings(store) };
  };

  actions.report = function (req, store, env, device) {
    var to = isDateStr(req.to) ? req.to : env.today();
    var from = isDateStr(req.from) ? req.from : addDays(to, -41);
    var sd = startDate(getSettings(store));
    if (sd && from < sd) from = sd;
    if (from > to) from = to;
    if (daysBetween(from, to) > 400) throw fail('bad_request', '期間が長すぎます');
    return {
      ok: true, from: from, to: to,
      obs: obsBetween(store, from, to), health: healthBetween(store, from, to), memos: memosBetween(store, from, to),
      settings: getSettings(store)
    };
  };

  actions.createKey = function (req, store, env, device) {
    var token = env.randomToken();
    var now = env.now();
    store.insert('devices', { id: env.uuid(), token_hash: env.sha256(token), role: 'health', name: toStr(req.name) || 'ヘルスケア連携', created_at: now, last_seen: now });
    return { ok: true, token: token };
  };

  // ---------- 画像(サイトから登録したもの。スプレッドシートの image シートに入る) ----------
  actions.getImage = function (req, store, env, device) {
    var id = toStr(req.id);
    if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) throw fail('bad_request', 'id が不正です');
    var r = store.find ? store.find('image', 'id', id) : findOne(store.all('image'), 'id', id);
    if (!r || truthy(r.deleted)) throw fail('not_found', '画像が見つかりません');
    var b64 = '';
    for (var i = 0; i < IMAGE_PARTS; i++) b64 += toStr(r['d' + i]).replace(/^~/, '');
    return { ok: true, id: id, mime: toStr(r.mime), data: 'data:' + toStr(r.mime) + ';base64,' + b64 };
  };

  actions.uploadImage = function (req, store, env, device) {
    var m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+\/]+=*)$/.exec(toStr(req.data));
    if (!m) throw fail('bad_request', '画像の形式が読めません(PNG・JPEG・WebP・GIF)');
    var b64 = m[2];
    if (b64.length > IMAGE_PARTS * IMAGE_CHUNK) throw fail('too_large', '画像が大きすぎます(約 300KB まで)');
    if (imageMeta(store).length >= 100) throw fail('too_many', '登録できる画像は 100 枚までです。使っていない画像を消してください');
    var row = { id: env.uuid(), name: toStr(req.name).trim().slice(0, 30) || '画像', mime: m[1],
      w: toInt(req.w), h: toInt(req.h), created_at: env.now(), deleted: 0 };
    for (var i = 0; i < IMAGE_PARTS; i++) {
      var c = b64.slice(i * IMAGE_CHUNK, (i + 1) * IMAGE_CHUNK);
      row['d' + i] = c ? '~' + c : ''; // 先頭の ~ は、+ や = で始まる文字を数式と間違えさせないための印
    }
    store.insert('image', row);
    return { ok: true, image: normImageMeta(row) };
  };

  actions.deleteImage = function (req, store, env, device) {
    var id = toStr(req.id);
    var patch = { deleted: 1 };
    for (var i = 0; i < IMAGE_PARTS; i++) patch['d' + i] = '';
    if (!id || !store.update('image', 'id', id, patch)) throw fail('not_found', '画像が見つかりません');
    return { ok: true };
  };

  // 画面のどこにどの画像を出すか(slots)と、リアクションの種類(reactions)
  actions.saveImageConfig = function (req, store, env, device) {
    var c = req.config || {};
    var out = {};
    if (c.slots && typeof c.slots === 'object') {
      out.slots = {};
      SLOT_KEYS.forEach(function (k) { if (typeof c.slots[k] === 'string') out.slots[k] = c.slots[k].slice(0, 80); });
    }
    if (Array.isArray(c.reactions)) {
      var seen = {};
      out.reactions = c.reactions.filter(function (r) {
        if (!r || !isReactionType(r.id) || seen[r.id]) return false;
        seen[r.id] = 1;
        return true;
      }).slice(0, 40).map(function (r) {
        return { id: String(r.id), label: toStr(r.label).trim().slice(0, 30) || String(r.id), image: toStr(r.image).slice(0, 80) };
      });
    }
    setSetting(store, 'image_config', JSON.stringify(out));
    return { ok: true, settings: getSettings(store) };
  };

  // 役割ごとに許可するアクション。
  // patient(本人): くまの部屋を見る・ひとことに「ありがとう」・連携の同意だけ。記録は読めない
  // health(ショートカットの連携キー): 健康データを送ることだけ
  var ALLOW = {
    patient:   ['me', 'room', 'seenReactions', 'consentHealth', 'getImage'],
    supporter: ['me', 'state', 'saveObs', 'addMemo', 'deleteMemo', 'react', 'reactions', 'getSettings', 'saveSettings', 'report',
                'createKey', 'consentHealth', 'getImage', 'uploadImage', 'deleteImage', 'saveImageConfig'],
    health:    ['health', 'need']
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

  return { VERSION: VERSION, TABLES: TABLES, DEFAULT_SETTINGS: DEFAULT_SETTINGS, handle: handle, addDays: addDays, summarizeNight: summarizeNight };
})();
