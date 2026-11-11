// DB 연결: libSQL(SQLite 호환). 로컬에서는 파일, 배포에서는 Turso(무료 플랜)를 쓴다.
//   로컬:  환경변수 없음 → data/ledger.db 파일
//   배포:  TURSO_DATABASE_URL, TURSO_AUTH_TOKEN
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let url = process.env.TURSO_DATABASE_URL;
let configError = null;
if (!url && process.env.VERCEL) {
  // 배포 환경에서 환경변수가 빠진 경우: 앱은 뜨되 API가 원인을 알려주도록 한다
  configError = new Error('CONFIG: Vercel 환경변수 TURSO_DATABASE_URL / TURSO_AUTH_TOKEN 이 설정되지 않았어요');
  url = 'file:/tmp/unconfigured.db';
} else if (!url) {
  const file = process.env.DB_FILE || path.join(root, 'data', 'ledger.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  url = `file:${file}`;
}
export const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

const plain = (rs) => rs.rows.map((r) => Object.fromEntries(rs.columns.map((c, i) => [c, r[i]])));
export const all = async (sql, args = []) => plain(await client.execute({ sql, args }));
export const get = async (sql, args = []) => (await all(sql, args))[0];
export const run = async (sql, args = []) => {
  const rs = await client.execute({ sql, args });
  return { changes: rs.rowsAffected, lastId: rs.lastInsertRowid != null ? Number(rs.lastInsertRowid) : null };
};
// 여러 문장을 한 번의 왕복으로, 하나의 트랜잭션으로 실행 (전부 성공하거나 전부 취소)
export const batch = (stmts) => client.batch(stmts, 'write');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('income','expense')),
  cost_nature TEXT NOT NULL DEFAULT 'variable' CHECK (cost_nature IN ('fixed','variable')),
  UNIQUE(user_id, name, type)
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('income','expense')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  payment_method TEXT DEFAULT '',
  memo TEXT DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tx_user_date ON transactions(user_id, date);
CREATE TABLE IF NOT EXISTS budgets (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  amount INTEGER NOT NULL,
  PRIMARY KEY (user_id, category_id, month)
);
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  UNIQUE(user_id, keyword)
);
CREATE TABLE IF NOT EXISTS upload_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename TEXT, row_count INTEGER, uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS attempts (        -- 로그인·가입 시도 제한 (서버리스에서도 유지되도록 DB에 저장)
  key TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
`;
// 콜드 스타트마다 한 번만 실행
export const ready = configError ? Promise.reject(configError) : client.executeMultiple(SCHEMA);
ready.catch(() => {}); // 처리되지 않은 rejection으로 함수가 죽지 않게 (요청 시 handleApi가 에러를 응답)
