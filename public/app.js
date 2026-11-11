import { RibbonField, countUp } from './ribbon.js';
import { api, storageOk } from './local-api.js';

const $view = document.getElementById('view');
const won = (n) => `${Math.round(n).toLocaleString('ko-KR')}원`;
const PALETTE = ['#FFCC00', '#4BB5A9', '#1A1A1A', '#b9b6a8', '#8c897c', '#d8c36a', '#7fb5ad', '#5a5a55'];

// ---------- 작은 유틸 ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}
const title = (word, tag = 'h2') => h(tag, { class: 'display' }, word, h('span', { class: 'p' }, '.'));

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };

// ---------- 월 상태 ----------
const nowMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
let month = (() => { try { return localStorage.getItem('month') || nowMonth(); } catch { return nowMonth(); } })();
const shift = (m, d) => { const [y, mo] = m.split('-').map(Number); const x = new Date(y, mo - 1 + d, 1); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`; };
function setMonth(m, rerender) { month = m; try { localStorage.setItem('month', m); } catch { /* 무시 */ } rerender(); }
const monthBar = (rerender) => h('div', { class: 'monthbar' },
  h('button', { 'aria-label': '이전 달', onclick: () => setMonth(shift(month, -1), rerender) }, '‹'),
  h('output', { 'aria-live': 'polite' }, month.replace('-', '.')),
  h('button', { 'aria-label': '다음 달', onclick: () => setMonth(shift(month, 1), rerender) }, '›'));

let cats = [];
const loadCats = async () => { cats = await api('/api/categories'); };
const catOptions = (type, selected, withBlank = true) => [
  withBlank ? h('option', { value: '' }, '미분류') : null,
  ...cats.filter((c) => c.type === type).map((c) => h('option', { value: c.id, selected: String(c.id) === String(selected) }, c.name)),
];

// ---------- 대시보드 ----------
async function dashboard() {
  const [s, ins] = await Promise.all([api(`/api/summary?month=${month}`), api(`/api/insights?month=${month}`)]);
  const rerender = () => render();
  const list = s.categories;
  const scale = Math.max(1, ...list.map((c) => Math.max(c.total, c.budget)));

  // hero
  const heroCanvas = h('canvas', { 'aria-hidden': 'true' });
  const top = list.slice(0, 5);
  const heroSpecs = (top.length ? top : [{ total: 1 }, { total: .7 }, { total: .85 }]).map((c, i, arr) => ({
    frac: top.length ? Math.max(.12, c.total / top[0].total) : [0.95, 0.7, 0.85][i],
    y: 0.28 + (i / Math.max(1, arr.length - 1)) * 0.46, amp: 26 + i * 4, thick: 30 - i * 2, freq: 1 + i * 0.25, twist: 1.6 + i * 0.5, seed: i * 1.9,
  }));
  const total = h('div', { class: 'total' }, h('span', { 'data-v': 0 }, '0'), '원 썼어요');
  const hero = h('div', { class: 'hero' }, heroCanvas, h('div', { class: 'copy' }, title('spending', 'h1'), total));

  const stat = (label, v, cls = '') => h('div', { class: `stat ${cls}` }, h('b', { 'data-v': 0 }, '0'), h('span', {}, label));
  const stats = h('div', { class: 'stats' },
    h('div', { class: 'stat in' }, h('b', { 'data-v': 0 }, '0'), h('span', {}, '수입')),
    stat('지출'), stat('잔액'), monthBar(rerender));

  // 카테고리 리본
  const rows = h('div', { class: 'rows' });
  const rowFields = [];
  if (list.length === 0) rows.append(h('div', { class: 'empty' }, h('p', {}, '이 달 지출 내역이 아직 없어요. transactions에서 추가하거나 upload에서 CSV를 올려 보세요.'),
    h('button', { class: 'btn ghost', type: 'button', onclick: guard(async () => { await api('/api/sample', { method: 'POST', body: {} }); toast('샘플을 넣었어요'); render(); }) }, '샘플 데이터로 둘러보기')));
  list.forEach((c) => {
    const pct = s.expense ? Math.round((c.total / s.expense) * 100) : 0;
    const over = c.budget && c.total > c.budget;
    let sub = `${pct}% · ${c.n}건`;
    if (c.budget) sub = over ? `예산 ${won(c.budget)} 초과 +${won(c.total - c.budget)}` : `예산 ${won(c.budget)} 중 ${Math.round((c.total / c.budget) * 100)}%`;
    else if (c.prev) sub += ` · 전월 ${c.total >= c.prev ? '+' : '−'}${won(Math.abs(c.total - c.prev))}`;
    const canvas = h('canvas', { role: 'img', 'aria-label': `${c.name} ${won(c.total)}, 전체 지출의 ${pct}%` });
    const amt = h('span', { class: 'amt', 'data-v': 0 }, '0');
    rows.append(h('div', { class: `row clickable${over ? ' over' : ''}`, tabindex: 0, role: 'link',
      onclick: () => { location.hash = '#/transactions'; }, onkeydown: (e) => { if (e.key === 'Enter') location.hash = '#/transactions'; } },
      h('div', { class: 'lbl' }, h('b', {}, c.name), h('span', { class: 'amt' }, amt, '원'), h('small', {}, sub)),
      canvas));
    rowFields.push({ canvas, c, amt });
  });

  // 도넛 + 고정/변동
  const donut = buildDonut(list, s.expense);
  const fixedPct = s.expense ? (s.fixed / s.expense) * 100 : 0;
  const nature = h('div', { class: 'nature' },
    h('p', { class: 'eyebrow' }, '고정비 vs 변동비'),
    h('div', { class: 'bar', role: 'img', 'aria-label': `고정비 ${Math.round(fixedPct)}%, 변동비 ${Math.round(100 - fixedPct)}%` },
      h('div', { style: 'width:0;background:#1A1A1A', 'data-w': fixedPct }), h('div', { style: 'width:0;background:#FFCC00', 'data-w': s.expense ? 100 - fixedPct : 0 })),
    h('div', { class: 'cap' }, h('span', {}, `고정 ${won(s.fixed)}`), h('span', {}, `변동 ${won(s.variable)} · 줄일 수 있는 몫`)));

  const notes = ins.items.slice(0, 3);
  const frag = h('div', {},
    hero,
    section(null, stats),
    section('where it goes', rows),
    s.expense ? section('split', h('div', { class: 'split' }, donut.node, h('div', {}, donut.legend, nature))) : null,
    section('watch', notes.length ? noteList(notes) : h('p', { class: 'empty' }, '지금은 눈에 띄는 경고가 없어요.'),
      h('p', {}, h('a', { href: '#/saving' }, '절약 후보 모두 보기 →'))));
  $view.replaceChildren(frag);

  // 값 채우기 & 애니메이션 시작
  const counters = [...stats.querySelectorAll('b')];
  countUp(counters[0], s.income); countUp(counters[1], s.expense); countUp(counters[2], s.balance);
  countUp(total.firstChild, s.expense);
  new RibbonField(heroCanvas, heroSpecs);
  rowFields.forEach(({ canvas, c, amt }, i) => {
    const f = new RibbonField(canvas, [{ frac: 0, y: .5, amp: 9, thick: 20, freq: 1.2 + (i % 3) * .3, twist: 2 + (i % 4) * .4, seed: i * 1.3 }]);
    countUp(amt, c.total);
    requestAnimationFrame(() => setTimeout(() => f.update([{ frac: c.total / scale, budgetFrac: c.budget ? c.budget / scale : null }]), i * 70));
  });
  requestAnimationFrame(() => { donut.animate(); nature.querySelectorAll('[data-w]').forEach((d) => { d.style.width = `${d.dataset.w}%`; }); });
}

function section(word, ...kids) {
  return h('section', {}, word ? title(word) : null, ...kids);
}

function buildDonut(list, total) {
  const R = 15.9155, arcs = [];
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 42 42'); svg.setAttribute('class', 'donut'); svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `카테고리별 지출 비율: ${list.map((c) => `${c.name} ${Math.round((c.total / total) * 100)}%`).join(', ')}`);
  const ring = document.createElementNS(svg.namespaceURI, 'circle');
  Object.entries({ cx: 21, cy: 21, r: R, fill: 'none', stroke: '#dcdcd6', 'stroke-width': 6 }).forEach(([k, v]) => ring.setAttribute(k, v));
  svg.append(ring);
  let offset = 25; // 12시 방향 시작
  list.forEach((c, i) => {
    const len = (c.total / total) * 100;
    const el = document.createElementNS(svg.namespaceURI, 'circle');
    Object.entries({ cx: 21, cy: 21, r: R, fill: 'none', stroke: PALETTE[i % PALETTE.length], 'stroke-width': 6, 'stroke-dasharray': '0 100', 'stroke-dashoffset': offset, class: 'arc' }).forEach(([k, v]) => el.setAttribute(k, v));
    svg.append(el); arcs.push({ el, len: Math.max(0, len - (list.length > 1 ? 0.4 : 0)) });
    offset -= len;
  });
  const legend = h('ul', { class: 'legend' }, list.map((c, i) => h('li', {}, h('i', { style: `background:${PALETTE[i % PALETTE.length]}` }), h('span', {}, c.name), h('span', {}, `${Math.round((c.total / total) * 100)}% · ${won(c.total)}`))));
  return { node: svg, legend, animate: () => arcs.forEach(({ el, len }) => el.setAttribute('stroke-dasharray', `${len} ${100 - len}`)) };
}

const TAGS = { spike: '급증', over: '초과', near: '임박', small: '소액', recurring: '반복' };
const noteList = (items) => h('ul', { class: 'notes' }, items.map((i) => h('li', {}, h('span', { class: `tag ${i.kind}` }, TAGS[i.kind] || i.kind), h('span', {}, i.text))));

// ---------- 거래 내역 ----------
async function transactions() {
  const rows = await api(`/api/transactions?month=${month}`);
  let editId = null;
  const today = new Date().toISOString().slice(0, 10);
  const defaultDate = today.startsWith(month) ? today : `${month}-01`;
  const f = {
    date: h('input', { type: 'date', value: defaultDate, required: true }),
    amount: h('input', { type: 'number', min: 1, step: 1, inputmode: 'numeric', required: true, placeholder: '12000' }),
    category: h('select', {}, catOptions('expense')),
    pay: h('input', { type: 'text', placeholder: '카드 / 현금 / 계좌' }),
    memo: h('input', { type: 'text', placeholder: '스타벅스', maxlength: 200 }),
  };
  const typeInputs = ['expense', 'income'].map((t) => h('input', { type: 'radio', name: 'type', value: t, checked: t === 'expense', onchange: () => { f.category.replaceChildren(...catOptions(t)); } }));
  const typeSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': '구분' },
    h('label', {}, typeInputs[0], h('span', {}, '출금')), h('label', {}, typeInputs[1], h('span', {}, '입금')));
  const submit = h('button', { class: 'btn', type: 'submit' }, '추가');
  const cancel = h('button', { class: 'btn ghost', type: 'button', hidden: true, onclick: () => resetForm() }, '취소');
  const curType = () => typeInputs.find((i) => i.checked).value;
  function resetForm() { editId = null; f.amount.value = ''; f.memo.value = ''; f.pay.value = ''; submit.textContent = '추가'; cancel.hidden = true; }

  const form = h('form', { class: 'form card', onsubmit: guard(async (e) => {
    e.preventDefault();
    const body = { date: f.date.value, type: curType(), amount: Number(f.amount.value), category_id: f.category.value || null, payment_method: f.pay.value, memo: f.memo.value };
    if (editId) await api(`/api/transactions/${editId}`, { method: 'PUT', body }); else await api('/api/transactions', { method: 'POST', body });
    toast(editId ? '수정했어요' : '추가했어요');
    month = body.date.slice(0, 7); try { localStorage.setItem('month', month); } catch { /* 무시 */ }
    render();
  }) }, h('label', {}, '구분', typeSeg), h('label', {}, '날짜', f.date), h('label', {}, '금액(원)', f.amount),
  h('label', {}, '카테고리', f.category), h('label', {}, '결제수단', f.pay), h('label', {}, '메모', f.memo), h('div', { style: 'display:flex;gap:8px' }, submit, cancel));

  const q = h('input', { type: 'search', placeholder: '메모 검색', 'aria-label': '메모 검색' });
  const catFilter = h('select', { 'aria-label': '카테고리 필터' }, h('option', { value: '' }, '모든 카테고리'), cats.map((c) => h('option', { value: c.name }, c.name)));
  const tbody = h('tbody');
  const sum = h('span', { class: 'muted' });
  function paint() {
    const term = q.value.trim().toLowerCase();
    const shown = rows.filter((r) => (!term || (r.memo || '').toLowerCase().includes(term)) && (!catFilter.value || r.category === catFilter.value));
    sum.textContent = `${shown.length}건 · 지출 ${won(shown.filter((r) => r.type === 'expense').reduce((a, r) => a + r.amount, 0))} · 수입 ${won(shown.filter((r) => r.type === 'income').reduce((a, r) => a + r.amount, 0))}`;
    tbody.replaceChildren(...(shown.length ? shown.map((r) => h('tr', {},
      h('td', {}, r.date.slice(5)), h('td', {}, r.category || '미분류'), h('td', {}, r.memo || '—'),
      h('td', { class: `num${r.type === 'income' ? ' in' : ''}` }, `${r.type === 'income' ? '+' : '−'}${r.amount.toLocaleString('ko-KR')}`),
      h('td', { class: 'num' },
        h('button', { class: 'btn ghost sm', onclick: () => {
          editId = r.id; f.date.value = r.date; f.amount.value = r.amount; f.memo.value = r.memo || ''; f.pay.value = r.payment_method || '';
          typeInputs.find((i) => i.value === r.type).checked = true; f.category.replaceChildren(...catOptions(r.type, r.category_id));
          submit.textContent = '저장'; cancel.hidden = false; form.scrollIntoView({ block: 'center' }); f.amount.focus();
        } }, '수정'), ' ',
        h('button', { class: 'btn ghost sm', 'aria-label': `${r.memo || '거래'} 삭제`, onclick: guard(async () => {
          if (!confirm('이 거래를 삭제할까요?')) return;
          await api(`/api/transactions/${r.id}`, { method: 'DELETE' }); toast('삭제했어요'); render();
        }) }, '삭제')))) : [h('tr', {}, h('td', { colspan: 5, class: 'empty' }, '표시할 거래가 없어요.'))]));
  }
  q.addEventListener('input', paint); catFilter.addEventListener('change', paint); paint();

  $view.replaceChildren(h('div', {},
    section('transactions', h('div', { class: 'toolbar' }, monthBar(render), sum), h('div', { style: 'margin-top:20px' }, form),
      h('div', { class: 'toolbar' }, q, catFilter),
      h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['날짜', '카테고리', '메모'].map((t) => h('th', {}, t)), h('th', { class: 'num' }, '금액'), h('th', {}))), tbody)))));
}

// ---------- CSV 업로드 ----------
function decodeBuffer(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, ''); }
  catch { return new TextDecoder('euc-kr').decode(buf); } // 국내 은행·카드사 CSV 대비
}
function parseCSV(text) {
  const first = text.split(/\r?\n/, 1)[0];
  const delim = [',', '\t', ';'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const out = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some((c) => c.trim())) out.push(row); row = []; }
    else cur += ch;
  }
  row.push(cur); if (row.some((c) => c.trim())) out.push(row);
  return out;
}
function toDate(s) {
  const m = String(s || '').trim().match(/(\d{4})[.\-/년\s]*(\d{1,2})[.\-/월\s]*(\d{1,2})/) || String(s || '').trim().match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  const d = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return Number.isNaN(Date.parse(d)) ? null : d;
}
function toAmount(s) {
  const t = String(s ?? '').trim(); if (!t) return 0;
  const neg = /^\(.*\)$/.test(t) || t.startsWith('-') || t.startsWith('−');
  const n = Number(t.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? Math.round(n) * (neg ? -1 : 1) : 0;
}
const guess = (headers, words) => Math.max(0, headers.findIndex((hd) => words.some((w) => hd.includes(w))));

function upload() {
  let filename = '', data = [];
  const out = h('div', {});
  const input = h('input', { type: 'file', accept: '.csv,.tsv,.txt', 'aria-label': 'CSV 파일 선택', onchange: () => input.files[0] && load(input.files[0]) });
  const drop = h('div', { class: 'drop' }, h('p', {}, 'CSV 파일을 끌어다 놓거나 선택하세요'), input,
    h('p', { class: 'muted' }, '엑셀(.xlsx)은 "다른 이름으로 저장 → CSV"로 저장한 뒤 올려 주세요. 한글 인코딩(EUC-KR)도 자동 인식합니다.'));
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
  drop.addEventListener('drop', (e) => e.dataTransfer.files[0] && load(e.dataTransfer.files[0]));

  async function load(file) {
    filename = file.name;
    data = parseCSV(decodeBuffer(await file.arrayBuffer()));
    if (data.length < 2) { toast('읽을 수 있는 행이 없어요'); return; }
    mapping();
  }

  function mapping() {
    const headers = data[0].map((x) => x.trim());
    const opt = (sel) => headers.map((hd, i) => h('option', { value: i, selected: i === sel }, hd || `열 ${i + 1}`));
    const dateSel = h('select', {}, opt(guess(headers, ['일자', '날짜', '거래일', '이용일', 'date'])));
    const memoSel = h('select', {}, opt(guess(headers, ['적요', '내용', '메모', '가맹점', '거래처', '이용처', 'memo'])));
    const modeSel = h('select', {},
      h('option', { value: 'split' }, '입금/출금이 따로 있는 파일(통장)'), h('option', { value: 'card' }, '금액 한 열 · 양수=지출(카드)'), h('option', { value: 'bank' }, '금액 한 열 · 양수=입금, 음수=출금'));
    const inSel = h('select', {}, opt(guess(headers, ['입금'])));
    const outSel = h('select', {}, opt(guess(headers, ['출금'])));
    const amtSel = h('select', {}, opt(guess(headers, ['이용금액', '금액', '결제금액', 'amount'])));
    const preview = h('div', {});
    const btn = h('button', { class: 'btn', type: 'button' }, '가져오기');
    const splitBox = h('div', { class: 'form' }, h('label', {}, '입금 열', inSel), h('label', {}, '출금 열', outSel));
    const oneBox = h('div', { class: 'form', hidden: true }, h('label', {}, '금액 열', amtSel));

    const build = () => {
      const mode = modeSel.value; splitBox.hidden = mode !== 'split'; oneBox.hidden = mode === 'split';
      const rows = [];
      for (const r of data.slice(1)) {
        const date = toDate(r[dateSel.value]); const memo = (r[memoSel.value] || '').trim();
        let type = null, amount = 0;
        if (mode === 'split') {
          const i = Math.abs(toAmount(r[inSel.value])), o = Math.abs(toAmount(r[outSel.value]));
          if (o > 0) { type = 'expense'; amount = o; } else if (i > 0) { type = 'income'; amount = i; }
        } else {
          const v = toAmount(r[amtSel.value]);
          if (v) { const pos = v > 0; type = (mode === 'card' ? !pos : pos) ? 'income' : 'expense'; amount = Math.abs(v); }
        }
        rows.push({ date, memo, type, amount, ok: !!(date && type && amount) });
      }
      return rows;
    };
    const paint = () => {
      const rows = build(); const ok = rows.filter((r) => r.ok);
      preview.replaceChildren(
        h('p', {}, `전체 ${rows.length}행 중 `, h('b', {}, `${ok.length}행`), ` 가져올 수 있어요${rows.length - ok.length ? ` (날짜·금액 인식 실패 ${rows.length - ok.length}행 제외)` : ''}.`),
        h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['날짜', '메모', '구분'].map((t) => h('th', {}, t)), h('th', { class: 'num' }, '금액'))),
          h('tbody', {}, ok.slice(0, 5).map((r) => h('tr', {}, h('td', {}, r.date), h('td', {}, r.memo || '—'), h('td', {}, r.type === 'income' ? '입금' : '출금'), h('td', { class: 'num' }, r.amount.toLocaleString('ko-KR'))))))));
      btn.disabled = ok.length === 0; btn.onclick = guard(async () => {
        const res = await api('/api/import', { method: 'POST', body: { filename, rows: ok.map(({ date, memo, type, amount }) => ({ date, memo, type, amount })) } });
        toast(`${res.added}건 추가 · 중복 ${res.duplicate}건 · 오류 ${res.invalid}건`);
        if (ok[0]) { month = ok[0].date.slice(0, 7); try { localStorage.setItem('month', month); } catch { /* 무시 */ } }
        location.hash = '#/';
      });
    };
    [dateSel, memoSel, modeSel, inSel, outSel, amtSel].forEach((s) => s.addEventListener('change', paint));
    out.replaceChildren(h('div', { class: 'card', style: 'margin-top:24px;display:grid;gap:16px' },
      h('p', { class: 'eyebrow' }, `${filename} · 열 매핑`),
      h('div', { class: 'form' }, h('label', {}, '날짜 열', dateSel), h('label', {}, '메모(가맹점) 열', memoSel), h('label', {}, '금액 형식', modeSel)),
      splitBox, oneBox, preview, h('div', {}, btn)));
    paint();
  }
  $view.replaceChildren(h('div', {}, section('upload', h('p', { class: 'muted' }, '같은 날짜·금액·메모의 거래는 중복으로 보고 건너뜁니다. 메모에 자동 분류 규칙(budget 화면)이 적용돼요.'), drop, out)));
}

// ---------- 예산·분류 ----------
async function budget() {
  const [bs, rules] = await Promise.all([api(`/api/budgets?month=${month}`), api('/api/rules')]);
  const bmap = Object.fromEntries(bs.map((b) => [b.category_id, b.amount]));
  const exp = cats.filter((c) => c.type === 'expense');
  const body = h('tbody', {}, exp.map((c) => {
    const inp = h('input', { type: 'number', min: 0, step: 1000, inputmode: 'numeric', value: bmap[c.id] || '', 'aria-label': `${c.name} 월 예산`, style: 'max-width:160px',
      onchange: guard(async () => { await api('/api/budgets', { method: 'PUT', body: { month, category_id: c.id, amount: Number(inp.value || 0) } }); toast(`${c.name} 예산 저장`); }) });
    const nat = h('select', { 'aria-label': `${c.name} 성격`, onchange: guard(async () => { await api(`/api/categories/${c.id}`, { method: 'PATCH', body: { cost_nature: nat.value } }); c.cost_nature = nat.value; toast('저장했어요'); }) },
      h('option', { value: 'variable', selected: c.cost_nature === 'variable' }, '변동비'), h('option', { value: 'fixed', selected: c.cost_nature === 'fixed' }, '고정비'));
    return h('tr', {}, h('td', {}, c.name), h('td', {}, nat), h('td', { class: 'num' }, inp));
  }));
  const kw = h('input', { type: 'text', placeholder: '스타벅스', required: true });
  const kcat = h('select', {}, catOptions('expense', '', false));
  const rform = h('form', { class: 'form card', onsubmit: guard(async (e) => {
    e.preventDefault();
    const r = await api('/api/rules', { method: 'POST', body: { keyword: kw.value, category_id: kcat.value } });
    toast(`규칙 추가 · 기존 미분류 ${r.applied}건에 적용`); render();
  }) }, h('label', {}, '메모에 포함된 단어', kw), h('label', {}, '분류할 카테고리', kcat), h('button', { class: 'btn', type: 'submit' }, '규칙 추가'));
  const ncat = h('input', { type: 'text', placeholder: '새 카테고리 이름', required: true });
  const ntype = h('select', {}, h('option', { value: 'expense' }, '지출'), h('option', { value: 'income' }, '수입'));
  const cform = h('form', { class: 'form card', onsubmit: guard(async (e) => {
    e.preventDefault(); await api('/api/categories', { method: 'POST', body: { name: ncat.value, type: ntype.value } }); await loadCats(); toast('카테고리 추가'); render();
  }) }, h('label', {}, '이름', ncat), h('label', {}, '종류', ntype), h('button', { class: 'btn', type: 'submit' }, '카테고리 추가'));

  $view.replaceChildren(h('div', {},
    section('budget', h('div', { class: 'toolbar' }, h('p', { class: 'muted' }, '월 예산을 정하면 대시보드 리본에 한도선이 생기고, 넘으면 노란색으로 바뀌어요.'), monthBar(render)),
      h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, '카테고리'), h('th', {}, '성격'), h('th', { class: 'num' }, `${month} 예산(원)`))), body))),
    section('rules', h('p', { class: 'muted' }, '메모에 단어가 들어 있으면 자동으로 카테고리를 붙여요.'), rform,
      h('ul', { class: 'notes' }, rules.length ? rules.map((r) => h('li', {}, h('span', { class: 'tag' }, r.category), h('span', {}, `"${r.keyword}"`),
        h('button', { class: 'btn ghost sm', style: 'margin-left:auto', 'aria-label': `${r.keyword} 규칙 삭제`, onclick: guard(async () => { await api(`/api/rules/${r.id}`, { method: 'DELETE' }); render(); }) }, '삭제'))) : [h('li', { class: 'muted' }, '아직 규칙이 없어요.')])),
    section('categories', cform),
    section('data', dataPanel())));
}

function dataPanel() {
  const file = h('input', { type: 'file', accept: 'application/json,.json', 'aria-label': '백업 파일 선택', onchange: guard(async () => {
    const f = file.files[0]; if (!f) return;
    let d; try { d = JSON.parse(await f.text()); } catch { throw new Error('JSON 파일을 읽을 수 없어요'); }
    if (!confirm('지금 데이터를 백업 파일의 내용으로 바꿀까요?')) { file.value = ''; return; }
    await api('/api/restore', { method: 'POST', body: d }); cats = []; toast('복원했어요'); render();
  }) });
  const btn = (label, fn, ghost = true) => h('button', { class: `btn${ghost ? ' ghost' : ''}`, type: 'button', onclick: guard(fn) }, label);
  return h('div', {},
    h('p', { class: 'muted' }, '데이터는 이 브라우저에만 저장돼요. 서버로 보내지 않아서 다른 사람이 볼 수 없지만, 브라우저 데이터를 지우거나 다른 기기에서 열면 보이지 않아요. 가끔 백업해 두세요.'),
    h('div', { class: 'form card', style: 'margin-top:16px' },
      btn('백업 내려받기', async () => {
        const d = await api('/api/export');
        const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(d)], { type: 'application/json' })), download: `ledger-backup-${new Date().toISOString().slice(0, 10)}.json` });
        document.body.append(a); a.click(); a.remove(); toast('백업 파일을 내려받았어요');
      }, false),
      h('label', {}, '백업 불러오기', file),
      btn('샘플 데이터 넣기', async () => { await api('/api/sample', { method: 'POST', body: {} }); toast('샘플을 넣었어요'); location.hash = '#/'; render(); }),
      btn('모든 데이터 지우기', async () => {
        if (!confirm('이 브라우저의 거래·예산·규칙을 모두 지울까요? 되돌릴 수 없어요.')) return;
        await api('/api/reset', { method: 'POST', body: {} }); cats = []; toast('모두 지웠어요'); render();
      })));
}

// ---------- 절약 인사이트 ----------
async function saving() {
  const [ins, s] = await Promise.all([api(`/api/insights?month=${month}`), api(`/api/summary?month=${month}`)]);
  const groups = [['over', '예산을 넘긴 항목'], ['near', '예산이 얼마 안 남은 항목'], ['spike', '평균보다 늘어난 항목'], ['recurring', '매달 반복되는 결제'], ['small', '소액 결제가 쌓인 곳']];
  const blocks = groups.map(([k, t]) => { const it = ins.items.filter((i) => i.kind === k); return it.length ? h('div', {}, h('p', { class: 'eyebrow', style: 'margin-top:28px' }, t), noteList(it)) : null; });
  const top = ins.topVariable;
  const topBlock = top.length ? h('div', {}, h('p', { class: 'eyebrow', style: 'margin-top:28px' }, '줄이기 쉬운 변동비 상위 3'), h('ul', { class: 'notes' },
    top.map((c, i) => h('li', {}, h('span', { class: 'tag' }, `${i + 1}`), h('span', {}, `${c.name} ${won(c.total)}`))))) : null;
  $view.replaceChildren(h('div', {},
    section('saving', h('div', { class: 'toolbar' }, h('p', { class: 'muted' }, `고정비 ${won(s.fixed)} · 변동비 ${won(s.variable)}. 변동비부터 줄이는 게 가장 쉬워요.`), monthBar(render)),
      topBlock, ...blocks, !ins.items.length && !top.length ? h('p', { class: 'empty' }, '분석할 지출이 아직 없어요.') : null)));
}

// ---------- 라우터 ----------
const routes = { '': dashboard, transactions, upload, budget, saving };
async function render() {
  const key = location.hash.replace(/^#\/?/, '');
  const fn = routes[key] || dashboard;
  document.querySelectorAll('nav a').forEach((a) => (a.dataset.route === key ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  if (!storageOk) toast('이 브라우저에서는 저장이 안 될 수 있어요 (시크릿 모드 등)');
  try { if (!cats.length) await loadCats(); await fn(); }
  catch (e) { $view.replaceChildren(h('p', { class: 'empty' }, `불러오지 못했어요: ${e.message}`)); }
}
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
render();
