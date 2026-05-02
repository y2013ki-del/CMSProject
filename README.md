# 06. CMS Project — 온프레미스 사이니지 CMS

삼성 QMC 시리즈(SSSP 7/10, Tizen)를 타겟으로 하는 온프레미스 사이니지 CMS.  
MagicInfo 서버 및 플레이어를 대체하는 것이 목표입니다.

## 핵심 요약

| 항목 | 내용 |
|------|------|
| 디스플레이 | 삼성 QMC 시리즈 (SSSP 7 / SSSP 10, Tizen) |
| 배포 방식 | 온프레미스 전용 |
| 플레이어 | URL Launcher → `/client` |
| 제어 | LAN 1개로 콘텐츠 수신 + TV 제어 동시 처리 |
| TV 제어 | 삼성 MDC TCP 1515 |
| 기기 식별 | IP 기반, DUID 자동 수집 |

## 시스템 구성

```text
[CMS 서버 — 12.23.67.245:8080]
        ├── 관리자 UI          /
        ├── 플레이어 클라이언트 /client
        ├── 배포용 파일         /deploy, /download/app.wgt
        ├── 스케줄 엔진         /ws/player
        ├── CCTV 스트리밍       /stream/:cam
        └── MDC 게이트웨이      TCP 1515
```

## 문서 인덱스

- [AGENTS.md](AGENTS.md) : 작업 시작 시 읽는 기본 규칙
- [DOC_INDEX.md](md%20file/DOC_INDEX.md) : 작업 유형별 문서 라우팅
- [OPERATIONS.md](md%20file/OPERATIONS.md) : 설치, 운영, 서버 실행, 기기 등록 흐름
- [FIRMWARE.md](md%20file/FIRMWARE.md) : QMC 배포 전략, URL Launcher, WGT/SSSP 설치
- [custom-app/DEPLOYMENT.md](custom-app/DEPLOYMENT.md) : Custom App 초안, USB/URL 배포 구조
- [API_REFERENCE.md](md%20file/API_REFERENCE.md) : 관리자/플레이어/CCTV API 정리
- [MDC_GUIDE.md](md%20file/MDC_GUIDE.md) : 삼성 MDC 포트, ID, 진단 절차
- [UI_GUIDE.md](md%20file/UI_GUIDE.md) : 관리자 UI와 플레이어 UI 동작 설명
- [ERROR_LOG.md](md%20file/ERROR_LOG.md) : 장애 이력과 조치 기록
- [PROJECT_STATUS.md](md%20file/PROJECT_STATUS.md) : 개발 현황과 운영 메모
- [VALIDATION_MATRIX.md](md%20file/VALIDATION_MATRIX.md) : 50~300대 운영 전 P1 검증 매트릭스

## 실제 파일 구조

```text
06. CMS Project/
├── server.js
├── package.json
├── custom-app/
├── public/
├── player/
├── data/
├── media/
└── md file/
```
