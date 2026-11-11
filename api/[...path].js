// Vercel 서버리스 함수: /api/* 요청을 모두 여기서 처리한다.
import { handleApi } from '../lib/app.js';

export default function handler(req, res) {
  return handleApi(req, res);
}
