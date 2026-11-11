// Vercel 서버리스 함수: vercel.json의 rewrite로 /api/* 요청이 모두 여기로 들어온다.
import { handleApi } from '../lib/app.js';

export default function handler(req, res) {
  // rewrite가 원래 경로를 __path 쿼리로 넘겨주는 경우를 대비해 URL을 복원한다.
  const u = new URL(req.url, 'http://localhost');
  const p = u.searchParams.get('__path');
  if (p !== null) {
    u.searchParams.delete('__path');
    req.url = `/api/${p}${u.search}`;
  }
  return handleApi(req, res);
}
