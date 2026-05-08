# API_REFERENCE — 최신 API / 데이터 흐름

> 읽는 시점: 엔드포인트, 인증, 운영 데이터 흐름을 확인할 때
> 관련 문서: `README.md`, `md file/UI_GUIDE.md`, `md file/OPERATIONS.md`, `md file/PLAYER_CONTRACT.md`

## 인증

| Method | Path | 설명 |
|--------|------|------|
| GET | `/login` | 로그인 페이지 |
| POST | `/login` | 로그인 처리 |
| GET | `/logout` | 로그아웃 |

## 콘텐츠 / 미디어

| Method | Path | 인증 | 설명 |
|--------|------|------|------|
| GET | `/api/media` | 필요 | 콘텐츠 목록 조회 |
| POST | `/api/media` | 필요 | 파일 업로드 (`groupId`, `hidden` 지원) |
| PUT | `/api/media/:filename` | 필요 | 일반 미디어 라벨/숨김/디자이너 메타 수정 |
| DELETE | `/api/media/:filename` | 필요 | 콘텐츠 삭제 |
| PATCH | `/api/media/:filename/group` | 필요 | 그룹 이동 |
| GET | `/media/:filename` | 없음 | 원본 파일 서빙 |

### 비고

- 일반 파일도 `designer` 메타가 붙으면 실제 재생 시 내부 레이아웃 콘텐츠처럼 동작할 수 있음
- 디자이너 업로드 과정에서 숨겨진 원본 파일이 생성될 수 있음

## 콘텐츠 그룹

| Method | Path | 인증 | 설명 |
|--------|------|------|------|
| GET | `/api/media-groups` | 필요 | 그룹 목록 |
| POST | `/api/media-groups` | 필요 | 그룹 생성 |
| PUT | `/api/media-groups/:id` | 필요 | 그룹명 변경 |
| DELETE | `/api/media-groups/:id` | 필요 | 그룹 삭제 |

## 웹 콘텐츠 / 날씨 콘텐츠 / 디자인 콘텐츠

| Method | Path | 인증 | 설명 |
|--------|------|------|------|
| GET | `/api/web-contents` | 필요 | 웹 콘텐츠 목록 |
| POST | `/api/web-contents` | 필요 | 일반 웹 콘텐츠 생성 |
| PUT | `/api/web-contents/:id` | 필요 | 일반 웹 콘텐츠 수정 |
| POST | `/api/designer-contents` | 필요 | 배치형 디자인 콘텐츠 생성 |
| PUT | `/api/designer-contents/:id` | 필요 | 배치형 디자인 콘텐츠 수정 |
| GET | `/api/designer-contents/:id/render` | 없음 | 디자인 콘텐츠 렌더 데이터 |
| GET | `/api/designer-media/:filename/render` | 없음 | 일반 미디어의 디자인 메타 렌더 데이터 |
| GET | `/designer-content.html` | 없음 | 배치형 콘텐츠 렌더 페이지 |
| GET | `/weather-content.html` | 없음 | 날씨 콘텐츠 렌더 페이지 |

### URL 규칙

- 일반 웹 콘텐츠: 외부 URL 또는 내부 경로 허용
- 날씨 콘텐츠: 내부 `/weather-content.html?...`
- 디자인 콘텐츠: 내부 `/designer-content.html?...`

## 스케줄

| Method | Path | 인증 | 설명 |
|--------|------|------|------|
| GET | `/api/schedules` | 필요 | 스케줄/그룹 전체 조회 |
| POST | `/api/schedules` | 필요 | 스케줄 생성 |
| PUT | `/api/schedules/:id` | 필요 | 스케줄 수정 |
| DELETE | `/api/schedules/:id` | 필요 | 스케줄 삭제 |
| POST | `/api/schedules/:id/push` | 필요 | 해당 스케줄 연결 채널 즉시 배포 |
| GET | `/api/schedule/current?channel=...` | 없음 | 플레이어용 현재 스케줄 계산 결과 |

## 스케줄 그룹

| Method | Path | 인증 | 설명 |
|--------|------|------|------|
| GET | `/api/schedule-groups` | 필요 | 스케줄 그룹 목록 |
| POST | `/api/schedule-groups` | 필요 | 그룹 생성 |
| PUT | `/api/schedule-groups/:id` | 필요 | 그룹명 수정 |
| DELETE | `/api/schedule-groups/:id` | 필요 | 그룹 삭제 |

## 채널

| Method | Path | 인증 | 설명 |
|--------|------|------|------|
| GET | `/api/channels` | 필요 | 채널 목록 + 활성 스케줄 정보 |
| POST | `/api/channels` | 필요 | 채널 생성 |
| PUT | `/api/channels/:id` | 필요 | 채널 수정 |
| DELETE | `/api/channels/:id` | 필요 | 채널 삭제 |
| POST | `/api/channels/rebroadcast` | 필요 | 전체 채널 재배포 |

### 채널 규칙 개념

- 기본 스케줄
- 예약(기간) 규칙
- 요일(주간 반복) 규칙

## 디스플레이 / 제어

| Method | Path | 인증 | 설명 |
|--------|------|------|------|
| GET | `/api/displays` | 필요 | 등록 기기 목록 |
| POST | `/api/displays` | 필요 | 기기 등록 |
| PUT | `/api/displays/:id` | 필요 | 기기 수정 |
| DELETE | `/api/displays/:id` | 필요 | 기기 삭제 |
| POST | `/api/displays/:id/control` | 필요 | 개별 기기 제어 |
| POST | `/api/displays/:id/control-sequence` | 필요 | 순차 제어 |
| POST | `/api/displays/:id/wol` | 필요 | WoL 전송 |
| GET | `/api/displays/mdc-status` | 필요 | MDC 상태 캐시 조회 |
| POST | `/api/displays/:id/mdc-poll` | 필요 | 즉시 MDC 폴링 |
| POST | `/api/displays/group/control` | 필요 | 채널 기준 그룹 제어 |
| POST | `/api/displays/bulk-action` | 필요 | 선택 기기 일괄 제어 |

### 기기 유형

- `signage`: 삼성 QMC/Tizen
- `pc_web`: 일반 16:9 PC 웹 플레이어
- `welcome_board_pc`: 웰컴보드용 고해상도/비정형 PC 플레이어
- 기존 `pc` 값은 호환을 위해 서버에서 `pc_web`으로 정규화한다.
- `welcome_board_pc`는 기기 데이터에 `output.canvas`, `output.rect`를 저장하며, 해당 기기에 보내는 플레이어 payload에도 `output`을 포함한다.

## 플레이어

| Method | Path | 인증 | 설명 |
|--------|------|------|------|
| GET | `/api/players/online` | 필요 | 현재 온라인 플레이어 목록 |
| POST | `/api/players/reload` | 필요 | 플레이어 재로드 |
| WebSocket | `/ws/player` | 없음 | 채널 스케줄 수신 |
| GET | `/client` | 없음 | 플레이어 화면 |

### 플레이어 계약

- CMS/플레이어 간 메시지 계약은 `md file/PLAYER_CONTRACT.md`를 기준으로 한다.
- 현재 기본 계약은 WebSocket `update`, `mode`, `reload` 수신과 `heartbeat` 보고다.
- CMS 발신 메시지와 플레이어 heartbeat에는 `playerContractVersion: 1`을 포함한다.
- 기본 16:9 PC 재생은 `/client` 웹 플레이어를 유지하고, 웰컴보드용 PC 플레이어만 고해상도/비정형 출력 계약을 추가 해석한다.

## 로그

| Method | Path | 인증 | 설명 |
|--------|------|------|------|
| GET | `/api/logs` | 필요 | 최근 로그 조회 (`limit`, `category`) |
| GET | `/api/logs/download` | 필요 | 로그 다운로드 (`category`, `from`, `to`) |

### 로그 정책

- 로그 파일: `data/cms.log`
- 30일 로테이션
- 변경성 관리자 작업 로그는 `actorIp` 포함

## CCTV

> 기본 비활성. `ENABLE_CCTV=1` 일 때만 운영 대상으로 봄

| Method | Path | 인증 | 설명 |
|--------|------|------|------|
| GET | `/stream/:camName` | 조건부 | MJPEG 스트림 |
| GET | `/api/streams` | 조건부 | 활성 스트림 |
| GET | `/api/streams/status` | 조건부 | 스트림 상태 |
| GET | `/api/cameras` | 필요 | 카메라 목록 |
| POST | `/api/cameras` | 필요 | 카메라 등록 |
| PATCH | `/api/cameras/:name/password` | 필요 | 카메라 비밀번호 변경 |
| DELETE | `/api/cameras/:name` | 필요 | 카메라 삭제 |
| POST | `/api/streams/:name/restart` | 필요 | 스트림 재시작 |

## 주요 데이터 파일

| 파일 | 역할 |
|------|------|
| `data/schedules.json` | 스케줄 및 스케줄 그룹 |
| `data/channels.json` | 채널 규칙 |
| `data/displays.json` | 등록 기기 |
| `data/media-groups.json` | 콘텐츠 그룹 |
| `data/web-contents.json` | 웹/날씨/디자인 콘텐츠 |
| `data/media-meta.json` | 일반 미디어 메타(라벨/숨김/디자이너 정보) |
| `data/cms.log` | 구조화 로그 |
| `media/library/` | 실제 원본 미디어 파일 |

## 현재 문서 기준 날짜

- 마지막 전체 정리 기준: `2026-05-04`
