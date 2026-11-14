/* report.js — 医師に見せる期間レポート(印刷→PDF)
 * アプリ(index.html)と同じ端末・ブラウザのログイン情報(localStorage)を使う。記録する人(家族)のログインが必要。 */
(function () {
  'use strict';
  const cfg = (() => { try { return JSON.parse(localStorage.getItem('kuma.cfg') || '{}'); } catch (e) { return {}; } })();
  // config.js の URL を使う。PC のローカル確認(localhost)ではアプリと同じくローカルの API のまま
  const isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  if (!isLocal && window.KUMA_CONFIG && window.KUMA_CONFIG.apiUrl) cfg.apiUrl = String(window.KUMA_CONFIG.apiUrl).trim();
  const pad = (n) => String(n).padStart(2, '0');
  const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const logicalToday = () => fmtDate(new Date(Date.now() - 4 * 3600e3));
  function addDays(ds, n) { const [y, m, d] = ds.split('-').map(Number); return fmtDate(new Date(y, m - 1, d + n)); }
  function daysBetween(a, b) { const [y1, m1, d1] = a.split('-').map(Number); const [y2, m2, d2] = b.split('-').map(Number); return Math.round((new Date(y2, m2 - 1, d2) - new Date(y1, m1 - 1, d1)) / 86400e3); }
  const DOW = ['日', '月', '火', '水', '木', '金', '土'];
  function dowOf(ds) { const [y, m, d] = ds.split('-').map(Number); return new Date(y, m - 1, d).getDay(); }
  const jp = (ds) => { const [y, m, d] = ds.split('-').map(Number); return `${y}年${m}月${d}日`; };
  const md = (ds) => { const [, m, d] = ds.split('-').map(Number); return `${m}/${d}`; };
  const hhmm = (t) => (t && t.length >= 16 ? t.slice(11, 16) : '');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // 家族の観察の項目(アプリの app.js と同じ意味)
  const SC = {
    getup:  { label: '起き上がり', names: ['スムーズ', 'ゆっくり', 'つらそう'], order: [0, 1, 2], sym: ['○', '△', '×'] },
    gait:   { label: '歩き方のふらつき', names: ['なし', '少し', '目立つ'], order: [0, 1, 2], sym: ['○', '△', '×'] },
    lying:  { label: '横になっていた時間', names: ['ほとんどなし', '2〜3時間', '半日くらい', 'ほぼ一日'], order: [0, 1, 2, 3], sym: ['少', '2-3h', '半日', '一日'] },
    outing: { label: '外出', names: ['なし', '近所だけ', '外出できた'], order: [2, 1, 0], sym: ['–', '近', '外'] },
    meal:   { label: '食事の量', names: ['ほぼ食べず', '少し', '半分くらい', 'ふつう', 'よく食べた'], order: [4, 3, 2, 1, 0], sym: ['×', '少', '半', '普', '多'] }
  };
  const MOVE = { 1: 'ほぼなし', 2: '少し', 3: '中くらい', 4: '強い', 5: 'とても強い' };
  const EASY = [['morning', '朝'], ['noon', '昼'], ['evening', '夕方'], ['night', '夜']];
  const COMPLAINT = [['pain', '痛み'], ['dizzy', 'ぐるぐる'], ['other', 'その他']];
  const ACT_SYM = [['work', '出'], ['overtime', '残'], ['lesson', '習'], ['ballet', 'バ']];
  const MED_SYM = { all: '●', yes: '●', noc: '◐', part: '◔', no: '○' };
  // "all 08:10" → { st: 'all', t: '08:10' }。前の版の朝の "yes" は「全部飲んだ」として読む
  const parseMed = (v, morning) => { const [st0, t] = String(v || '').split(' '); return { st: morning && st0 === 'yes' ? 'all' : (st0 || ''), t: t || '' }; };
  const prnList = (o) => String((o && o.prn_times) || '').split(',').filter(Boolean);
  // カテゴリーごとの備考(記録の画面の並びと同じ)
  const NOTES = [['note_morning', '朝'], ['note_day', '日中'], ['note_meds', '薬'], ['note_alcohol', 'アルコール']];
  const setOf = (v) => new Set(String(v || '').split(',').filter(Boolean));

  const page = document.getElementById('page');
  const params = new URLSearchParams(location.search);
  const fromEl = document.getElementById('from'); const toEl = document.getElementById('to');
  toEl.value = params.get('to') || logicalToday();
  fromEl.value = params.get('from') || addDays(toEl.value, -41);
  document.getElementById('apply').addEventListener('click', () => { history.replaceState(null, '', `?from=${fromEl.value}&to=${toEl.value}`); run(); });
  document.getElementById('print').addEventListener('click', () => window.print());

  async function api(req) {
    const res = await fetch(cfg.apiUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(Object.assign({}, req, { token: cfg.token })), redirect: 'follow' });
    return res.json();
  }

  async function run() {
    if (!cfg.apiUrl || !cfg.token) { page.innerHTML = '<p class="empty">先にアプリ(index.html)で「記録する人」としてログインしてください。レポートは同じブラウザで開く必要があります。</p>'; return; }
    const from = fromEl.value, to = toEl.value;
    if (!from || !to || from > to) { page.innerHTML = '<p class="empty">期間を確認してください。</p>'; return; }
    page.innerHTML = '<p class="empty">読み込んでいます…</p>';
    let data;
    try { data = await api({ action: 'report', from, to }); } catch (e) { page.innerHTML = '<p class="empty">通信できませんでした。</p>'; return; }
    if (!data.ok) { page.innerHTML = `<p class="empty">${esc(data.error === 'forbidden' ? 'レポートは「記録する人」のログインで開きます。' : (data.message || data.error))}</p>`; return; }
    fromEl.value = data.from; toEl.value = data.to; // 記録の開始日より前は出さない(サーバーが期間を直す)
    render(data);
  }

  function render(data) {
    const days = [];
    const n = daysBetween(data.from, data.to) + 1;
    const idx = {};
    for (let i = 0; i < n; i++) { const d = addDays(data.from, i); idx[d] = days.length; days.push({ date: d, o: null, health: null, memos: [] }); }
    data.obs.forEach((o) => { if (o.date in idx) days[idx[o.date]].o = o; });
    data.health.forEach((h) => { if (h.date in idx) days[idx[h.date]].health = h; });
    data.memos.forEach((m) => { if (m.date in idx) days[idx[m.date]].memos.push(m); });

    const s = data.settings || {};
    const mn = String(s.med2_label || '').trim() || '別の薬';
    const MEDS = [
      ['med_morning', '朝の薬', [['all', `${mn}全部飲んだ`], ['part', `${mn}一部飲んだ`], ['noc', `${mn}以外飲んだ`]]],
      ['med_night', '寝る前の薬', [['yes', '飲んだ'], ['part', '一部'], ['no', '飲まなかった']]]
    ];
    const avg = (arr) => (arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length) : null);
    const f1 = (v) => (v == null ? '–' : (Math.round(v * 10) / 10).toFixed(1));
    const hm = (min) => (min == null ? '–' : `${Math.floor(min / 60)}時間${pad(Math.round(min % 60))}分`);
    const vals = (get) => days.map(get).filter((v) => v != null);
    const obsDays = days.filter((d) => d.o).length;

    const move = vals((d) => (d.o && d.o.movement != null ? d.o.movement : null));
    const sleep = vals((d) => (d.health && d.health.sleep_min != null ? d.health.sleep_min : null));
    const awak = vals((d) => (d.health && d.health.awakenings != null ? d.health.awakenings : null));
    const naps = vals((d) => (d.health && d.health.nap_min ? d.health.nap_min : null));
    const steps = vals((d) => (d.health && d.health.steps != null ? d.health.steps : null));
    // 歩き方・心拍(iPhone / Apple Watch)。値のある日だけ平均する
    const hv = (k) => vals((d) => (d.health && d.health[k] != null && d.health[k] !== '' && !isNaN(Number(d.health[k])) ? Number(d.health[k]) : null));
    const GAIT = [['walking_speed', '歩く速さ', 'km/時', 2], ['step_length', '歩幅', 'cm', 0], ['walk_asym', '左右差(歩行非対称性)', '%', 1],
      ['double_support', '両足支持時間', '%', 1], ['steadiness', '歩行安定性', '%', 0]];
    const HEART = [['resting_hr', '安静時心拍数', '回/分', 0], ['hrv', '心拍変動', 'ms', 0]];
    const rnd = (v, dg) => (Math.round(v * Math.pow(10, dg)) / Math.pow(10, dg)).toFixed(dg);
    const metricText = (list) => list.map(([k, l, u, dg]) => { const a = hv(k); return a.length ? `${l} ${rnd(avg(a), dg)}${u} <small>(${a.length}日)</small>` : ''; }).filter(Boolean).join(' / ');
    const gaitText = metricText(GAIT), heartText = metricText(HEART);
    // 1 日の中の変化: 時刻ごとの値(metric_series)から
    const GAIT3 = [['walking_speed', '歩く速さ', 'km/時', 2], ['walk_asym', '左右差(歩行非対称性)', '%', 1], ['double_support', '両足支持時間', '%', 1]];
    const seriesOf = (d, k) => (d.health && d.health.metric_series && Array.isArray(d.health.metric_series[k]) ? d.health.metric_series[k] : []);
    const hmToH = (t) => { const [h, m] = String(t).split(':').map(Number); return h + m / 60; };
    const dayRanges = (k) => days.map((d) => seriesOf(d, k)).filter((sr) => sr.length >= 2).map((sr) => { const vs = sr.map((p) => p[1]); return Math.max(...vs) - Math.min(...vs); });
    const rangeSummary = GAIT3.map(([k, l, u, dg]) => { const rs = dayRanges(k); return rs.length ? `${l} ${rnd(avg(rs), dg)}${u} <small>(${rs.length}日)</small>` : ''; }).filter(Boolean).join(' / ');
    const medHour = (d) => { if (!d.o) return null; const m = parseMed(d.o.med_morning, true); return (m.st === 'all' || m.st === 'part') && m.t ? hmToH(m.t) : null; };
    const samplesOf = (k) => days.flatMap((d) => seriesOf(d, k).map((p) => ({ d, h: hmToH(p[0]), v: p[1] })));
    const TOD = [[0, 6, '0–6'], [6, 9, '6–9'], [9, 12, '9–12'], [12, 15, '12–15'], [15, 18, '15–18'], [18, 21, '18–21'], [21, 24, '21–24']];
    const SINCE = [[-24, 0, '飲む前'], [0, 2, '0–2'], [2, 4, '2–4'], [4, 6, '4–6'], [6, 8, '6–8'], [8, 10, '8–10'], [10, 12, '10–12'], [12, 24, '12〜']];
    const binsOf = (list, defs, at) => defs.map(([a, b, label]) => {
      const vs = list.filter((x) => { const h = at(x); return h != null && h >= a && h < b; }).map((x) => x.v);
      return { label, n: vs.length, v: vs.length ? avg(vs) : null };
    });
    let profileIds = [];
    const profiles = GAIT3.map(([k, l, u, dg], i) => {
      const list = samplesOf(k);
      const tod = binsOf(list, TOD, (x) => x.h);
      if (list.length < 6 || tod.filter((b) => b.v != null).length < 2) return '';
      const since = binsOf(list, SINCE, (x) => { const mh = medHour(x.d); return mh == null ? null : x.h - mh; });
      const fmt = (v) => rnd(v, dg);
      const idA = `p${i}a`, idB = `p${i}b`;
      profileIds.push([idA, tod, fmt, u], [idB, since, fmt, u]);
      const right = since.filter((b) => b.v != null).length >= 2
        ? profileChart(since, { label: `${l}(${u})`, note: `朝の薬(${mn})を飲んでからの時間`, fmt }, idB)
        : `<p class="empty">朝の薬の時刻が記録された日のデータが、まだ足りません。</p>`;
      return `<div class="pair avoid"><div>${profileChart(tod, { label: `${l}(${u})`, note: '時刻(時)', fmt }, idA)}</div><div>${right}</div></div>`;
    }).join('');
    const wakes = vals((d) => (d.o && d.o.wake_time ? d.o.wake_time : null));
    const minutes = (t) => { let [h, m] = t.split(':').map(Number); if (h < 4) h += 24; return h * 60 + m; };
    const clock = (v) => `${pad(Math.floor(v / 60) % 24)}:${pad(v % 60)}`;
    const wakeText = wakes.length ? (() => { const ms = wakes.map(minutes).sort((a, b) => a - b); return `中央値 ${clock(ms[Math.floor(ms.length / 2)])} <small>(早い日 ${clock(ms[0])} 〜 遅い日 ${clock(ms[ms.length - 1])}、記録 ${ms.length}日)</small>`; })() : '–';
    const dist = (key) => {
      const def = SC[key];
      const c = days.filter((d) => d.o && d.o[key] != null);
      if (!c.length) return '–';
      return def.order.map((v) => `${def.names[v]} ${c.filter((d) => d.o[key] === v).length}日`).join(' / ') + ` <small>(記録 ${c.length}日)</small>`;
    };
    const medRow = ([f, label, states]) => {
      const cnt = {}; states.forEach(([k]) => { cnt[k] = 0; });
      days.forEach((d) => { const st = d.o ? parseMed(d.o[f], f === 'med_morning').st : ''; if (st in cnt) cnt[st]++; });
      const none = n - Object.values(cnt).reduce((a, b) => a + b, 0);
      return `${esc(label)}: ${states.map(([k, l]) => `${esc(l)} ${cnt[k]}日`).join(' / ')} <small>/ 記録なし ${none}日</small>`;
    };
    const prnTotal = days.reduce((a, d) => a + (d.o ? Math.max(d.o.prn || 0, prnList(d.o).length) : 0), 0);
    const snackDays = days.filter((d) => d.o && d.o.night_snack === 1).length;
    const actDays = (k) => days.filter((d) => d.o && setOf(d.o.activity).has(k)).length;
    const alcoholDays = days.filter((d) => d.o && d.o.alcohol === 1).length;
    const alcoholKnown = days.filter((d) => d.o && d.o.alcohol != null).length;
    const countSet = (key, list) => list.map(([k, l]) => `${l} ${days.filter((d) => d.o && setOf(d.o[key]).has(k)).length}日`).join(' / ');

    const header = `<h1>からだの記録 ${jp(data.from)} 〜 ${jp(data.to)}</h1>
      <div class="meta">${s.patient_name ? `<span>氏名: ${esc(s.patient_name)}</span>` : ''}<span>期間: ${n}日(観察の記録 ${obsDays}日)</span><span>作成: ${jp(logicalToday())}</span></div>
      <p class="src">記録の方法: 家族が見て分かることを毎日記録(本人には症状をたずねていません)+ Apple Watch / iPhone ヘルスケアの自動の値。</p>`;
    const note = s.report_note ? `<div class="note avoid"><b>家族から先生へ</b><p>${esc(s.report_note).replace(/\n/g, '<br>')}</p></div>` : '';

    const summary = `<h2>まとめ</h2><table class="summary avoid">
      <tr><th>不随意運動の見た目(家族の評価 1–5)</th><td>平均 ${f1(avg(move))} <small>(最大 ${move.length ? Math.max(...move) : '–'}、記録 ${move.length}日 / 1 ほぼなし 〜 5 とても強い)</small></td></tr>
      <tr><th>起き上がり</th><td>${dist('getup')}</td></tr>
      <tr><th>歩き方のふらつき</th><td>${dist('gait')}</td></tr>
      <tr><th>横になっていた時間</th><td>${dist('lying')}</td></tr>
      <tr><th>外出</th><td>${dist('outing')}</td></tr>
      <tr><th>仕事・習い事</th><td>会社出勤 ${actDays('work')}日 <small>(うち残業 ${actDays('overtime')}日)</small> / 習い事 ${actDays('lesson')}日 / バレエ ${actDays('ballet')}日</td></tr>
      <tr><th>食事の量</th><td>${dist('meal')}<br><small>寝る前の間食 ${snackDays}日</small></td></tr>
      <tr><th>起きてきた時刻</th><td>${wakeText}</td></tr>
      <tr><th>睡眠(Apple Watch)</th><td>平均 ${hm(avg(sleep))} <small>/ 5分以上の目覚め 平均 ${f1(avg(awak))}回${naps.length ? ` / 昼寝など ${naps.length}日(平均 ${Math.round(avg(naps))}分)` : ''}(データ ${sleep.length}日)</small></td></tr>
      <tr><th>歩数(iPhone / Watch)</th><td>平均 ${steps.length ? Math.round(avg(steps)).toLocaleString() + '歩' : '–'} <small>(データ ${steps.length}日)</small></td></tr>
      ${gaitText ? `<tr><th>歩き方(iPhone、期間の平均)</th><td>${gaitText}<br><small>iPhone をポケットに入れて歩いた時に自動で測られる値。左右差・両足支持時間は大きいほど、歩く速さ・歩幅・歩行安定性は小さいほど、歩きにくさの目安</small></td></tr>` : ''}
      ${heartText ? `<tr><th>心拍(Apple Watch、期間の平均)</th><td>${heartText}</td></tr>` : ''}
      ${rangeSummary ? `<tr><th>歩き方の1日の中の変動(iPhone)</th><td>1日の最大と最小の差の平均: ${rangeSummary}<br><small>2回以上測れた日だけ。時間帯ごとの違いは「1日の中の変化」のグラフ</small></td></tr>` : ''}
      <tr><th>服薬(家族の確認)</th><td>${MEDS.map(medRow).join('<br>')}<br><small>頓服 合計 ${prnTotal}回</small></td></tr>
      <tr><th>アルコール</th><td>あり ${alcoholDays}日 <small>(記録 ${alcoholKnown}日中)</small></td></tr>
      <tr><th>本人が自分から訴えた日</th><td>${countSet('complaint', COMPLAINT)} <small>(こちらからはたずねていません)</small></td></tr>
      <tr><th>楽そうだった時間帯</th><td>${countSet('easy_times', EASY)}</td></tr>
    </table>`;

    const chart1 = lineChart(days, { label: '不随意運動の見た目(家族の評価)', note: '1 ほぼなし 〜 5 とても強い', get: (d) => (d.o && d.o.movement != null ? d.o.movement : null) },
      { min: 1, max: 5, ticks: [1, 2, 3, 4, 5], id: 'c1' });
    const sleepMax = Math.max(10, Math.ceil(Math.max(0, ...sleep.map((v) => v / 60)) / 2) * 2);
    const chart2 = barChart(days, { label: '睡眠時間(時間)', note: 'Apple Watch の睡眠データ(夜の眠り)', fmt: (v) => v.toFixed(1) + 'h', get: (d) => (d.health && d.health.sleep_min != null ? d.health.sleep_min / 60 : null) },
      { max: sleepMax, ticks: ticksFor(sleepMax), id: 'c2' });
    const stepMax = niceMax(Math.max(0, ...steps));
    const chart3 = barChart(days, { label: '歩数', note: 'iPhone / Apple Watch', fmt: (v) => Math.round(v).toLocaleString(), get: (d) => (d.health && d.health.steps != null ? d.health.steps : null) },
      { max: stepMax, ticks: ticksFor(stepMax), id: 'c3' });

    // 歩き方のグラフ(値が 2 日以上ある項目だけ。どれも 1 系列 1 グラフ)
    const lineOf = (k, label, note, unit, dg, id) => {
      const a = hv(k);
      if (a.length < 2) return '';
      const lo = Math.min(...a), hi = Math.max(...a);
      let min = 0, max, ticks;
      if (k === 'walking_speed') { // 速さは 0.5 刻み、値のまわりだけ
        min = Math.max(0, Math.floor(lo - 0.5)); max = Math.ceil(hi + 0.5);
        ticks = []; for (let t = min; t <= max + 1e-9; t += 0.5) ticks.push(Math.round(t * 10) / 10);
      } else { max = niceMax(hi * 1.15 || 1); ticks = ticksFor(max); } // 割合は 0 から
      return `<div class="avoid" style="margin-top:8px">${lineChart(days, { label: `${label}(${unit})`, note, get: (d) => (d.health && d.health[k] != null && d.health[k] !== '' && !isNaN(Number(d.health[k])) ? Number(rnd(Number(d.health[k]), dg)) : null) }, { min, max, ticks, id })}</div>`;
    };
    const gaitCharts = lineOf('walking_speed', '歩く速さ', 'iPhone(ポケットに入れて歩いた時)', 'km/時', 2, 'c4') +
      lineOf('walk_asym', '左右差(歩行非対称性)', 'iPhone。大きいほど左右の差が大きい', '%', 1, 'c5') +
      lineOf('double_support', '両足支持時間', 'iPhone。大きいほど両足で支える時間が長い', '%', 1, 'c6');

    const goodItems = days.filter((d) => d.o && (d.o.easy_times || d.o.good_note)).map((d) => {
      const t = EASY.filter(([k]) => setOf(d.o.easy_times).has(k)).map((x) => x[1]).join('・');
      return `<li><b>${md(d.date)}</b> ${t ? `楽そう: ${t}` : ''}${t && d.o.good_note ? ' — ' : ''}${esc(d.o.good_note || '')}</li>`;
    });
    const noteItems = days.filter((d) => d.o && NOTES.some(([k]) => d.o[k])).map((d) =>
      `<li><b>${md(d.date)}</b> ${NOTES.filter(([k]) => d.o[k]).map(([k, l]) => `<span class="nl">${l}:</span> ${esc(d.o[k])}`).join(' ／ ')}</li>`);
    const complaintItems = days.filter((d) => d.o && (d.o.complaint || d.o.complaint_note)).map((d) => {
      const t = COMPLAINT.filter(([k]) => setOf(d.o.complaint).has(k)).map((x) => x[1]).join('・');
      return `<li><b>${md(d.date)}</b> ${t}${t && d.o.complaint_note ? ' — ' : ''}${esc(d.o.complaint_note || '')}</li>`;
    });
    const list = (items) => (items.length ? `<ul class="memos">${items.join('')}</ul>` : '<p class="empty">なし</p>');
    const memos = data.memos.length ? `<ul class="memos">${data.memos.map((m) => `<li><b>${md(m.date)} ${hhmm(m.ts)}</b> ${esc(m.text)}</li>`).join('')}</ul>` : '<p class="empty">なし</p>';

    const cell = (key, d) => (d.o && d.o[key] != null ? SC[key].sym[d.o[key]] : '');
    const medCell = (f, d) => { const m = parseMed(d.o && d.o[f], f === 'med_morning'); return m.st ? `${MED_SYM[m.st] || ''}${m.t ? `<small>${m.t}</small>` : ''}` : ''; };
    const prnCell = (d) => { if (!d.o) return ''; const t = prnList(d.o); return t.length ? `${t.length}<small>${t.join(' ')}</small>` : (d.o.prn ? d.o.prn : ''); };
    const table = `<table class="days"><thead><tr><th>日付</th><th>起床</th><th class="c">起上</th><th class="c">ふら</th><th class="c">横</th><th class="c">外出</th><th class="c">仕事等</th><th class="c">食事</th><th class="c">見た目</th>
      ${MEDS.map(([, l]) => `<th class="c med">${esc(l)}</th>`).join('')}<th class="num">頓服</th><th class="c med">アルコール</th><th class="num">睡眠</th><th class="num">目覚</th><th class="num">歩数</th></tr></thead><tbody>
      ${days.map((d) => `<tr><td>${md(d.date)} <span style="color:var(--muted)">${DOW[dowOf(d.date)]}</span></td>
        <td>${d.o && d.o.wake_time ? d.o.wake_time : ''}</td>
        <td class="c">${cell('getup', d)}</td><td class="c">${cell('gait', d)}</td><td class="c">${cell('lying', d)}</td><td class="c">${cell('outing', d)}</td><td class="c">${d.o ? ACT_SYM.filter(([k]) => setOf(d.o.activity).has(k)).map((x) => x[1]).join('') : ''}</td><td class="c">${cell('meal', d)}${d.o && d.o.night_snack === 1 ? '<small>+間</small>' : ''}</td>
        <td class="c">${d.o && d.o.movement != null ? d.o.movement : ''}</td>
        ${MEDS.map(([f]) => `<td class="c">${medCell(f, d)}</td>`).join('')}
        <td class="num">${prnCell(d)}</td><td class="c">${d.o && d.o.alcohol === 1 ? 'あり' : ''}</td>
        <td class="num">${d.health && d.health.sleep_min != null ? (d.health.sleep_min / 60).toFixed(1) : ''}</td>
        <td class="num">${d.health && d.health.awakenings != null ? d.health.awakenings : ''}</td>
        <td class="num">${d.health && d.health.steps != null ? Number(d.health.steps).toLocaleString() : ''}</td></tr>`).join('')}
    </tbody></table>
    <p class="leg">起上・ふら(ふらつき): ○ スムーズ/なし △ ゆっくり/少し × つらそう/目立つ ／ 横 = 横になっていた時間 ／ 外出: 外 外出できた 近 近所だけ – なし ／ 仕事等: 出 会社出勤 残 残業 習 習い事 バ バレエ ／ 食事: 多 よく食べた 普 ふつう 半 半分くらい 少 少し × ほぼ食べず(+間 = 寝る前の間食あり) ／ 見た目 = 不随意運動 1〜5 ／ 朝の薬: ● ${esc(mn)}全部 ◔ ${esc(mn)}一部 ◐ ${esc(mn)}以外 ／ 寝る前の薬: ● 飲んだ ◔ 一部 ○ 飲まなかった(空欄は記録なし。小さな数字は飲んだ時刻) ／ 目覚 = 5分以上目が覚めた回数</p>`;

    page.innerHTML = header + note + summary +
      `<h2>日ごとの推移</h2><div class="avoid">${chart1}</div><div class="avoid" style="margin-top:8px">${chart2}</div><div class="avoid" style="margin-top:8px">${chart3}</div>${gaitCharts}` +
      (profiles ? `<h2>1日の中の変化(歩き方)</h2><p class="src">iPhone が測った時刻ごとの値を、期間全体で時間帯ごと(左)と、朝の薬(${esc(mn)})を飲んでからの時間ごと(右)に平均したもの。グラフの下の数字は測れた回数。iPhone をポケットに入れて歩いた時だけ測られるので、時間帯によって回数に差があります。</p>${profiles}` : '') +
      `<h2>見た目と本人のことば</h2><p class="src">「本人が自分から口にしたこと」(こちらからはたずねていません)と、その日の備考。</p>${list(complaintItems)}` +
      `<h2>楽そうだった時間・できたこと</h2>${list(goodItems)}` +
      `<h2>家族の備考</h2>${list(noteItems)}` +
      `<h2>気になったこと(家族のメモ)</h2>${memos}` +
      `<h2>日別の一覧</h2>${table}`;
    attachTooltip('c1', days, [['見た目', (d) => (d.o && d.o.movement != null ? `${d.o.movement}(${MOVE[d.o.movement]})` : '–')]]);
    attachTooltip('c2', days, [['睡眠', (d) => (d.health && d.health.sleep_min != null ? hm(d.health.sleep_min) : '–')], ['目覚め', (d) => (d.health && d.health.awakenings != null ? d.health.awakenings + '回' : '–')]]);
    attachTooltip('c3', days, [['歩数', (d) => (d.health && d.health.steps != null ? Number(d.health.steps).toLocaleString() + '歩' : '–')]]);
    [['c4', 'walking_speed', '歩く速さ', 'km/時'], ['c5', 'walk_asym', '左右差', '%'], ['c6', 'double_support', '両足支持時間', '%']].forEach(([id, k, l, u]) =>
      attachTooltip(id, days, [[l, (d) => {
        if (!d.health || d.health[k] == null) return '–';
        const sr = seriesOf(d, k); const vs = sr.map((p) => p[1]);
        return `平均 ${d.health[k]}${u}` + (sr.length >= 2 ? `(${Math.min(...vs)}〜${Math.max(...vs)}、${sr.length}回)` : '');
      }]]));
    profileIds.forEach(([id, bins, fmt, u]) => attachBinTooltip(id, bins, fmt, u));
  }

  /* ---------- グラフ(SVG)。どれも 1 系列なので凡例の箱は置かず、見出しで名前を示す ---------- */
  const W = 720, H = 190, PL = 44, PR = 56, PT = 10, PB = 26;
  function niceMax(v) {
    if (!v) return 1000;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }
  function ticksFor(max) { return [0, 0.25, 0.5, 0.75, 1].map((r) => Math.round(max * r * 100) / 100); }
  const tickLabel = (t) => (t >= 1000 ? t.toLocaleString() : String(t));
  function xOf(i, n) { return PL + (n === 1 ? (W - PL - PR) / 2 : (i * (W - PL - PR)) / (n - 1)); }
  // 棒グラフは、端の棒が目盛りの数字に重ならないように、1 日ずつの枠の真ん中に置く
  const xPoint = (i, n) => xOf(i, n);
  function xBand(i, n) { return PL + ((i + 0.5) * (W - PL - PR)) / Math.max(n, 1); }
  function yOf(v, opt) { const min = opt.min || 0; return PT + (H - PT - PB) * (1 - (v - min) / (opt.max - min)); }
  function xAxis(days, xf) {
    xf = xf || xOf;
    const n = days.length; const step = n > 40 ? 7 : n > 20 ? 4 : n > 10 ? 2 : 1;
    let out = '';
    days.forEach((d, i) => {
      const isLast = i === n - 1;
      const regular = i % step === 0 && (n - 1 - i) >= Math.ceil(step / 2); // 最終日のラベルと重ならないように間引く
      if (regular || isLast) out += `<text x="${xf(i, n)}" y="${H - 8}" font-size="9" text-anchor="middle" fill="var(--muted)">${md(d.date)}</text>`;
    });
    return out;
  }
  function grid(opt) {
    return opt.ticks.map((t) => `<line x1="${PL}" x2="${W - PR}" y1="${yOf(t, opt)}" y2="${yOf(t, opt)}" stroke="${t === (opt.min || 0) ? 'var(--axis)' : 'var(--grid)'}" stroke-width="1"/><text x="${PL - 6}" y="${yOf(t, opt) + 3}" font-size="9" text-anchor="end" fill="var(--muted)">${tickLabel(t)}</text>`).join('');
  }
  const title = (srs) => `<div class="legend"><span class="key"><b>${srs.label}</b></span><span style="margin-left:auto;color:var(--muted)">${srs.note || ''}</span></div>`;
  function lineChart(days, srs, opt) {
    const n = days.length;
    let svg = grid(opt) + xAxis(days);
    let path = '', pts = '', prev = false, lastIdx = -1;
    days.forEach((d, i) => {
      const v = srs.get(d);
      if (v == null) { prev = false; return; }
      const x = xOf(i, n), y = yOf(v, opt);
      path += (prev ? 'L' : 'M') + `${x.toFixed(1)} ${y.toFixed(1)} `;
      pts += `<circle cx="${x}" cy="${y}" r="6" fill="var(--surface)"/><circle cx="${x}" cy="${y}" r="4" fill="var(--s1)"/>`;
      prev = true; lastIdx = i;
    });
    svg += `<path d="${path}" stroke="var(--s1)" stroke-width="2" fill="none" stroke-linejoin="round" stroke-linecap="round"/>` + pts;
    if (lastIdx >= 0) svg += `<text x="${xOf(lastIdx, n) + 10}" y="${yOf(srs.get(days[lastIdx]), opt) + 3}" font-size="9.5" fill="var(--ink-2)">${srs.get(days[lastIdx])}</text>`;
    return `${title(srs)}<div class="chart" id="${opt.id}"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(srs.label)}の日ごとの推移">${svg}<line class="xh" x1="0" x2="0" y1="${PT}" y2="${H - PB}" stroke="var(--axis)" stroke-width="1" style="display:none"/></svg><div class="tooltip"></div></div>`;
  }
  function barChart(days, srs, opt) {
    const n = days.length;
    const slot = (W - PL - PR) / Math.max(n, 1);
    const bw = Math.min(24, Math.max(3, slot - 2)); // 棒と棒のあいだは 2px あける
    let svg = grid(opt) + xAxis(days, xBand);
    let lastIdx = -1;
    days.forEach((d, i) => {
      const v = srs.get(d);
      if (v == null) return;
      const x = xBand(i, n) - bw / 2, y0 = yOf(0, opt), y = yOf(Math.min(v, opt.max), opt);
      const h = Math.max(0, y0 - y);
      const r = Math.min(4, bw / 2, h);
      svg += `<path d="M${x} ${y0} V${y + r} Q${x} ${y} ${x + r} ${y} H${x + bw - r} Q${x + bw} ${y} ${x + bw} ${y + r} V${y0} Z" fill="var(--s1)"/>`;
      lastIdx = i;
    });
    if (lastIdx >= 0) svg += `<text x="${xBand(lastIdx, n) + bw / 2 + 6}" y="${yOf(Math.min(srs.get(days[lastIdx]), opt.max), opt) + 3}" font-size="9.5" fill="var(--ink-2)">${srs.fmt(srs.get(days[lastIdx]))}</text>`;
    return `${title(srs)}<div class="chart" id="${opt.id}" data-band="1"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(srs.label)}の日ごとの推移">${svg}<line class="xh" x1="0" x2="0" y1="${PT}" y2="${H - PB}" stroke="var(--axis)" stroke-width="1" style="display:none"/></svg><div class="tooltip"></div></div>`;
  }
  // 1 日の中の変化のグラフ(区分ごとの平均を点で示し、となりあう区分を線で結ぶ。1 系列)
  const PW = 360, PH = 170, PPL = 36, PPR = 10, PPT = 12, PPB = 32;
  function niceStep(x) { const p = Math.pow(10, Math.floor(Math.log10(x))); for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= x) return m * p; return 10 * p; }
  const pxB = (i, n) => PPL + ((i + 0.5) * (PW - PPL - PPR)) / n;
  function profileChart(bins, srs, id) {
    const n = bins.length;
    const vals = bins.filter((b) => b.v != null).map((b) => b.v);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const span = (hi - lo) || Math.abs(hi) * 0.1 || 1;
    const step = niceStep(span / 3);
    const min = Math.max(0, Math.floor((lo - span * 0.4) / step) * step), max = Math.ceil((hi + span * 0.4) / step) * step;
    const y = (v) => PPT + (PH - PPT - PPB) * (1 - (v - min) / (max - min || 1));
    let svg = '';
    for (let t = min; t <= max + step * 1e-6; t += step) {
      const ty = y(t);
      svg += `<line x1="${PPL}" x2="${PW - PPR}" y1="${ty}" y2="${ty}" stroke="${Math.abs(t - min) < 1e-9 ? 'var(--axis)' : 'var(--grid)'}" stroke-width="1"/><text x="${PPL - 5}" y="${ty + 3}" font-size="9" text-anchor="end" fill="var(--muted)">${Math.round(t * 100) / 100}</text>`;
    }
    bins.forEach((b, i) => {
      svg += `<text x="${pxB(i, n)}" y="${PH - 18}" font-size="9" text-anchor="middle" fill="var(--ink-2)">${b.label}</text><text x="${pxB(i, n)}" y="${PH - 6}" font-size="8" text-anchor="middle" fill="var(--muted)">${b.n ? b.n + '回' : '–'}</text>`;
    });
    let path = '', prev = false, pts = '';
    bins.forEach((b, i) => {
      if (b.v == null) { prev = false; return; }
      path += (prev ? 'L' : 'M') + `${pxB(i, n).toFixed(1)} ${y(b.v).toFixed(1)} `;
      pts += `<circle cx="${pxB(i, n)}" cy="${y(b.v)}" r="6" fill="var(--surface)"/><circle cx="${pxB(i, n)}" cy="${y(b.v)}" r="4" fill="var(--s1)"/>`;
      prev = true;
    });
    // いちばん高い点と低い点だけ、値を書く
    const iHi = bins.findIndex((b) => b.v === hi), iLo = bins.findIndex((b) => b.v === lo);
    const lab = (i) => `<text x="${pxB(i, n)}" y="${y(bins[i].v) - 9}" font-size="9" text-anchor="middle" fill="var(--ink-2)">${srs.fmt(bins[i].v)}</text>`;
    const labels = lab(iHi) + (iLo !== iHi ? lab(iLo) : '');
    return `${title(srs)}<div class="chart" id="${id}"><svg viewBox="0 0 ${PW} ${PH}" role="img" aria-label="${esc(srs.label)} ${esc(srs.note)}ごとの平均"><path d="${path}" stroke="var(--s1)" stroke-width="2" fill="none" stroke-linejoin="round" stroke-linecap="round"/>${svg}${pts}${labels}<line class="xh" x1="0" x2="0" y1="${PPT}" y2="${PH - PPB}" stroke="var(--axis)" stroke-width="1" style="display:none"/></svg><div class="tooltip"></div></div>`;
  }
  function attachBinTooltip(id, bins, fmt, unit) {
    const box = document.getElementById(id); if (!box) return;
    const svg = box.querySelector('svg'); const tip = box.querySelector('.tooltip'); const xh = svg.querySelector('.xh');
    const n = bins.length;
    svg.addEventListener('mousemove', (e) => {
      const rect = svg.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * PW;
      let best = 0, bd = Infinity;
      for (let i = 0; i < n; i++) { const dd = Math.abs(pxB(i, n) - px); if (dd < bd) { bd = dd; best = i; } }
      const b = bins[best];
      xh.setAttribute('x1', pxB(best, n)); xh.setAttribute('x2', pxB(best, n)); xh.style.display = '';
      tip.innerHTML = `<b>${b.label}</b><br>${b.v != null ? `平均 ${fmt(b.v)}${unit}(${b.n}回)` : '測れた値なし'}`;
      tip.style.display = 'block';
      const lx = (pxB(best, n) / PW) * rect.width;
      tip.style.left = `${Math.min(rect.width - tip.offsetWidth - 4, lx + 12)}px`;
      tip.style.top = `${Math.max(0, e.clientY - rect.top - 10)}px`;
    });
    svg.addEventListener('mouseleave', () => { tip.style.display = 'none'; xh.style.display = 'none'; });
  }
  function attachTooltip(id, days, rows) {
    const box = document.getElementById(id); if (!box) return;
    const xOf = box.dataset.band ? xBand : xPoint;
    const svg = box.querySelector('svg'); const tip = box.querySelector('.tooltip'); const xh = svg.querySelector('.xh');
    const n = days.length;
    svg.addEventListener('mousemove', (e) => {
      const rect = svg.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * W;
      let best = 0, bd = Infinity;
      for (let i = 0; i < n; i++) { const dd = Math.abs(xOf(i, n) - px); if (dd < bd) { bd = dd; best = i; } }
      const d = days[best];
      xh.setAttribute('x1', xOf(best, n)); xh.setAttribute('x2', xOf(best, n)); xh.style.display = '';
      tip.innerHTML = `<b>${md(d.date)}(${DOW[dowOf(d.date)]})</b><br>${rows.map(([l, f]) => `${l}: ${f(d)}`).join('<br>')}`;
      tip.style.display = 'block';
      const lx = (xOf(best, n) / W) * rect.width;
      tip.style.left = `${Math.min(rect.width - tip.offsetWidth - 4, lx + 12)}px`;
      tip.style.top = `${Math.max(0, e.clientY - rect.top - 10)}px`;
    });
    svg.addEventListener('mouseleave', () => { tip.style.display = 'none'; xh.style.display = 'none'; });
  }

  run();
})();
