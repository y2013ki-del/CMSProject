# 06. CMS Project — 온프레미스 사이니지 CMS

## 프로젝트 개요

삼성 QMC 시리즈(SSSP)를 타겟으로 하는 온프레미스 사이니지 CMS 시스템.
MagicInfo 서버 및 플레이어를 완전 대체하는 것이 목표.

| 항목 | 내용 |
|------|------|
| 디스플레이 | 삼성 QMC 시리즈 (SSSP 7 / SSSP 10, Tizen 기반) |
| 배포 방식 | 온프레미스 전용 (클라우드 의존 없음) |
| 플레이어 | QMC에서 직접 실행되는 Tizen Web App (MagicInfo 대체) |
| 제어 | LAN 1개 연결로 콘텐츠 수신 + TV 제어 동시 처리 |
| 동시 채널 | 40채널 이상 |
| RF | 미적용 (IP 전용) |

---

## 시스템 구성

```
[CMS 서버 (온프레미스)]
        │
        ├── 웹 UI (관리자 대시보드)
        ├── 콘텐츠 라이브러리 (이미지 / 동영상)
        ├── 스케줄 엔진
        ├── 스트리밍 서버 (FFmpeg + MediaMTX)
        ├── WebSocket 서버 (실시간 제어)
        └── MDC 게이트웨이 (삼성 TV 제어)
                │
        [L3 매니지드 스위치]
                │
    ┌───────────┼───────────┐
    │           │           │
[QMC TV 01] [QMC TV 02] ... [QMC TV 40+]
 LAN 1포트   LAN 1포트       LAN 1포트
 SSSP 앱    SSSP 앱         SSSP 앱
 (플레이어)  (플레이어)      (플레이어)
```

---

## 두 가지 핵심 개발 대상

### 1. CMS 서버

온프레미스 서버. 관리자가 접속하는 웹 UI + 플레이어에 콘텐츠를 공급하는 백엔드.

**주요 기능:**
- 콘텐츠 업로드 및 라이브러리 관리 (이미지 / 동영상)
- 채널별 스케줄 편집 (시간대별 콘텐츠 지정, 롤링 설정)
- 스케줄 변경 시 해당 플레이어에 즉시 반영 (WebSocket 푸시)
- 스트리밍 서버 (RTSP / HLS / RTSP → MJPEG, FFmpeg 기반)
- CCTV 스트리밍 (05 프로젝트 기능 계승)
- 삼성 MDC over LAN — 전원 / 입력 / 볼륨 제어
- 디스플레이 등록 및 상태 모니터링
- 이벤트 로그 (스트림 / 제어 / 스케줄 이력)

### 2. QMC 플레이어 앱 (Tizen Web App)

QMC 디스플레이에서 직접 실행되는 HTML5 기반 앱. MagicInfo 플레이어 대체.

**주요 기능:**
- 서버에서 스케줄 수신 및 자동 재생
- 이미지 / 동영상 롤링 (설정된 순서 / 시간대)
- WebSocket으로 서버와 연결 — 즉시 콘텐츠 전환 수신
- AVPlay API로 비디오 재생 (Tizen 네이티브 디코더 활용)
- 씽크 커맨드 수신 (PTP 타임스탬프 기반 동시 재생)
- 오버레이 레이어 (PNG 투명 레이어, CCTV 화면 합성)
- 네트워크 끊김 시 마지막 스케줄로 자동 유지

---

## SSSP 플레이어 앱 배포 방식

MagicInfo 없이 QMC에 앱을 올리는 방법:

```
방법 1 — URL Launcher (가장 단순)
  QMC 설정 → URL Launcher → 서버 URL 입력
  → 서버에서 HTML5 앱 서빙 → 즉시 실행

방법 2 — USB 설치
  USB에 /SSSP 폴더 생성 → index.html + 리소스 배치
  → QMC에 삽입 → 자동 설치

방법 3 — App Management (원격 배포)
  QMC 관리 메뉴 → Install Custom App → 서버 URL
  → .wgt 패키지 원격 설치
```

**선택**: URL Launcher 방식 우선 (가장 단순, 업데이트 즉시 반영)

---

## 기술 스택

| 영역 | 기술 | 비고 |
|------|------|------|
| CMS 서버 백엔드 | Node.js (Express) | 05 프로젝트 방식 계승 |
| DB | SQLite → PostgreSQL | 초기 SQLite, 규모 따라 전환 |
| 미디어 서버 | FFmpeg + MediaMTX | RTSP / HLS / MJPEG |
| 실시간 통신 | WebSocket (ws 모듈) | 스케줄 푸시 / 씽크 커맨드 |
| TV 제어 | 삼성 MDC (TCP 1515) | 직접 구현 |
| 플레이어 앱 | HTML5 + Tizen Web API | QMC SSSP 7/10 |
| 비디오 재생 | AVPlay API (Tizen) | 하드웨어 디코더 활용 |
| 씽크 | NTP 기반 타임스탬프 | WebSocket 커맨드 |
| 프론트엔드 | HTML5 + Vanilla JS | 05 방식 계승 |

---

## 05 CCTV Magicinfo에서 계승하는 기능

| 기능 | 계승 방식 |
|------|----------|
| RTSP → MJPEG 프록시 | 그대로 포팅 |
| cameras.json 관리 | 그대로 계승 |
| FFmpeg 워치독 (30초) | 동일 로직 |
| 스트림 이벤트 로그 | 구조 계승 + 항목 추가 |
| 세션 인증 (HttpOnly) | 동일 방식 |
| MagicInfo ZIP 생성 | 호환 유지 (레거시) |
| 오버레이 PNG 레이어 | 플레이어 앱으로 이전 |
| 웹 UI 탭 구조 | 확장 |

---

## API 설계 (예정)

### 인증
| Method | Path | 설명 |
|--------|------|------|
| GET | /login | 로그인 페이지 |
| POST | /login | 로그인 처리 |
| GET | /logout | 로그아웃 |

### 콘텐츠 라이브러리
| Method | Path | 인증 | 설명 |
|--------|------|------|------|
| GET | /api/media | 필요 | 파일 목록 |
| POST | /api/media | 필요 | 파일 업로드 |
| DELETE | /api/media/:id | 필요 | 파일 삭제 |
| GET | /media/:filename | 없음 | 파일 서빙 (플레이어용) |

### 스케줄
| Method | Path | 인증 | 설명 |
|--------|------|------|------|
| GET | /api/schedules | 필요 | 전체 스케줄 |
| POST | /api/schedules | 필요 | 스케줄 생성 |
| PATCH | /api/schedules/:id | 필요 | 수정 |
| DELETE | /api/schedules/:id | 필요 | 삭제 |
| POST | /api/schedules/:id/push | 필요 | 즉시 적용 |

### 플레이어 (인증 없음 — 내부망 전용)
| Method | Path | 설명 |
|--------|------|------|
| GET | /player | 플레이어 앱 HTML |
| WebSocket | /ws/player | 씽크 커맨드 / 스케줄 수신 |
| GET | /api/schedule/now | 현재 재생해야 할 스케줄 |

### CCTV 스트리밍 (05 계승)
| Method | Path | 인증 | 설명 |
|--------|------|------|------|
| GET | /stream/:camName | 없음 | RTSP→MJPEG |
| GET | /api/streams | 없음 | 활성 스트림 목록 |
| GET | /api/cameras | 필요 | 카메라 목록 |
| POST | /api/cameras | 필요 | 카메라 등록 |
| DELETE | /api/cameras/:name | 필요 | 카메라 삭제 |
| PATCH | /api/cameras/:name/password | 필요 | 비밀번호 수정 |
| POST | /api/streams/:name/restart | 필요 | 재시작 |

### 디스플레이 / TV 제어
| Method | Path | 인증 | 설명 |
|--------|------|------|------|
| GET | /api/displays | 필요 | 디스플레이 목록 |
| POST | /api/displays | 필요 | 디스플레이 등록 |
| DELETE | /api/displays/:id | 필요 | 삭제 |
| POST | /api/displays/:id/power | 필요 | 전원 ON/OFF |
| POST | /api/displays/:id/input | 필요 | 입력 전환 |
| POST | /api/displays/:id/volume | 필요 | 볼륨 |
| POST | /api/displays/group/:gid/power | 필요 | 그룹 전원 |

### 로그
| Method | Path | 인증 | 설명 |
|--------|------|------|------|
| GET | /api/logs | 필요 | 통합 로그 (최대 500건) |

---

## 파일 구조 (예정)

```
06. CMS Project/
├── README.md
├── server/
│   ├── app.js            — 메인 서버 (Express, 포트 8080)
│   ├── routes/
│   │   ├── auth.js       — 로그인/로그아웃
│   │   ├── media.js      — 콘텐츠 라이브러리
│   │   ├── schedule.js   — 스케줄 CRUD
│   │   ├── stream.js     — CCTV 스트리밍 (05 계승)
│   │   ├── display.js    — 디스플레이 관리
│   │   └── log.js        — 로그 조회
│   ├── services/
│   │   ├── ffmpeg.js     — FFmpeg 프로세스 관리
│   │   ├── mdc.js        — 삼성 MDC TCP 제어
│   │   ├── scheduler.js  — 스케줄 엔진 (시간대별 자동 전환)
│   │   └── logger.js     — 이벤트 로그
│   └── ws.js             — WebSocket 서버
├── public/
│   └── index.html        — 관리자 웹 UI
├── player/
│   └── index.html        — QMC SSSP 플레이어 앱
├── data/
│   ├── cameras.json      — CCTV 카메라 목록
│   ├── displays.json     — QMC 디스플레이 목록
│   ├── schedules.json    — 스케줄 데이터
│   └── cms.log           — 이벤트 로그
└── media/
    ├── library/          — 업로드 콘텐츠
    └── overlays/         — 오버레이 PNG
```

---

## 개발 Phase

```
Phase 1 — 서버 기반 + 05 기능 이전
  ├── Express 서버 구조 (인증 / 세션 / 로그)
  ├── CCTV 스트리밍 모듈 (05 완전 이전)
  └── 디스플레이 등록 / 상태 관리

Phase 2 — 콘텐츠 + 스케줄
  ├── 미디어 업로드 / 라이브러리 API
  ├── 스케줄 CRUD + 엔진
  └── WebSocket 서버 (스케줄 즉시 푸시)

Phase 3 — QMC 플레이어 앱
  ├── Tizen HTML5 플레이어 (AVPlay 비디오 재생)
  ├── WebSocket 수신 → 콘텐츠 전환
  ├── 오버레이 레이어
  └── URL Launcher 배포 테스트

Phase 4 — TV 제어 + 씽크
  ├── 삼성 MDC 모듈 (전원 / 입력 / 볼륨)
  └── NTP 타임스탬프 기반 씽크 커맨드
```

---

## 삼성 MDC 프로토콜 참고

```
접속: TCP 1515
프레임: 0xAA [CMD] [ID] [LEN] [DATA...] [CHECKSUM]

전원:    CMD 0x11 / DATA 0x01(ON) 0x00(OFF)
입력:    CMD 0x14 / DATA 0x21(HDMI1) 0x23(HDMI2) 0x20(DVI)
볼륨:    CMD 0x12 / DATA 0x00~0x64
밝기:    CMD 0x76 / DATA 0x00~0x64
```

---

## QMC SSSP 플레이어 앱 배포 절차 (URL Launcher)

```
1. CMS 서버에서 /player 경로로 HTML5 앱 서빙
2. QMC 디스플레이 → 설정 → URL Launcher 활성화
3. 서버 URL 입력 (예: http://192.168.1.100:8080/player)
4. 이후 QMC 부팅 시 자동 앱 실행
5. 앱 업데이트 → 서버 파일만 수정하면 즉시 반영
```

---

*작성일: 2026-04-14*
*기반 프로젝트: 05. CCTV Magicinfo*
*디스플레이 플랫폼: 삼성 QMC 시리즈 (SSSP 7/10)*
