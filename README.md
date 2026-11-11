# ledger. — 개인 가계부

입출금 내역을 입력하면 어디에 쓰는지 **움직이는 리본 길이**로 보여주고, 아낄 곳을 짚어주는 가계부.

**🔗 데모: https://ledger-app-roan-eight.vercel.app/#/**

- 서버·로그인·DB 없음. 순수 HTML/CSS/JS 정적 사이트
- 데이터는 **각자의 브라우저(localStorage)에만 저장**됩니다. 어디로도 전송되지 않아 다른 사람이 볼 수 없어요
- 대신 브라우저 데이터를 지우거나 다른 기기에서 열면 보이지 않으니, budget 화면의 "백업 내려받기"로 가끔 백업하세요

## 로컬 실행

```bash
npm run dev     # http://localhost:3000
```

화면 확인용 샘플은 대시보드의 "샘플 데이터로 둘러보기" 또는 budget 화면 아래 data 섹션에서 넣을 수 있어요.

## 배포 (Vercel, 무료)

환경변수·DB 설정이 필요 없습니다.

1. 이 저장소를 Vercel에서 Import
2. Framework Preset `Other`, 나머지는 그대로 (`vercel.json`에 `public/` 폴더를 배포하도록 설정됨)
3. Deploy

## 기능

- 거래 수동 입력·수정·삭제, 검색·필터
- CSV 업로드(열 매핑·미리보기·중복 건너뛰기, EUC-KR 자동 인식). 엑셀은 CSV로 저장해서 올리기
- 카테고리별 월 예산, 고정비/변동비 구분, 메모 키워드 자동 분류 규칙
- 절약 후보: 평균 대비 증가, 예산 초과·임박, 소액 반복, 매달 반복되는 결제
- 백업 내려받기·불러오기, 전체 삭제

## 구조

```
public/index.html, style.css   화면
public/app.js                  화면 로직 (대시보드, 거래, 업로드, 예산, 절약)
public/ribbon.js               리본 애니메이션 (canvas)
public/local-api.js            브라우저 저장소 기반 데이터·분석 로직
server.js                      로컬 확인용 정적 서버
```
