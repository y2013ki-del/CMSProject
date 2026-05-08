# 06. CMS Project — 온프레미스 사이니지 CMS

삼성 QMC 시리즈(SSSP/Tizen)를 대상으로 하는 온프레미스 CMS입니다.
현재 기준의 핵심 방향은 `콘텐츠 디자이너 + 스케줄 + 채널 + 기기 제어`를 한 서버에서 운영하는 구조이며, MagicInfo 대체 운용을 목표로 합니다.

## 현재 핵심 요약

| 항목 | 내용 |
|------|------|
| 대상 장비 | 삼성 QMC 시리즈, SSSP/Tizen |
| 배포 방식 | 온프레미스 전용 |
| 관리자 UI | `/` |
| 플레이어 | `/client` |
| 제어 방식 | 삼성 MDC TCP 1515 + WebSocket 스케줄 배포 |
| 콘텐츠 구조 | 파일, 웹 콘텐츠, 날씨 콘텐츠, 디자이너 배치형 콘텐츠 |
| 운영 흐름 | 콘텐츠 등록 → 스케줄 편집 → 채널 규칙 설정 → 기기 채널 연결 |
| 로그 | 30일 로테이션, 50줄 페이징, 기간 다운로드 지원 |
| CCTV | 코드 존재, 기본 비활성 (`ENABLE_CCTV=1` 일 때만 사용) |

## 현재 시스템 구성

```text
[CMS 서버]
  ├── 관리자 UI                  /
  ├── 플레이어 클라이언트         /client
  ├── 디자이너 콘텐츠 렌더        /designer-content.html
  ├── 날씨 콘텐츠 렌더            /weather-content.html
  ├── 배포 파일                   /deploy, /download/app.wgt
  ├── 스케줄 엔진                 /ws/player
  ├── TV 제어                     /api/displays/*, TCP 1515
  ├── 로그                        /api/logs, /api/logs/download
  └── 선택 기능: CCTV             /stream/*, /api/cameras/*
```

## 현재 운영 기준 플로우

1. 콘텐츠 탭에서 파일/웹/날씨/배치형 콘텐츠 등록
2. 스케줄 탭에서 콘텐츠를 조합해 스케줄 생성
3. 채널 탭에서 기본/예약/요일 규칙으로 스케줄 배정
4. 기기 모니터링/기기 제어 탭에서 기기를 등록하고 채널 연결
5. 플레이어(`/client`)가 WebSocket으로 채널 스케줄을 수신해 재생

## 문서 인덱스

- [AGENTS.md](AGENTS.md) : 작업 시작 규칙
- [DOC_INDEX.md](md%20file/DOC_INDEX.md) : 작업 유형별 문서 라우팅
- [update.md](md%20file/update.md) : 버전별 변경 이력 요약
- [PROJECT_STATUS.md](md%20file/PROJECT_STATUS.md) : 현재 구조, 최신 방향, 남은 이슈
- [OPERATIONS.md](md%20file/OPERATIONS.md) : 설치, 실행, 데이터 이전, 운영 절차
- [UI_GUIDE.md](md%20file/UI_GUIDE.md) : 관리자 UI/플레이어 UI 기준
- [API_REFERENCE.md](md%20file/API_REFERENCE.md) : 최신 API 및 데이터 흐름
- [MDC_GUIDE.md](md%20file/MDC_GUIDE.md) : 삼성 MDC/WoL 진단
- [FIRMWARE.md](md%20file/FIRMWARE.md) : WGT/SSSP/URL Launcher 설치
- [ERROR_LOG.md](md%20file/ERROR_LOG.md) : 장애/오류 이력
- [VALIDATION_MATRIX.md](md%20file/VALIDATION_MATRIX.md) : 대규모 운용 전 검증 항목

## 실제 파일 구조

```text
06. CMS Project/
├── server.js
├── package.json
├── public/                 # 관리자 UI, 플레이어 보조 페이지, 디자이너/날씨 콘텐츠
├── player/                 # WGT/SSSP 배포용 플레이어 셸
├── data/                   # schedules/channels/displays/web-contents/log 등 운영 데이터
├── media/library/          # 실제 업로드 미디어 파일
├── custom-app/             # 커스텀 앱 관련 자료
└── md file/                # 운영/개발 문서
```

## update 문서 관리 규칙

- 버전 단위 변경 요약은 `md file/update.md`에 누적합니다.
- 코드 커밋 전에 이번 작업이 `md file/update.md`에 반영되었는지 확인합니다.
- 이 파일에는 긴 설계 설명보다 “무엇이 바뀌었는지”만 날짜별로 간단히 적습니다.
