// 브라우저 저장소 기반 API: 서버·로그인 없이 같은 인터페이스(api(path, opts))를 제공한다.
// 데이터는 이 브라우저(localStorage)에만 저장되고 어디로도 전송되지 않는다.
const KEY = 'ledger.v1';

const DEFAULT_CATEGORIES = [
  ['식비', 'expense', 'variable'], ['교통', 'expense', 'variable'], ['주거·통신', 'expense', 'fixed'],
  ['쇼핑', 'expense', 'variable'], ['문화·여가', 'expense', 'variable'], ['건강', 'expense', 'variable'],
  ['구독', 'expense', 'fixed'], ['기타', 'expense', 'variable'],
  ['급여', 'income', 'fixed'], ['부수입', 'income', 'variable'], ['기타수입', 'income', 'variable'],
];

const fresh = () => ({
  v: 1, seq: { cat: DEFAULT_CATEGORIES.length, tx: 0, rule: 0 },
  categories: DEFAULT_CATEGORIES.map(([name, type, cost_nature], i) => ({ id: i + 1, name, type, cost_nature })),
  transactions: [], budgets: [], rules: [],
});

export let storageOk = true;
let db = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) { const d = JSON.parse(raw); if (valid(d)) return d; }
  } catch { storageOk = false; }
  return fresh();
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); storageOk = true; } catch { storageOk = false; throw new Error('브라우저 저장공간에 쓸 수 없어요 (시크릿 모드이거나 공간이 가득 찼어요)'); }
}

// ---------- 검증·유틸 ----------
const monthOk = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m || '');
const dateOk = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !Number.isNaN(Date.parse(d));
const shiftMonth = (m, delta) => {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(y, mo - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const fail = (msg) => { throw new Error(msg); };
const cat = (id) => db.categories.find((c) => c.id === id);

function valid(d) {
  const isArr = (a) => Array.isArray(a);
  return d && d.v === 1 && isArr(d.categories) && isArr(d.transactions) && isArr(d.budgets) && isArr(d.rules) && d.seq
    && d.categories.every((c) => Number.isInteger(c.id) && typeof c.name === 'string' && ['income', 'expense'].includes(c.type) && ['fixed', 'variable'].includes(c.cost_nature))
    && d.transactions.every((t) => Number.isInteger(t.id) && dateOk(t.date) && ['income', 'expense'].includes(t.type) && Number.isInteger(t.amount) && t.amount > 0 && typeof t.memo === 'string')
    && d.budgets.every((b) => Number.isInteger(b.category_id) && monthOk(b.month) && Number.isInteger(b.amount))
    && d.rules.every((r) => Number.isInteger(r.id) && typeof r.keyword === 'string' && Number.isInteger(r.category_id));
}

function validateTx(t) {
  if (!dateOk(t.date)) return '날짜 형식이 올바르지 않습니다 (YYYY-MM-DD)';
  if (!['income', 'expense'].includes(t.type)) return '구분은 income 또는 expense';
  if (!Number.isInteger(t.amount) || t.amount <= 0) return '금액은 1 이상의 정수';
  if (t.category_id != null) {
    const c = cat(t.category_id);
    if (!c) return '존재하지 않는 카테고리';
    if (c.type !== t.type) return '카테고리 종류(수입/지출)가 거래 구분과 다릅니다';
  }
  return null;
}
const classify = (memo) => {
  if (!memo) return null;
  const lower = memo.toLowerCase();
  return db.rules.find((r) => lower.includes(r.keyword.toLowerCase()))?.category_id ?? null;
};
const cleanTx = (b) => ({ date: b.date, type: b.type, amount: Number(b.amount), category_id: b.category_id ? Number(b.category_id) : null,
  memo: String(b.memo || '').slice(0, 200), payment_method: String(b.payment_method || '').slice(0, 40) });

function categoryTotals(month) {
  const map = new Map();
  for (const t of db.transactions) {
    if (t.type !== 'expense' || !t.date.startsWith(month)) continue;
    const id = t.category_id ?? 0;
    const c = map.get(id) || { id, name: id ? (cat(id)?.name ?? '미분류') : '미분류', cost_nature: id ? (cat(id)?.cost_nature ?? 'variable') : 'variable', total: 0, n: 0 };
    c.total += t.amount; c.n++; map.set(id, c);
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

// ---------- 핸들러 ----------
const txOut = (t) => ({ ...t, category: t.category_id ? cat(t.category_id)?.name ?? null : null });

const routes = {
  'GET /api/categories': () => db.categories.slice().sort((a, b) => (a.type < b.type ? 1 : a.type > b.type ? -1 : a.id - b.id)),
  'POST /api/categories': ({ body }) => {
    const name = String(body.name || '').trim().slice(0, 40);
    if (!name || !['income', 'expense'].includes(body.type)) fail('이름과 종류가 필요합니다');
    if (db.categories.some((c) => c.name === name && c.type === body.type)) fail('이미 있는 카테고리입니다');
    const id = ++db.seq.cat;
    db.categories.push({ id, name, type: body.type, cost_nature: body.cost_nature === 'fixed' ? 'fixed' : 'variable' });
    save(); return { id };
  },
  'PATCH /api/categories/:id': ({ params, body }) => {
    if (!['fixed', 'variable'].includes(body.cost_nature)) fail('cost_nature 값 오류');
    const c = cat(params.id) || fail('없는 카테고리입니다');
    c.cost_nature = body.cost_nature; save(); return { ok: true };
  },

  'GET /api/transactions': ({ query }) => {
    const m = query.get('month'); if (!monthOk(m)) fail('month=YYYY-MM 필요');
    return db.transactions.filter((t) => t.date.startsWith(m)).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id)).map(txOut);
  },
  'POST /api/transactions': ({ body }) => {
    const t = cleanTx(body);
    if (t.category_id == null && t.type === 'expense') t.category_id = classify(t.memo);
    const err = validateTx(t); if (err) fail(err);
    const id = ++db.seq.tx; db.transactions.push({ id, ...t, source: 'manual' }); save(); return { id };
  },
  'PUT /api/transactions/:id': ({ params, body }) => {
    const t = cleanTx(body); const err = validateTx(t); if (err) fail(err);
    const cur = db.transactions.find((x) => x.id === params.id) || fail('없는 거래입니다');
    Object.assign(cur, t); save(); return { ok: true };
  },
  'DELETE /api/transactions/:id': ({ params }) => {
    const i = db.transactions.findIndex((x) => x.id === params.id); if (i < 0) fail('없는 거래입니다');
    db.transactions.splice(i, 1); save(); return { ok: true };
  },

  'POST /api/import': ({ body }) => {
    if (!Array.isArray(body.rows) || body.rows.length === 0) fail('가져올 행이 없습니다');
    if (body.rows.length > 50000) fail('한 번에 50,000행까지 가능합니다');
    const k = (t) => `${t.date}|${t.type}|${t.amount}|${t.memo}`;
    const seen = new Set(db.transactions.map(k));
    let added = 0, duplicate = 0, invalid = 0;
    for (const r of body.rows) {
      const t = { date: r?.date, type: r?.type, amount: Number(r?.amount), memo: String(r?.memo || '').slice(0, 200), payment_method: '' };
      t.category_id = t.type === 'expense' ? classify(t.memo) : null;
      if (validateTx(t)) { invalid++; continue; }
      if (seen.has(k(t))) { duplicate++; continue; }
      seen.add(k(t)); db.transactions.push({ id: ++db.seq.tx, ...t, source: 'upload' }); added++;
    }
    save(); return { added, duplicate, invalid };
  },

  'GET /api/budgets': ({ query }) => {
    const m = query.get('month'); if (!monthOk(m)) fail('month=YYYY-MM 필요');
    return db.budgets.filter((b) => b.month === m).map(({ category_id, amount }) => ({ category_id, amount }));
  },
  'PUT /api/budgets': ({ body }) => {
    if (!monthOk(body.month)) fail('month 오류');
    const amount = Number(body.amount), cid = Number(body.category_id);
    if (!Number.isInteger(amount) || amount < 0) fail('예산은 0 이상의 정수');
    if (cat(cid)?.type !== 'expense') fail('존재하지 않는 카테고리');
    db.budgets = db.budgets.filter((b) => !(b.category_id === cid && b.month === body.month));
    if (amount > 0) db.budgets.push({ category_id: cid, month: body.month, amount });
    save(); return { ok: true };
  },

  'GET /api/rules': () => db.rules.slice().reverse().map((r) => ({ id: r.id, keyword: r.keyword, category: cat(r.category_id)?.name ?? '' })),
  'POST /api/rules': ({ body }) => {
    const kw = String(body.keyword || '').trim().slice(0, 60), cid = Number(body.category_id);
    if (!kw || cat(cid)?.type !== 'expense') fail('키워드와 지출 카테고리가 필요합니다');
    if (db.rules.some((r) => r.keyword === kw)) fail('이미 있는 키워드입니다');
    db.rules.push({ id: ++db.seq.rule, keyword: kw, category_id: cid });
    let applied = 0;
    for (const t of db.transactions) if (t.type === 'expense' && t.category_id == null && t.memo.toLowerCase().includes(kw.toLowerCase())) { t.category_id = cid; applied++; }
    save(); return { applied };
  },
  'DELETE /api/rules/:id': ({ params }) => { db.rules = db.rules.filter((r) => r.id !== params.id); save(); return { ok: true }; },

  'GET /api/summary': ({ query }) => {
    const m = query.get('month'); if (!monthOk(m)) fail('month=YYYY-MM 필요');
    let income = 0, expense = 0;
    for (const t of db.transactions) if (t.date.startsWith(m)) { if (t.type === 'income') income += t.amount; else expense += t.amount; }
    const budgets = Object.fromEntries(db.budgets.filter((b) => b.month === m).map((b) => [b.category_id, b.amount]));
    const prev = Object.fromEntries(categoryTotals(shiftMonth(m, -1)).map((c) => [c.id, c.total]));
    const categories = categoryTotals(m).map((c) => ({ ...c, budget: budgets[c.id] || 0, prev: prev[c.id] || 0 }));
    const fixed = categories.filter((c) => c.cost_nature === 'fixed').reduce((a, c) => a + c.total, 0);
    return { month: m, income, expense, balance: income - expense, fixed, variable: expense - fixed, categories };
  },

  'GET /api/insights': ({ query }) => {
    const m = query.get('month'); if (!monthOk(m)) fail('month=YYYY-MM 필요');
    const cur = categoryTotals(m);
    const hist = [1, 2, 3].map((i) => categoryTotals(shiftMonth(m, -i)));
    const items = [];
    for (const c of cur) {
      const past = hist.map((h) => h.find((x) => x.id === c.id)?.total).filter((v) => v != null);
      if (!past.length) continue;
      const avg = past.reduce((a, b) => a + b, 0) / past.length;
      if (avg > 0 && c.total >= avg * 1.2 && c.total - avg >= 10000) {
        items.push({ kind: 'spike', category: c.name, amount: c.total - Math.round(avg),
          text: `${c.name}이(가) 최근 ${past.length}개월 평균보다 ${Math.round((c.total / avg - 1) * 100)}% 늘었어요 (+${Math.round(c.total - avg).toLocaleString()}원).` });
      }
    }
    for (const b of db.budgets.filter((x) => x.month === m)) {
      const c = cur.find((x) => x.id === b.category_id); if (!c) continue;
      const pct = c.total / b.amount;
      if (pct >= 1) items.push({ kind: 'over', category: c.name, amount: c.total - b.amount, text: `${c.name} 예산을 ${(c.total - b.amount).toLocaleString()}원 넘겼어요.` });
      else if (pct >= 0.8) items.push({ kind: 'near', category: c.name, amount: b.amount - c.total, text: `${c.name} 예산의 ${Math.round(pct * 100)}%를 썼어요. 남은 ${(b.amount - c.total).toLocaleString()}원.` });
    }
    const monthTx = db.transactions.filter((t) => t.type === 'expense' && t.date.startsWith(m) && t.memo);
    const smallMap = new Map();
    for (const t of monthTx) if (t.amount < 10000) { const s = smallMap.get(t.memo) || { n: 0, s: 0 }; s.n++; s.s += t.amount; smallMap.set(t.memo, s); }
    [...smallMap].filter(([, s]) => s.n >= 10).sort((a, b) => b[1].s - a[1].s).slice(0, 3)
      .forEach(([memo, s]) => items.push({ kind: 'small', category: memo, amount: s.s, text: `"${memo}" 소액 결제가 ${s.n}회, 합계 ${s.s.toLocaleString()}원이에요.` }));
    const prevKeys = new Set(db.transactions.filter((t) => t.type === 'expense' && t.date.startsWith(shiftMonth(m, -1)) && t.memo).map((t) => `${t.memo}|${t.amount}`));
    const rec = new Map();
    for (const t of monthTx) if (prevKeys.has(`${t.memo}|${t.amount}`)) rec.set(`${t.memo}|${t.amount}`, t);
    [...rec.values()].sort((a, b) => b.amount - a.amount).slice(0, 5)
      .forEach((t) => items.push({ kind: 'recurring', category: t.memo, amount: t.amount, text: `"${t.memo}" ${t.amount.toLocaleString()}원이 매달 반복돼요. 계속 필요한지 확인해 보세요.` }));
    const topVariable = cur.filter((c) => c.cost_nature === 'variable').slice(0, 3).map((c) => ({ name: c.name, total: c.total }));
    return { items, topVariable };
  },

  // ----- 데이터 관리 -----
  'GET /api/export': () => db,
  'POST /api/restore': ({ body }) => {
    if (!valid(body)) fail('올바른 백업 파일이 아니에요');
    db = body; save(); return { ok: true };
  },
  'POST /api/reset': () => { db = fresh(); save(); return { ok: true }; },
  'POST /api/sample': () => {
    if (db.transactions.length) fail('이미 거래가 있어서 샘플을 넣지 않았어요');
    const id = (name) => db.categories.find((c) => c.name === name)?.id;
    const now = new Date();
    const add = (date, type, amount, name, memo) => db.transactions.push({ id: ++db.seq.tx, date, type, amount: Math.round(amount), category_id: id(name) ?? null, memo, payment_method: '', source: 'sample' });
    for (const back of [2, 1, 0]) {
      const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
      const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const grow = back === 0 ? 1.35 : 1;
      const e = (day, name, amt, memo) => add(`${m}-${String(day).padStart(2, '0')}`, 'expense', amt, name, memo);
      add(`${m}-25`, 'income', 3200000, '급여', '급여');
      e(1, '주거·통신', 550000, '월세'); e(3, '주거·통신', 55000, '통신비');
      e(5, '구독', 14900, '넷플릭스'); e(5, '구독', 10900, '유튜브 프리미엄');
      for (let i = 0; i < 12; i++) e(1 + i * 2, '식비', (6000 + (i % 4) * 2500) * grow, i % 3 ? '점심' : '스타벅스');
      e(8, '식비', 48000 * grow, '배달음식'); e(16, '식비', 52000 * grow, '배달음식');
      for (let i = 0; i < 8; i++) e(2 + i * 3, '교통', 3100, '지하철');
      e(10, '쇼핑', 89000 * grow, '의류'); e(21, '쇼핑', 42000, '생활용품');
      e(14, '문화·여가', 28000, '영화·전시'); e(27, '건강', 35000, '약국');
    }
    save(); return { ok: true };
  },
};

// 'PUT /api/transactions/12' → 'PUT /api/transactions/:id' 로 매칭
function match(method, pathname) {
  const exact = routes[`${method} ${pathname}`];
  if (exact) return { fn: exact, params: {} };
  const m = pathname.match(/^(\/api\/[a-z]+)\/(\d+)$/);
  if (m && routes[`${method} ${m[1]}/:id`]) return { fn: routes[`${method} ${m[1]}/:id`], params: { id: Number(m[2]) } };
  return null;
}

export async function api(path, opts = {}) {
  const url = new URL(path, 'http://local');
  const hit = match((opts.method || 'GET').toUpperCase(), url.pathname) || fail('지원하지 않는 요청이에요');
  // 호출 측이 결과를 마음대로 고쳐도 저장 데이터가 바뀌지 않도록 복사해서 돌려준다
  return structuredClone(hit.fn({ params: hit.params, query: url.searchParams, body: opts.body || {} }));
}
