# API_REFERENCE — API 설계

> 읽는 시점: 엔드포인트, 요청/응답 구조, 제어 API를 확인할 때
> 관련 문서: `README.md`, `md file/DOC_INDEX.md`, `md file/UI_GUIDE.md`, `md file/MDC_GUIDE.md`

## 인증

| Method | Path | 설명 |
|--------|------|------|
| GET | /login | 로그인 페이지 |
| POST | /login | 로그인 처리 |
| GET | /logout | 로그아웃 |

## 콘텐츠

| Method | Path | 인증 | 설명 |
|--------|------|------|------|
| GET | /api/media | 필요 | 파일 목록 |
| POST | /api/media | 필요 | 파일 업로드 (최대 2GB, groupId 포함 가능) |
| DELETE | /api/media/:filename | 필요 | 삭제 (그룹에서도 자동 제거) |
| GET | /media/:filename | 없음 | 파일 서빙 |
| GET | /api/media-groups | 필요 | 미디어 그룹 목록 |
| POST | /api/media-groups | 필요 | 그룹 생성 |
| DELETE | /api/media-groups/:id | 필요 | 그룹 삭제 |
| PATCH | /api/media/:filename/group | 필요 | 파일 그룹 변경 |

## 스케줄

| Method | Path | 인증 | 설명 |
|--------|------|------|------|
| GET | /api/schedules | 필요 | 전체 채널 목록 |
| POST | /api/schedules | 필요 | 채널 생성 |
| PUT | /api/schedules/:id | 필요 | 채널 수정 + 즉시 푸시 |
| DELETE | /api/schedules/:id | 필요 | 채널 삭제 |
| POST | /api/schedules/:id/push | 필요 | 수동 즉시 푸시 |
| GET | /api/schedule/current?channel= | 없음 | 플레이어용 현재 스케줄 |

## 스케줄 그룹

| Method | Path | 인증 | 설명 |
|--------|------|------|------|
| GET | /api/schedule-groups | 필요 | 스케줄 그룹 목록 |
| POST | /api/schedule-groups | 필요 | 스케줄 그룹 생성 |
| PUT | /api/schedule-groups/:id | 필요 | 스케줄 그룹명 변경 |
| DELETE | /api/schedule-groups/:id | 필요 | 그룹 삭제 (포함 스케줄은 미분류 처리) |

## 채널

| Method | Path | 인증 | 설명 |
|--------|------|------|------|
| GET | /api/channels | 필요 | 채널 목록 + 현재 활성 스케줄 정보 |
| POST | /api/channels | 필요 | 채널 생성 (name, scheduleId, rules[]) |
| PUT | /api/channels/:id | 필요 | 채널 수정 (기본 스케줄/규칙/이름) |
| DELETE | /api/channels/:id | 필요 | 채널 삭제 (연결 디스플레이 채널 해제) |

> `rules[]` 항목 구조  
> `scheduleId`, `repeatWeekly`, `priority`, `enabled`  
> 기간 규칙: `startAt`, `endAt`  
> 주간 반복 규칙: `weekdays(0~6)`, `startTime(HH:MM)`, `endTime(HH:MM)`  
> 겹치는 시간대는 `priority`가 높은 규칙이 우선 적용됩니다.

## 디스플레이 / TV 제어

| Method | Path | 인증 | 설명 |
|--------|------|------|------|
| GET | /api/displays | 필요 | 등록 기기 목록 |
| POST | /api/displays | 필요 | 기기 등록 (IP+이름+구역+MAC+채널+재생프로필) |
| PUT | /api/displays/:id | 필요 | 기기 정보 수정 (name/ip/location/channelId/mac/playbackProfile) |
| DELETE | /api/displays/:id | 필요 | 기기 삭제 |
| POST | /api/displays/:id/control | 필요 | MDC 제어 (action: power_on/off, tv_restart, volume, input, channel, mute_on/off) |
| POST | /api/displays/:id/wol | 필요 | Wake-on-LAN (UDP Magic Packet) |
| GET | /api/displays/mdc-status | 필요 | 전체 기기 MDC 상태 캐시 조회 (30초 폴링) |
| POST | /api/displays/:id/mdc-poll | 필요 | 단일 기기 MDC 상태 즉시 폴링 |
| POST | /api/displays/group/control | 필요 | 채널 그룹 일괄 제어 |
| POST | /api/displays/bulk-action | 필요 | 선택 기기 일괄 제어 |

> `playbackProfile` 값: `stable`(안정형), `balanced`(균형형), `low_latency`(저지연형)

## 플레이어

| Method | Path | 인증 | 설명 |
|--------|------|------|------|
| GET | /api/players/online | 없음 | 온라인 플레이어 목록 (IP 기반, heartbeat 상태 포함) |
| POST | /api/players/reload | 필요 | 특정 IP 플레이어(CMS 화면) 재시작 |
| WebSocket | /ws/player | 없음 | 채널 구독 / 스케줄 수신 |

> `/api/players/online` 주요 필드  
> `ip`, `lastSeen`, `duid`, `channelId`, `heartbeatAt`, `heartbeatAgeMs`, `heartbeatStale`, `player(playback/currentType/currentFilename/lastError)`

## CCTV

| Method | Path | 인증 | 설명 |
|--------|------|------|------|
| GET | /stream/:camName | 없음 | RTSP→MJPEG |
| GET | /api/streams | 없음 | 활성 스트림 목록 |
| GET | /cctv/live?splitMode=1|2|4&name=cam1&name=cam2... | 없음 | MagicInfo 없이 CMS에서 직접 CCTV 레이아웃 실행 |
| GET | /api/cameras | 필요 | 카메라 목록 |
| POST | /api/cameras | 필요 | 카메라 등록 |
| PATCH | /api/cameras/:name/password | 필요 | 비밀번호 변경 + 스트림 재시작 |
| DELETE | /api/cameras/:name | 필요 | 삭제 |
| POST | /api/streams/:name/restart | 필요 | 재시작 |
| GET | /api/logs | 필요 | 최근 구조화 로그 조회 (`limit` 또는 `lines`, 최대 500) |
