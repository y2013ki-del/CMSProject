# OPERATIONS — 설치 / 실행 / 운영 / 데이터 이전

> 읽는 시점: 서버 실행, 운영 데이터 보존, 배포 폴더 교체, 로그 운영을 확인할 때
> 관련 문서: `README.md`, `md file/PROJECT_STATUS.md`, `md file/FIRMWARE.md`, `md file/ERROR_LOG.md`

## 1. 실행 환경

- Node.js
- `npm install`
- 포트 `8080` 사용
- 삼성 제어는 MDC TCP 1515
- CCTV를 쓸 경우 FFmpeg 필요

`package.json` 기준 실행 명령:

```bash
npm start
```

또는

```bash
node server.js
```

## 2. 주요 서버 설정

`server.js` 상단 기준 주요 설정값:

- `PORT = 8080`
- `PROXY_IP`
- `ADMIN_ID / ADMIN_PW`
- `WOL_BROADCAST_IP`
- `FFMPEG_PATH`
- `ENABLE_CCTV`
- `LOG_ROTATE_MS = 30일`

즉 현재 로그 보존은 별도 설정이 없으면 `30일 로테이션` 입니다.

## 3. 현재 실제 운영 플로우

### Step 1. 서버 실행

```bash
npm start
```

### Step 2. 관리자 접속

- `http://서버IP:8080`
- 기본 계정: `admin / !!@@password`

### Step 3. 콘텐츠 생성

콘텐츠 탭에서 아래 중 하나를 등록:

- 파일
- 웹 콘텐츠
- 날씨 콘텐츠
- 배치형 콘텐츠

### Step 4. 스케줄 편집

- 스케줄 생성
- 콘텐츠 추가
- 재생 순서 및 구성 저장

### Step 5. 채널 편집

- 채널 생성
- 기본/예약/요일 규칙으로 스케줄 배정

### Step 6. 기기 등록 및 채널 연결

- 기기 모니터링에서 미등록 기기 등록
- 채널 연결
- 필요 시 재생 프로필/제어 정보 수정

### Step 7. 플레이어 송출

- 플레이어는 `/client`
- WebSocket으로 채널 스케줄 수신

## 4. 운영 데이터 보존

### 매우 중요

코드 폴더만 교체하면 운영 상태가 보존되지 않습니다.
아래는 반드시 같이 이동해야 합니다.

- `data/schedules.json`
- `data/channels.json`
- `data/displays.json`
- `data/media-groups.json`
- `data/web-contents.json`
- `data/media-meta.json`
- `data/cms.log` 필요 시
- `media/library/`

### 이유

- `schedules.json`: 스케줄 내용
- `channels.json`: 채널 규칙
- `displays.json`: 등록 기기
- `media-groups.json`: 콘텐츠 그룹 구조
- `web-contents.json`: 웹/날씨/디자인 콘텐츠
- `media-meta.json`: 일반 미디어의 라벨/숨김/디자이너 메타
- `media/library/`: 실제 원본 파일

## 5. 폴더 교체 시 권장 순서

1. 서버 중지
2. 새 코드 폴더 복사
3. 기존 운영 폴더의 `data/`, `media/library/` 병합
4. 서버 재실행
5. 관리자 UI에서
   - 콘텐츠
   - 스케줄
   - 채널
   - 기기 목록
   - 로그
   확인

## 6. 콘텐츠 수정 반영 기준

- 콘텐츠 수정 후 즉시 화면이 바뀌지 않을 수 있음
- 관리자 UI에서 `즉시 반영`을 선택하면 전체 채널 재배포 수행
- 즉시 반영을 하지 않으면 다음 송출부터 적용될 수 있음

## 7. 로그 운영

### 조회

- 로그 탭에서 카테고리 필터
- 검색
- 50줄 단위 페이지 이동

### 다운로드

- 로그 탭 우측 하단 `로그 다운로드`
- 시작/종료 시각 선택
- 선택 기간만 `.log` 형태로 다운로드

### 저장

- 파일: `data/cms.log`
- 30일 로테이션
- 주요 변경 작업에는 `actorIp` 포함

## 8. CCTV 운영 기준

- 현재 CCTV는 코드가 남아 있어도 기본 비활성
- 사용하려면 `ENABLE_CCTV=1`
- CCTV를 현재 주 운영 축으로 문서화하거나 인수인계하지 않도록 주의

## 9. 플레이어 설치/배포

플레이어 배포는 이 문서보다 아래 문서를 우선 참고:

- `md file/FIRMWARE.md`
- `custom-app/DEPLOYMENT.md`

현재 서버에서 관련 경로:

- `/download/app.wgt`
- `/deploy/app.wgt`
- `/sssp_config.xml`
- `/deploy/sssp_config.xml`

## 10. 현재 문서 기준 날짜

- 마지막 전체 정리 기준: `2026-05-04`
