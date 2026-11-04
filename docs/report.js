/* report.js — 医師に見せる期間レポート(印刷→PDF)
 * アプリ(index.html)と同じ端末・ブラウザのログイン情報(localStorage)を使う。 */
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
  const STATUS_LABEL = { all: '全部', no_concerta: 'コンサータ以外', partial: '一部', missed: '飲み忘れ', none: '記録なし', unknown: '不明' };
  const SYM = { all: '●', no_concerta: '◐', partial: '◔', missed: '○', none: '–', unknown: '?' };

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

  function medsByKind(meds) {
    const o = { morning: null, concerta: null, night: null, prn: [] };
    meds.forEach((m) => { if (m.kind === 'prn') o.prn.push(m); else if (!o[m.kind] || m.taken_at < o[m.kind].taken_at) o[m.kind] = m; });
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

  async function run() {
    if (!cfg.apiUrl || !cfg.token) { page.innerHTML = '<p class="empty">先にアプリ(index.html)でログインしてください。レポートは同じブラウザで開く必要があります。</p>'; return; }
    const from = fromEl.value, to = toEl.value;
    if (!from || !to || from > to) { page.innerHTML = '<p class="empty">期間を確認してください。</p>'; return; }
    page.innerHTML = '<p class="empty">読み込んでいます…</p>';
    let data;
    try { data = await api({ action: 'report', from, to }); } catch (e) { page.innerHTML = '<p class="empty">通信できませんでした。</p>'; return; }
    if (!data.ok) { page.innerHTML = `<p class="empty">${esc(data.message || data.error)}</p>`; return; }
    render(data);
  }

  function render(data) {
    const days = [];
    const n = daysBetween(data.from, data.to) + 1;
    const idx = {};
    for (let i = 0; i < n; i++) { const d = addDays(data.from, i); idx[d] = days.length; days.push({ date: d, log: null, meds: [], health: null, memos: [] }); }
    data.logs.forEach((l) => { if (l.date in idx) days[idx[l.date]].log = l; });
    data.meds.forEach((m) => { if (m.date in idx) days[idx[m.date]].meds.push(m); });
    data.health.forEach((h) => { if (h.date in idx) days[idx[h.date]].health = h; });
    data.memos.forEach((m) => { if (m.date in idx) days[idx[m.date]].memos.push(m); });
    days.forEach((d) => { d.status = medStatus(d.meds, d.log); d.k = medsByKind(d.meds); });

    const s = data.settings || {};
    const avg = (arr) => (arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length) : null);
    const diz = days.filter((d) => d.log && d.log.dizziness != null).map((d) => d.log.dizziness);
    const pain = days.filter((d) => d.log && d.log.pain != null).map((d) => d.log.pain);
    const sleep = days.filter((d) => d.health && d.health.sleep_min != null).map((d) => d.health.sleep_min);
    const awak = days.filter((d) => d.health && d.health.awakenings != null).map((d) => d.health.awakenings);
    const alcoholDays = days.filter((d) => d.log && d.log.alcohol === 1).length;
    const alcoholKnown = days.filter((d) => d.log && d.log.alcohol != null).length;
    const count = (st) => days.filter((d) => d.status === st).length;
    const prnCount = days.reduce((a, d) => a + d.k.prn.length, 0);
    const nightTimes = days.filter((d) => d.k.night).map((d) => hhmm(d.k.night.taken_at));
    const f1 = (v) => (v == null ? '–' : (Math.round(v * 10) / 10).toFixed(1));
    const hm = (min) => (min == null ? '–' : `${Math.floor(min / 60)}時間${pad(Math.round(min % 60))}分`);
    const medianTime = (arr) => {
      if (!arr.length) return '–';
      const mins = arr.map((t) => { let [h, m] = t.split(':').map(Number); if (h < 4) h += 24; return h * 60 + m; }).sort((a, b) => a - b);
      const v = mins[Math.floor(mins.length / 2)]; return `${pad(Math.floor(v / 60) % 24)}:${pad(v % 60)}`;
    };

    const header = `<h1>からだの記録 ${jp(data.from)} 〜 ${jp(data.to)}</h1>
      <div class="meta">${s.patient_name ? `<span>氏名: ${esc(s.patient_name)}</span>` : ''}<span>期間: ${n}日</span><span>作成: ${jp(logicalToday())}</span><span>記録: 本人のスマートフォン(毎晩の自己評価)+ Apple Watch / iPhone ヘルスケア</span></div>`;

    const summary = `<h2>まとめ</h2><table class="summary avoid">
      <tr><th>ぐるぐる(めまい・ふらつき)0–10</th><td>平均 ${f1(avg(diz))} <small>(最大 ${diz.length ? Math.max(...diz) : '–'}、記録 ${diz.length}日)</small></td></tr>
      <tr><th>痛み 0–10</th><td>平均 ${f1(avg(pain))} <small>(最大 ${pain.length ? Math.max(...pain) : '–'}、記録 ${pain.length}日)</small></td></tr>
      <tr><th>睡眠(Apple Watch)</th><td>平均 ${hm(avg(sleep))} <small>/ 中途覚醒 平均 ${f1(avg(awak))}回(データ ${sleep.length}日)</small></td></tr>
      <tr><th>服薬</th><td>全部 ${count('all')}日 / コンサータ以外 ${count('no_concerta')}日 / 一部 ${count('partial')}日 / 飲み忘れ ${count('missed')}日 <small>/ 記録なし ${count('none') + count('unknown')}日 / 頓服 ${prnCount}回 / 寝る前の服薬時刻 中央値 ${medianTime(nightTimes)}</small></td></tr>
      <tr><th>飲酒</th><td>${alcoholDays}日 <small>(回答 ${alcoholKnown}日中)</small></td></tr>
    </table>`;

    const chart1 = lineChart(days, [
      { key: 'dizziness', label: 'ぐるぐる', color: 'var(--s1)', marker: 'circle', get: (d) => (d.log && d.log.dizziness != null ? d.log.dizziness : null) },
      { key: 'pain', label: '痛み', color: 'var(--s2)', marker: 'square', get: (d) => (d.log && d.log.pain != null ? d.log.pain : null) }
    ], { max: 10, ticks: [0, 2, 4, 6, 8, 10], id: 'c1' });
    const chart2 = barChart(days, { label: '睡眠時間(時間)', color: 'var(--s1)', get: (d) => (d.health && d.health.sleep_min != null ? d.health.sleep_min / 60 : null) }, { max: 10, ticks: [0, 2, 4, 6, 8, 10], id: 'c2' });

    const cal = calendar(days);

    const memos = data.memos.length
      ? `<ul class="memos">${data.memos.map((m) => `<li><b>${md(m.date)} ${hhmm(m.ts)}</b> ${esc(m.text)}</li>`).join('')}</ul>`
      : '<p class="empty">なし</p>';

    const table = `<table class="avoid"><thead><tr><th>日付</th><th class="num">ぐるぐる</th><th class="num">痛み</th><th class="c">酒</th><th class="c">薬</th><th>朝</th><th>コンサータ</th><th>寝る前</th><th class="num">頓服</th><th class="num">睡眠</th><th class="num">覚醒</th><th class="num">歩数</th>${days.some((d) => d.health && d.health.dyskinesia != null) ? '<th class="num">StrivePD</th>' : ''}</tr></thead><tbody>
      ${days.map((d) => `<tr><td>${md(d.date)} <span style="color:var(--muted)">${DOW[dowOf(d.date)]}</span></td>
        <td class="num">${d.log && d.log.dizziness != null ? d.log.dizziness : ''}</td><td class="num">${d.log && d.log.pain != null ? d.log.pain : ''}</td>
        <td class="c">${d.log && d.log.alcohol === 1 ? '酒' : ''}</td><td class="c" title="${STATUS_LABEL[d.status]}">${SYM[d.status]}</td>
        <td>${d.k.morning ? hhmm(d.k.morning.taken_at) + (d.k.morning.partial && d.k.morning.partial.length ? '(一部)' : '') : (d.log && (d.log.meds_answer === 'all' || d.log.meds_answer === 'no_concerta') ? '時刻不明' : '')}</td>
        <td>${d.k.concerta ? hhmm(d.k.concerta.taken_at) : (d.log && d.log.meds_answer === 'all' ? '時刻不明' : d.log && d.log.meds_answer === 'no_concerta' ? 'なし' : '')}</td>
        <td>${d.k.night ? hhmm(d.k.night.taken_at) + (d.k.night.partial && d.k.night.partial.length ? '(一部)' : '') : ''}</td>
        <td class="num">${d.k.prn.length || ''}</td>
        <td class="num">${d.health && d.health.sleep_min != null ? (d.health.sleep_min / 60).toFixed(1) : ''}</td>
        <td class="num">${d.health && d.health.awakenings != null ? d.health.awakenings : ''}</td>
        <td class="num">${d.health && d.health.steps != null ? Number(d.health.steps).toLocaleString() : ''}</td>
        ${days.some((x) => x.health && x.health.dyskinesia != null) ? `<td class="num">${d.health && d.health.dyskinesia != null ? d.health.dyskinesia : ''}</td>` : ''}</tr>`).join('')}
    </tbody></table><p class="leg">薬: ● 全部 ◐ コンサータ以外 ◔ 一部 ○ 飲み忘れ – 記録なし。「時刻不明」は夜の確認で「飲んだ」と答えたがボタン記録がない日。</p>`;

    page.innerHTML = header + summary +
      `<h2>日ごとの推移</h2><div class="avoid">${chart1}</div><div class="avoid" style="margin-top:8px">${chart2}</div>` +
      `<h2>服薬と飲酒のカレンダー</h2><div class="avoid">${cal}</div>` +
      `<h2>特記事項(本人・家族のメモ)</h2>${memos}` +
      `<h2>日別の一覧</h2>${table}`;
    attachTooltip('c1', days, [['ぐるぐる', (d) => (d.log && d.log.dizziness != null ? d.log.dizziness : '–')], ['痛み', (d) => (d.log && d.log.pain != null ? d.log.pain : '–')]]);
    attachTooltip('c2', days, [['睡眠', (d) => (d.health && d.health.sleep_min != null ? hm(d.health.sleep_min) : '–')], ['中途覚醒', (d) => (d.health && d.health.awakenings != null ? d.health.awakenings + '回' : '–')]]);
  }

  /* ---------- グラフ(SVG) ---------- */
  const W = 720, H = 200, PL = 34, PR = 56, PT = 10, PB = 26;
  function xOf(i, n) { return PL + (n === 1 ? (W - PL - PR) / 2 : (i * (W - PL - PR)) / (n - 1)); }
  function yOf(v, max) { return PT + (H - PT - PB) * (1 - v / max); }
  function xAxis(days) {
    const n = days.length; const step = n > 40 ? 7 : n > 20 ? 4 : n > 10 ? 2 : 1;
    let out = '';
    days.forEach((d, i) => {
      const isLast = i === n - 1;
      const regular = i % step === 0 && (n - 1 - i) >= Math.ceil(step / 2); // 最終日のラベルと重ならないように間引く
      if (regular || isLast) out += `<text x="${xOf(i, n)}" y="${H - 8}" font-size="9" text-anchor="middle" fill="var(--muted)">${md(d.date)}</text>`;
    });
    return out;
  }
  function grid(ticks, max) {
    return ticks.map((t) => `<line x1="${PL}" x2="${W - PR}" y1="${yOf(t, max)}" y2="${yOf(t, max)}" stroke="${t === 0 ? 'var(--axis)' : 'var(--grid)'}" stroke-width="1"/><text x="${PL - 6}" y="${yOf(t, max) + 3}" font-size="9" text-anchor="end" fill="var(--muted)">${t}</text>`).join('');
  }
  function marker(x, y, color, shape) {
    const ring = shape === 'square' ? `<rect x="${x - 6}" y="${y - 6}" width="12" height="12" fill="var(--surface)"/>` : `<circle cx="${x}" cy="${y}" r="6" fill="var(--surface)"/>`;
    const mk = shape === 'square' ? `<rect x="${x - 4}" y="${y - 4}" width="8" height="8" fill="${color}"/>` : `<circle cx="${x}" cy="${y}" r="4" fill="${color}"/>`;
    return ring + mk;
  }
  function lineChart(days, series, opt) {
    const n = days.length;
    let svg = grid(opt.ticks, opt.max) + xAxis(days);
    series.forEach((srs) => {
      let path = '', pts = '', last = null, lastIdx = -1;
      days.forEach((d, i) => {
        const v = srs.get(d);
        if (v == null) { last = null; return; }
        const x = xOf(i, n), y = yOf(v, opt.max);
        path += (last == null ? 'M' : 'L') + `${x.toFixed(1)} ${y.toFixed(1)} `;
        pts += marker(x, y, srs.color, srs.marker);
        last = v; lastIdx = i;
      });
      svg += `<path d="${path}" stroke="${srs.color}" stroke-width="2" fill="none" stroke-linejoin="round" stroke-linecap="round"/>` + pts;
      if (lastIdx >= 0) svg += `<text x="${xOf(lastIdx, n) + 10}" y="${yOf(srs.get(days[lastIdx]), opt.max) + 3}" font-size="9.5" fill="var(--ink-2)">${srs.label} ${srs.get(days[lastIdx])}</text>`;
    });
    const legend = `<div class="legend">${series.map((s) => `<span class="key"><span class="sw ${s.marker === 'square' ? 'sq' : ''}" style="color:${s.color}"></span>${s.label}</span>`).join('')}<span style="margin-left:auto;color:var(--muted)">0 = なし、10 = さいあく</span></div>`;
    return `${legend}<div class="chart" id="${opt.id}"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="ぐるぐると痛みの日ごとの推移">${svg}<line class="xh" x1="0" x2="0" y1="${PT}" y2="${H - PB}" stroke="var(--axis)" stroke-width="1" style="display:none"/></svg><div class="tooltip"></div></div>`;
  }
  function barChart(days, srs, opt) {
    const n = days.length;
    const slot = (W - PL - PR) / Math.max(n, 1);
    const bw = Math.min(24, Math.max(3, slot - 2));
    let svg = grid(opt.ticks, opt.max) + xAxis(days);
    let lastIdx = -1;
    days.forEach((d, i) => {
      const v = srs.get(d);
      if (v == null) return;
      const x = xOf(i, n) - bw / 2, y0 = yOf(0, opt.max), y = yOf(Math.min(v, opt.max), opt.max);
      const h = Math.max(0, y0 - y);
      const r = Math.min(4, bw / 2, h);
      svg += `<path d="M${x} ${y0} V${y + r} Q${x} ${y} ${x + r} ${y} H${x + bw - r} Q${x + bw} ${y} ${x + bw} ${y + r} V${y0} Z" fill="${srs.color}"/>`;
      lastIdx = i;
    });
    if (lastIdx >= 0) svg += `<text x="${xOf(lastIdx, n) + bw / 2 + 6}" y="${yOf(Math.min(srs.get(days[lastIdx]), opt.max), opt.max) + 3}" font-size="9.5" fill="var(--ink-2)">${srs.get(days[lastIdx]).toFixed(1)}h</text>`;
    const legend = `<div class="legend"><span class="key">${srs.label}</span><span style="margin-left:auto;color:var(--muted)">Apple Watch の睡眠データ</span></div>`;
    return `${legend}<div class="chart" id="${opt.id}"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="睡眠時間の日ごとの推移">${svg}<line class="xh" x1="0" x2="0" y1="${PT}" y2="${H - PB}" stroke="var(--axis)" stroke-width="1" style="display:none"/></svg><div class="tooltip"></div></div>`;
  }
  function attachTooltip(id, days, rows) {
    const box = document.getElementById(id); if (!box) return;
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

  /* ---------- カレンダー ---------- */
  function calendar(days) {
    const first = days[0].date; const last = days[days.length - 1].date;
    const start = addDays(first, -((dowOf(first) + 6) % 7)); // 月曜はじまり
    const total = daysBetween(start, last) + 1;
    const weeks = Math.ceil(total / 7);
    const byDate = {}; days.forEach((d) => { byDate[d.date] = d; });
    let rows = '';
    for (let w = 0; w < weeks; w++) {
      let cells = '';
      for (let i = 0; i < 7; i++) {
        const ds = addDays(start, w * 7 + i);
        const d = byDate[ds];
        if (!d) { cells += `<td class="out"><span class="d">${md(ds)}</span></td>`; continue; }
        const times = [d.k.morning ? `朝${hhmm(d.k.morning.taken_at)}` : (d.log && (d.log.meds_answer === 'all' || d.log.meds_answer === 'no_concerta') ? '朝?' : ''),
          d.k.concerta ? `C${hhmm(d.k.concerta.taken_at)}` : '', d.k.night ? `夜${hhmm(d.k.night.taken_at)}` : ''].filter(Boolean).join(' ');
        cells += `<td><span class="d">${md(ds)}</span><br><span class="sym" title="${STATUS_LABEL[d.status]}">${SYM[d.status]}</span>${d.log && d.log.alcohol === 1 ? '<span title="飲酒">酒</span>' : ''}${d.k.prn.length ? `<span title="頓服"> 頓${d.k.prn.length}</span>` : ''}<br><span class="t">${times}</span></td>`;
      }
      rows += `<tr>${cells}</tr>`;
    }
    return `<table class="cal"><thead><tr>${['月', '火', '水', '木', '金', '土', '日'].map((d) => `<th>${d}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
      <p class="leg">● 全部飲んだ ◐ コンサータ以外 ◔ 一部だけ ○ 飲み忘れあり – 記録なし ／ 「酒」= 飲酒あり、「頓n」= 頓服n回 ／ 朝・C(コンサータ)・夜 = 服薬時刻(タップした時刻)。「朝?」は時刻の記録なし。</p>`;
  }

  run();
})();
