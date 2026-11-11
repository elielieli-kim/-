// API 핸들러 (로컬 server.js와 Vercel api/[...path].js가 함께 사용)
// 계정별 데이터 분리: 모든 데이터 테이블에 user_id가 있고, 모든 쿼리가 로그인한 사용자의 user_id로 제한된다.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { all, get, run, batch, ready } from './db.js';

const scrypt = promisify(crypto.scrypt);
const PROD = process.env.NODE_ENV === 'production';
const SESSION_DAYS = 30;

const DEFAULT_CATEGORIES = [
  ['식비', 'expense', 'variable'], ['교통', 'expense', 'variable'], ['주거·통신', 'expense', 'fixed'],
  ['쇼핑', 'expense', 'variable'], ['문화·여가', 'expense', 'variable'], ['건강', 'expense', 'variable'],
  ['구독', 'expense', 'fixed'], ['기타', 'expense', 'variable'],
  ['급여', 'income', 'fixed'], ['부수입', 'income', 'variable'], ['기타수입', 'income', 'variable'],
];

// ---------- 유틸 ----------
const monthOk = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m || '');
const dateOk = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !Number.isNaN(Date.parse(d));
const shiftMonth = (m, delta) => {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(y, mo - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const bad = (msg, status = 400) => ({ status, body: { error: msg } });
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const ownsCategory = async (uid, id, type) =>
  Number.isInteger(id) && !!(await get(`SELECT 1 FROM categories WHERE id=? AND user_id=?${type ? ' AND type=?' : ''}`, type ? [id, uid, type] : [id, uid]));

async function validateTx(uid, b) {
  if (!dateOk(b.date)) return '날짜 형식이 올바르지 않습니다 (YYYY-MM-DD)';
  if (!['income', 'expense'].includes(b.type)) return '구분은 income 또는 expense';
  if (!Number.isInteger(b.amount) || b.amount <= 0) return '금액은 1 이상의 정수';
  if (b.category_id != null) {
    const c = await get('SELECT type FROM categories WHERE id=? AND user_id=?', [b.category_id, uid]);
    if (!c) return '존재하지 않는 카테고리';
    if (c.type !== b.type) return '카테고리 종류(수입/지출)가 거래 구분과 다릅니다';
  }
  return null;
}
async function classify(uid, memo) {
  if (!memo) return null;
  const lower = memo.toLowerCase();
  const hit = (await all('SELECT keyword, category_id FROM rules WHERE user_id=?', [uid])).find((r) => lower.includes(r.keyword.toLowerCase()));
  return hit ? hit.category_id : null;
}

// ---------- 인증 ----------
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
async function verifyPassword(pw, stored) {
  const [, saltB64, hashB64] = stored.split('$');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(pw, Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}
const DUMMY_HASH = await hashPassword('dummy-password-for-timing'); // 없는 계정에도 같은 시간이 걸리게

const cookieHeader = (token, maxAgeSec) => `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${PROD ? '; Secure' : ''}`;
function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}
async function userFromRequest(req) {
  const token = readCookie(req, 'sid');
  if (!token) return null;
  const row = await get('SELECT u.id, u.email, s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?', [sha256(token)]);
  if (!row) return null;
  if (row.expires_at < Date.now()) { await run('DELETE FROM sessions WHERE token_hash=?', [sha256(token)]); return null; }
  return { id: row.id, email: row.email, token };
}
async function startSession(userId) {
  await run('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]);
  const token = crypto.randomBytes(32).toString('base64url');
  await run('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)', [sha256(token), userId, Date.now() + SESSION_DAYS * 864e5]);
  return cookieHeader(token, SESSION_DAYS * 86400);
}

// 시도 횟수 제한 (DB 저장: 서버리스 인스턴스가 바뀌어도 유지)
async function limited(key, max) {
  const a = await get('SELECT n, reset_at FROM attempts WHERE key=?', [key]);
  return !!a && a.reset_at > Date.now() && a.n >= max;
}
async function bump(key, windowMs) {
  const now = Date.now();
  await run(`INSERT INTO attempts (key,n,reset_at) VALUES (?,1,?)
    ON CONFLICT(key) DO UPDATE SET n = CASE WHEN reset_at < ? THEN 1 ELSE n + 1 END,
                                   reset_at = CASE WHEN reset_at < ? THEN ? ELSE reset_at END`, [key, now + windowMs, now, now, now + windowMs]);
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const normEmail = (e) => String(e || '').trim().toLowerCase();
const pwProblem = (p) => (typeof p !== 'string' || p.length < 8 ? '비밀번호는 8자 이상이어야 해요' : p.length > 128 ? '비밀번호는 128자 이하여야 해요' : null);

// ---------- 라우트 ----------
const routes = [];
const route = (method, pattern, handler, opts = {}) => routes.push({ method, re: new RegExp(`^${pattern}$`), handler, ...opts });

route('POST', '/api/auth/signup', async ({ body, ip }) => {
  const email = normEmail(body.email);
  if (!EMAIL_RE.test(email)) return bad('이메일 형식이 올바르지 않아요');
  const pw = pwProblem(body.password);
  if (pw) return bad(pw);
  if (await limited(`signup|${ip}`, 10)) return bad('잠시 후 다시 시도해 주세요', 429);
  await bump(`signup|${ip}`, 3600e3);
  if (await get('SELECT 1 FROM users WHERE email=?', [email])) return bad('이미 가입된 이메일이에요', 409);
  const hash = await hashPassword(body.password);
  try {
    // 사용자 + 기본 카테고리를 한 트랜잭션으로
    await batch([
      { sql: 'INSERT INTO users (email,password_hash) VALUES (?,?)', args: [email, hash] },
      ...DEFAULT_CATEGORIES.map(([name, type, nature]) => ({
        sql: 'INSERT INTO categories (user_id,name,type,cost_nature) VALUES ((SELECT id FROM users WHERE email=?),?,?,?)', args: [email, name, type, nature] })),
    ]);
  } catch (e) { if (/UNIQUE/i.test(String(e))) return bad('이미 가입된 이메일이에요', 409); throw e; }
  const u = await get('SELECT id FROM users WHERE email=?', [email]);
  return { status: 201, setCookie: await startSession(u.id), body: { email } };
}, { public: true });

route('POST', '/api/auth/login', async ({ body, ip }) => {
  const email = normEmail(body.email);
  const key = `login|${ip}|${email}`;
  if (await limited(key, 5)) return bad('로그인 시도가 너무 많아요. 15분 뒤에 다시 해 주세요', 429);
  const u = await get('SELECT id, password_hash FROM users WHERE email=?', [email]);
  const ok = await verifyPassword(String(body.password || ''), u ? u.password_hash : DUMMY_HASH);
  if (!u || !ok) { await bump(key, 15 * 60e3); return bad('이메일 또는 비밀번호가 올바르지 않아요', 401); }
  await run('DELETE FROM attempts WHERE key=? OR reset_at < ?', [key, Date.now()]);
  return { setCookie: await startSession(u.id), body: { email } };
}, { public: true });

route('POST', '/api/auth/logout', async ({ user }) => {
  if (user) await run('DELETE FROM sessions WHERE token_hash=?', [sha256(user.token)]);
  return { setCookie: cookieHeader('', 0), body: { ok: true } };
}, { public: true });

route('GET', '/api/auth/me', ({ user }) => (user ? { body: { email: user.email } } : bad('로그인이 필요해요', 401)), { public: true });

route('POST', '/api/auth/delete-account', async ({ user, body }) => {
  const u = await get('SELECT password_hash FROM users WHERE id=?', [user.id]);
  if (!(await verifyPassword(String(body.password || ''), u.password_hash))) return bad('비밀번호가 올바르지 않아요', 401);
  // 외래키 설정과 무관하게 동작하도록 직접 순서대로 삭제 (하나의 트랜잭션)
  await batch(['transactions', 'budgets', 'rules', 'upload_logs', 'categories', 'sessions'].map((t) => ({ sql: `DELETE FROM ${t} WHERE user_id=?`, args: [user.id] }))
    .concat([{ sql: 'DELETE FROM users WHERE id=?', args: [user.id] }]));
  return { setCookie: cookieHeader('', 0), body: { ok: true } };
});

// 카테고리
route('GET', '/api/categories', async ({ user }) => ({ body: await all('SELECT id,name,type,cost_nature FROM categories WHERE user_id=? ORDER BY type DESC, id', [user.id]) }));
route('POST', '/api/categories', async ({ user, body }) => {
  const name = String(body.name || '').trim().slice(0, 40);
  if (!name || !['income', 'expense'].includes(body.type)) return bad('이름과 종류가 필요합니다');
  try {
    const r = await run('INSERT INTO categories (user_id,name,type,cost_nature) VALUES (?,?,?,?)', [user.id, name, body.type, body.cost_nature === 'fixed' ? 'fixed' : 'variable']);
    return { status: 201, body: { id: r.lastId } };
  } catch { return bad('이미 있는 카테고리입니다', 409); }
});
route('PATCH', '/api/categories/(\\d+)', async ({ user, params, body }) => {
  if (!['fixed', 'variable'].includes(body.cost_nature)) return bad('cost_nature 값 오류');
  const r = await run('UPDATE categories SET cost_nature=? WHERE id=? AND user_id=?', [body.cost_nature, Number(params[0]), user.id]);
  return r.changes ? { body: { ok: true } } : bad('없는 카테고리입니다', 404);
});

// 거래
route('GET', '/api/transactions', async ({ user, query }) => {
  const m = query.get('month');
  if (!monthOk(m)) return bad('month=YYYY-MM 필요');
  return { body: await all(`
    SELECT t.id,t.date,t.type,t.amount,t.category_id,t.payment_method,t.memo, c.name AS category FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.user_id=? AND substr(t.date,1,7)=? ORDER BY t.date DESC, t.id DESC`, [user.id, m]) };
});
const cleanTx = (b) => ({ ...b, amount: Number(b.amount), category_id: b.category_id ? Number(b.category_id) : null, memo: String(b.memo || '').slice(0, 200), payment_method: String(b.payment_method || '').slice(0, 40) });
route('POST', '/api/transactions', async ({ user, body }) => {
  const tx = cleanTx(body);
  if (tx.category_id == null && tx.type === 'expense') tx.category_id = await classify(user.id, tx.memo);
  const err = await validateTx(user.id, tx);
  if (err) return bad(err);
  const r = await run('INSERT INTO transactions (user_id,date,type,amount,category_id,payment_method,memo,source) VALUES (?,?,?,?,?,?,?,?)',
    [user.id, tx.date, tx.type, tx.amount, tx.category_id, tx.payment_method, tx.memo, 'manual']);
  return { status: 201, body: { id: r.lastId } };
});
route('PUT', '/api/transactions/(\\d+)', async ({ user, params, body }) => {
  const tx = cleanTx(body);
  const err = await validateTx(user.id, tx);
  if (err) return bad(err);
  const r = await run('UPDATE transactions SET date=?,type=?,amount=?,category_id=?,payment_method=?,memo=? WHERE id=? AND user_id=?',
    [tx.date, tx.type, tx.amount, tx.category_id, tx.payment_method, tx.memo, Number(params[0]), user.id]);
  return r.changes ? { body: { ok: true } } : bad('없는 거래입니다', 404);
});
route('DELETE', '/api/transactions/(\\d+)', async ({ user, params }) => {
  const r = await run('DELETE FROM transactions WHERE id=? AND user_id=?', [Number(params[0]), user.id]);
  return r.changes ? { body: { ok: true } } : bad('없는 거래입니다', 404);
});

// CSV 가져오기: 클라이언트가 매핑을 끝낸 행 배열을 보낸다 (서버리스 시간 제한 때문에 한 번에 5,000행)
route('POST', '/api/import', async ({ user, body }) => {
  if (!Array.isArray(body.rows) || body.rows.length === 0) return bad('가져올 행이 없습니다');
  if (body.rows.length > 5000) return bad('한 번에 5,000행까지 가능합니다. 파일을 나눠서 올려 주세요');
  const rules = (await all('SELECT keyword, category_id FROM rules WHERE user_id=?', [user.id])).map((r) => [r.keyword.toLowerCase(), r.category_id]);
  const stmts = [];
  let invalid = 0;
  for (const r of body.rows) {
    const date = r?.date, type = r?.type, amount = Number(r?.amount), memo = String(r?.memo || '').slice(0, 200);
    if (!dateOk(date) || !['income', 'expense'].includes(type) || !Number.isInteger(amount) || amount <= 0) { invalid++; continue; }
    const lower = memo.toLowerCase();
    const cat = type === 'expense' ? (rules.find(([k]) => lower.includes(k))?.[1] ?? null) : null;
    // 같은 날짜·구분·금액·메모가 이미 있으면 넣지 않는다 (파일 안의 중복도 포함)
    stmts.push({ sql: `INSERT INTO transactions (user_id,date,type,amount,category_id,payment_method,memo,source)
      SELECT ?,?,?,?,?,'',?,'upload' WHERE NOT EXISTS (SELECT 1 FROM transactions WHERE user_id=? AND date=? AND type=? AND amount=? AND memo=?)`,
      args: [user.id, date, type, amount, cat, memo, user.id, date, type, amount, memo] });
  }
  let added = 0;
  for (let i = 0; i < stmts.length; i += 250) {
    const res = await batch(stmts.slice(i, i + 250));
    added += res.reduce((a, rs) => a + rs.rowsAffected, 0);
  }
  await run('INSERT INTO upload_logs (user_id,filename,row_count) VALUES (?,?,?)', [user.id, String(body.filename || '').slice(0, 200), added]);
  return { body: { added, duplicate: stmts.length - added, invalid } };
});

// 예산
route('GET', '/api/budgets', async ({ user, query }) => {
  const m = query.get('month');
  if (!monthOk(m)) return bad('month=YYYY-MM 필요');
  return { body: await all('SELECT category_id, amount FROM budgets WHERE user_id=? AND month=?', [user.id, m]) };
});
route('PUT', '/api/budgets', async ({ user, body }) => {
  if (!monthOk(body.month)) return bad('month 오류');
  const amount = Number(body.amount), cid = Number(body.category_id);
  if (!Number.isInteger(amount) || amount < 0) return bad('예산은 0 이상의 정수');
  if (!(await ownsCategory(user.id, cid, 'expense'))) return bad('존재하지 않는 카테고리');
  if (amount === 0) await run('DELETE FROM budgets WHERE user_id=? AND category_id=? AND month=?', [user.id, cid, body.month]);
  else await run('INSERT INTO budgets (user_id,category_id,month,amount) VALUES (?,?,?,?) ON CONFLICT(user_id,category_id,month) DO UPDATE SET amount=excluded.amount', [user.id, cid, body.month, amount]);
  return { body: { ok: true } };
});

// 자동 분류 규칙
route('GET', '/api/rules', async ({ user }) => ({
  body: await all('SELECT r.id, r.keyword, c.name AS category FROM rules r JOIN categories c ON c.id=r.category_id WHERE r.user_id=? ORDER BY r.id DESC', [user.id]),
}));
route('POST', '/api/rules', async ({ user, body }) => {
  const kw = String(body.keyword || '').trim().slice(0, 60);
  const cid = Number(body.category_id);
  if (!kw || !(await ownsCategory(user.id, cid, 'expense'))) return bad('키워드와 지출 카테고리가 필요합니다');
  try { await run('INSERT INTO rules (user_id,keyword,category_id) VALUES (?,?,?)', [user.id, kw, cid]); } catch { return bad('이미 있는 키워드입니다', 409); }
  const r = await run(`UPDATE transactions SET category_id=? WHERE user_id=? AND type='expense' AND category_id IS NULL AND instr(lower(memo), lower(?)) > 0`, [cid, user.id, kw]);
  return { status: 201, body: { applied: r.changes } };
});
route('DELETE', '/api/rules/(\\d+)', async ({ user, params }) => {
  await run('DELETE FROM rules WHERE id=? AND user_id=?', [Number(params[0]), user.id]);
  return { body: { ok: true } };
});

// 요약·인사이트
const categoryTotals = (uid, month) => all(`
  SELECT COALESCE(c.id,0) AS id, COALESCE(c.name,'미분류') AS name, COALESCE(c.cost_nature,'variable') AS cost_nature,
         SUM(t.amount) AS total, COUNT(*) AS n
  FROM transactions t LEFT JOIN categories c ON c.id=t.category_id
  WHERE t.user_id=? AND t.type='expense' AND substr(t.date,1,7)=? GROUP BY c.id ORDER BY total DESC`, [uid, month]);

route('GET', '/api/summary', async ({ user, query }) => {
  const m = query.get('month');
  if (!monthOk(m)) return bad('month=YYYY-MM 필요');
  const [sums, budgetRows, prevRows, curRows] = await Promise.all([
    all('SELECT type, SUM(amount) s FROM transactions WHERE user_id=? AND substr(date,1,7)=? GROUP BY type', [user.id, m]),
    all('SELECT category_id, amount FROM budgets WHERE user_id=? AND month=?', [user.id, m]),
    categoryTotals(user.id, shiftMonth(m, -1)),
    categoryTotals(user.id, m),
  ]);
  const income = sums.find((x) => x.type === 'income')?.s || 0;
  const expense = sums.find((x) => x.type === 'expense')?.s || 0;
  const budgets = Object.fromEntries(budgetRows.map((b) => [b.category_id, b.amount]));
  const prev = Object.fromEntries(prevRows.map((c) => [c.id, c.total]));
  const cats = curRows.map((c) => ({ ...c, budget: budgets[c.id] || 0, prev: prev[c.id] || 0 }));
  const fixed = cats.filter((c) => c.cost_nature === 'fixed').reduce((a, c) => a + c.total, 0);
  return { body: { month: m, income, expense, balance: income - expense, fixed, variable: expense - fixed, categories: cats } };
});

route('GET', '/api/insights', async ({ user, query }) => {
  const m = query.get('month');
  if (!monthOk(m)) return bad('month=YYYY-MM 필요');
  const uid = user.id;
  const prevMonth = shiftMonth(m, -1);
  const [cur, h1, h2, h3, budgetRows, small, recurring] = await Promise.all([
    categoryTotals(uid, m), categoryTotals(uid, shiftMonth(m, -1)), categoryTotals(uid, shiftMonth(m, -2)), categoryTotals(uid, shiftMonth(m, -3)),
    all('SELECT category_id, amount FROM budgets WHERE user_id=? AND month=?', [uid, m]),
    all(`SELECT memo, COUNT(*) n, SUM(amount) s FROM transactions
      WHERE user_id=? AND type='expense' AND substr(date,1,7)=? AND amount < 10000 AND memo <> '' GROUP BY memo HAVING n >= 10 ORDER BY s DESC LIMIT 3`, [uid, m]),
    all(`SELECT a.memo, a.amount FROM transactions a
      JOIN transactions b ON b.user_id=a.user_id AND b.memo=a.memo AND b.amount=a.amount AND b.type='expense' AND substr(b.date,1,7)=?
      WHERE a.user_id=? AND a.type='expense' AND substr(a.date,1,7)=? AND a.memo <> '' GROUP BY a.memo, a.amount ORDER BY a.amount DESC LIMIT 5`, [prevMonth, uid, m]),
  ]);
  const items = [];
  for (const c of cur) {
    const past = [h1, h2, h3].map((h) => h.find((x) => x.id === c.id)?.total).filter((v) => v != null);
    if (past.length === 0) continue;
    const avg = past.reduce((a, b) => a + b, 0) / past.length;
    if (avg > 0 && c.total >= avg * 1.2 && c.total - avg >= 10000) {
      items.push({ kind: 'spike', category: c.name, amount: c.total - Math.round(avg),
        text: `${c.name}이(가) 최근 ${past.length}개월 평균보다 ${Math.round((c.total / avg - 1) * 100)}% 늘었어요 (+${Math.round(c.total - avg).toLocaleString()}원).` });
    }
  }
  for (const b of budgetRows) {
    const c = cur.find((x) => x.id === b.category_id);
    if (!c) continue;
    const pct = c.total / b.amount;
    if (pct >= 1) items.push({ kind: 'over', category: c.name, amount: c.total - b.amount, text: `${c.name} 예산을 ${(c.total - b.amount).toLocaleString()}원 넘겼어요.` });
    else if (pct >= 0.8) items.push({ kind: 'near', category: c.name, amount: b.amount - c.total, text: `${c.name} 예산의 ${Math.round(pct * 100)}%를 썼어요. 남은 ${(b.amount - c.total).toLocaleString()}원.` });
  }
  for (const s of small) items.push({ kind: 'small', category: s.memo, amount: s.s, text: `"${s.memo}" 소액 결제가 ${s.n}회, 합계 ${s.s.toLocaleString()}원이에요.` });
  for (const r of recurring) items.push({ kind: 'recurring', category: r.memo, amount: r.amount, text: `"${r.memo}" ${r.amount.toLocaleString()}원이 매달 반복돼요. 계속 필요한지 확인해 보세요.` });
  const topVariable = cur.filter((c) => c.cost_nature === 'variable').slice(0, 3).map((c) => ({ name: c.name, total: c.total }));
  return { body: { items, topVariable } };
});

// ---------- HTTP 진입점 ----------
export const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
const send = (res, status, body, extra = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY, ...extra });
  res.end(JSON.stringify(body));
};
const clientIp = (req) => (process.env.VERCEL ? String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) { // Vercel이 미리 읽어 둔 경우
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString() || '{}');
    return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
  }
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 4e6) throw Object.assign(new Error('too large'), { status: 413 }); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

export async function handleApi(req, res) {
  const url = new URL(req.url, 'http://localhost');
  try {
    await ready;
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) return send(res, 404, { error: 'not found' });
    const mutating = req.method !== 'GET';
    if (mutating) {
      // CSRF 방어: JSON 요청만 받고, 다른 출처에서 온 요청은 거부
      if (!(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'JSON 요청만 가능해요' });
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: '허용되지 않은 출처예요' });
    }
    const user = await userFromRequest(req);
    if (!r.public && !user) return send(res, 401, { error: '로그인이 필요해요' });
    let body = {};
    if (mutating) {
      try { body = await readBody(req); } catch (e) { return send(res, e.status || 400, { error: e.status === 413 ? '요청이 너무 커요' : 'invalid json' }); }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) body = {};
    }
    const out = await r.handler({ user, params: url.pathname.match(r.re).slice(1), query: url.searchParams, body, ip: clientIp(req) });
    send(res, out.status || 200, out.body, out.setCookie ? { 'Set-Cookie': out.setCookie } : {});
  } catch (e) {
    console.error(e);
    send(res, 500, { error: String(e?.message || '').startsWith('CONFIG:') ? e.message : '서버 오류' });
  }
}
