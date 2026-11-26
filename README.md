# Kanban — 1인 개발자용 Jira-like 보드

**모든 변경(생성·수정·드래그·삭제)은 그 즉시 서버 DB에 저장**되고, 열려 있는 다른 브라우저/기기에도 실시간으로 반영됩니다.
같은 프론트엔드(`public/`)와 데이터 로직(`core.js`)으로 두 가지 방식으로 돌릴 수 있습니다.

| | Cloudflare (권장) | 직접 실행 (Node) |
|---|---|---|
| 서버 | Workers + Durable Object (`worker/index.js`) | `server.js` |
| DB | Durable Object 내장 SQLite | `data/kanban.db` (SQLite) |
| 실시간 | WebSocket | SSE |
| 비용 | 무료 플랜으로 충분 | 내 PC/서버 |

## Cloudflare에 배포

### 방법 A — 대시보드에서 GitHub 연결 (폰에서도 가능, 토큰 불필요)
1. Cloudflare 대시보드 → **Workers & Pages** → **Create** → **Import a repository**
2. GitHub 계정 연결 → 이 저장소 선택 → 배포할 브랜치 선택
3. 빌드 설정은 기본값 그대로 (Deploy command: `npx wrangler deploy`) → 배포
4. 배포된 Worker → **Settings → Variables and Secrets → Add** → 타입 **Secret**, 이름 `KANBAN_PASSWORD`, 값은 원하는 비밀번호 → 저장
5. `https://kanban.<내 서브도메인>.workers.dev` 접속 → 비밀번호로 로그인

이후 그 브랜치에 푸시할 때마다 자동 재배포됩니다. 데이터는 Durable Object에 있으므로 재배포해도 유지됩니다.

### 방법 B — 명령줄
```bash
npm install
npx wrangler login
npx wrangler secret put KANBAN_PASSWORD
npm run deploy
```

> `KANBAN_PASSWORD` 가 없으면 서버가 동작을 거부합니다 (공개 주소에서 누구나 수정하는 것 방지).
> 비밀번호를 바꾸면 모든 기기에서 다시 로그인해야 합니다.

로컬에서 Cloudflare 환경 그대로 테스트: `.dev.vars` 파일에 `KANBAN_PASSWORD=devpass` 를 적고 `npm run cf:dev` → http://localhost:8787

## 직접 실행 (Node)
```bash
node server.js                 # http://127.0.0.1:3000
```
Node **22.13 이상** 필요 (내장 `node:sqlite`). 런타임 의존성 없음.

| 환경변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `3000` | 포트 |
| `HOST` | `127.0.0.1` | 외부 접속 허용 시 `0.0.0.0` |
| `DB_PATH` | `./data/kanban.db` | SQLite 파일 위치 |
| `KANBAN_PASSWORD` | (없음) | 설정하면 로그인 필요. **외부에 공개할 때는 반드시 설정** |

Docker:
```bash
docker build -t kanban .
docker run -d --name kanban -p 3000:3000 -v kanban-data:/data -e KANBAN_PASSWORD=비밀번호 kanban
```

## 저장 방식
- 브라우저에서 변경 → 즉시 `POST /api/changes` → SQLite 트랜잭션으로 저장 → 다른 클라이언트에 실시간 푸시 (Cloudflare: WebSocket, Node: SSE)
- 상단 표시: **저장됨 / 저장 중… / 연결 끊김 / 저장 실패**
- 서버가 잠깐 꺼져 있으면 변경을 메모리에 쌓아두고 자동 재시도 → 복구되면 전송 (저장 안 된 변경이 있으면 창 닫을 때 경고)
- 이슈 번호(`DEV-12`)는 서버가 발급하므로 여러 기기에서 동시에 만들어도 겹치지 않음
- 백업: 메뉴 → JSON 내보내기 (Node는 `data/kanban.db` 복사도 가능). JSON 가져오기는 서버 데이터를 통째로 교체

## 기능
- **칸반 보드**: 드래그 앤 드롭(마우스·터치), 컬럼 추가/이름 변경(더블클릭)/이동/삭제, WIP 제한, 완료 컬럼 지정
- **이슈**: 유형(작업/스토리/버그/에픽), 우선순위 5단계, 라벨, 마감일(지남/임박 표시), 포인트, 체크리스트, 댓글, 상태 변경 이력, 마크다운 설명
- **빠른 생성**: 컬럼 하단에서 `로그인 버그 #auth #bug !high` → 라벨 `auth`, 유형 버그, 우선순위 높음
- **목록 보기**(정렬), **검색·필터**, 여러 프로젝트, 다크 모드, 삭제 실행 취소, `#DEV-12` 딥링크, CSV 내보내기

## 단축키
| 키 | 동작 |
|---|---|
| `C` | 새 이슈 |
| `/` | 검색 |
| `1`–`9` | 해당 컬럼에 빠른 추가 |
| `B` / `L` | 보드 / 목록 |
| `Esc` | 닫기 · 필터 지우기 |
| `Ctrl/⌘ + Enter` | 이슈 생성 · 댓글 저장 |
| `?` | 도움말 |
