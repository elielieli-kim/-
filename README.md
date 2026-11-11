# ledger. — 개인 가계부

입출금 내역을 입력하면 어디에 쓰는지 **움직이는 리본 길이**로 보여주고, 아낄 곳을 짚어주는 가계부.
계정마다 데이터가 분리되어 있어 다른 사용자는 내 내역을 볼 수 없습니다.

- 프론트: 순수 HTML/CSS/JS (빌드 없음)
- 백엔드: Node.js, 의존성은 `@libsql/client` 하나
- DB: libSQL(SQLite 호환) — 로컬은 파일, 배포는 Turso 무료 플랜

## 로컬 실행

```bash
npm install
npm run dev          # http://localhost:3000  (data/ledger.db 파일 사용)
npm run seed -- 가입한이메일@example.com   # 선택: 샘플 데이터
```

## 무료 배포 (Vercel + Turso)

Vercel은 서버에 파일을 저장할 수 없어서, DB는 무료인 Turso에 둡니다.

1. **Turso DB 만들기** (https://turso.tech 가입 후, CLI 설치)
   ```bash
   turso db create ledger
   turso db show ledger --url          # → TURSO_DATABASE_URL
   turso db tokens create ledger       # → TURSO_AUTH_TOKEN
   ```
2. **GitHub에 올리기**: 이 폴더를 저장소로 만들어 push 합니다. (`.env`와 `data/`는 `.gitignore`로 제외됨)
3. **Vercel에서 가져오기**: vercel.com → Add New Project → 그 저장소 선택.
   Framework는 `Other`, 빌드 설정은 건드리지 않아도 됩니다(`vercel.json`에 있음).
4. **환경변수 등록** (Project → Settings → Environment Variables):
   `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`
5. Deploy. 처음 요청 때 테이블이 자동으로 만들어집니다.

배포 주소는 HTTPS이며, 로그인 쿠키는 `Secure`로 설정됩니다.

## 보안 메모

- 비밀번호는 scrypt 해시로만 저장, 로그인 쿠키는 HttpOnly·SameSite=Lax
- 모든 쿼리가 로그인한 사용자의 `user_id`로 제한됨 (다른 계정의 거래·카테고리 접근/수정 불가)
- 로그인 5회 실패 시 15분 잠금, JSON 요청만 허용 + 다른 출처 요청 거부(CSRF)
- 비밀번호 찾기(이메일 발송)는 아직 없음 — 잊으면 그 계정은 복구할 수 없음
- 이 서비스는 운영자가 DB를 직접 볼 수 있는 구조(앱 수준 분리)임. 민감한 정보를 불특정 다수에게 받는 용도라면 암호화·약관 등 추가 검토 필요

## 구조

```
public/        화면 (index.html, style.css, app.js, ribbon.js)
lib/app.js     API 전체 (인증, 거래, 예산, 규칙, 요약·인사이트)
lib/db.js      DB 연결과 스키마
api/[...path].js   Vercel 서버리스 진입점
server.js      로컬 개발 서버
seed.js        샘플 데이터
```
