// 화면 확인용 샘플 데이터: npm run seed -- 가입한이메일@example.com
// 해당 계정(먼저 가입 필요)에 거래가 하나도 없을 때만 넣는다. 로컬 DB(또는 .env의 Turso)에 적용된다.
import { all, get, batch, ready } from './lib/db.js';

const email = (process.argv[2] || '').trim().toLowerCase();
if (!email) { console.log('사용법: npm run seed -- 가입한이메일@example.com'); process.exit(1); }
await ready;
const user = await get('SELECT id FROM users WHERE email=?', [email]);
if (!user) { console.log('그 이메일로 가입한 계정이 없어요. 먼저 화면에서 가입해 주세요.'); process.exit(1); }
const uid = user.id;
if ((await get('SELECT COUNT(*) c FROM transactions WHERE user_id=?', [uid])).c > 0) { console.log('이미 거래가 있어 샘플을 넣지 않았어요.'); process.exit(0); }

const ids = Object.fromEntries((await all('SELECT id, name FROM categories WHERE user_id=?', [uid])).map((c) => [c.name, c.id]));
const stmts = [];
const add = (date, type, amount, cat, memo) => stmts.push({
  sql: "INSERT INTO transactions (user_id,date,type,amount,category_id,memo,source) VALUES (?,?,?,?,?,?,'seed')",
  args: [uid, date, type, Math.round(amount), ids[cat], memo] });
const now = new Date();
for (const back of [2, 1, 0]) {
  const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
  const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const grow = back === 0 ? 1.35 : 1;
  const e = (day, cat, amt, memo) => add(`${m}-${String(day).padStart(2, '0')}`, 'expense', amt, cat, memo);
  add(`${m}-25`, 'income', 3200000, '급여', '급여');
  e(1, '주거·통신', 550000, '월세'); e(3, '주거·통신', 55000, '통신비');
  e(5, '구독', 14900, '넷플릭스'); e(5, '구독', 10900, '유튜브 프리미엄');
  for (let i = 0; i < 12; i++) e(1 + i * 2, '식비', (6000 + (i % 4) * 2500) * grow, i % 3 ? '점심' : '스타벅스');
  e(8, '식비', 48000 * grow, '배달음식'); e(16, '식비', 52000 * grow, '배달음식');
  for (let i = 0; i < 8; i++) e(2 + i * 3, '교통', 1550 * 2, '지하철');
  e(10, '쇼핑', 89000 * grow, '의류'); e(21, '쇼핑', 42000, '생활용품');
  e(14, '문화·여가', 28000, '영화·전시'); e(27, '건강', 35000, '약국');
}
await batch(stmts);
console.log(`${email} 계정에 샘플 데이터 ${stmts.length}건을 넣었어요.`);
