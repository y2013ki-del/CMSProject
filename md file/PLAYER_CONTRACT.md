# PLAYER_CONTRACT — CMS/플레이어 재생 계약

> 읽는 시점: 웹 플레이어, 웰컴보드용 PC 플레이어, 향후 별도 재생 엔진이 CMS 스케줄을 어떻게 해석해야 하는지 정할 때
> 관련 문서: `md file/API_REFERENCE.md`, `md file/PROJECT_STATUS.md`, `md file/VALIDATION_MATRIX.md`

## 기본 원칙

1. CMS는 콘텐츠, 스케줄, 채널, 기기 연결을 관리한다.
2. 플레이어는 CMS가 내려준 재생 계약을 해석하고 실제 화면에 출력한다.
3. 기본 16:9 PC 재생과 사이니지는 기존 웹 플레이어(`/client`)를 우선 사용한다.
4. 웰컴보드처럼 고해상도, 비정형 해상도, 일부 영역 송출이 필요한 PC만 별도 플레이어 앱을 사용한다.
5. 웹 플레이어와 웰컴보드용 플레이어는 같은 재생 계약을 해석해야 한다.
6. 플레이어는 온라인 여부뿐 아니라 준비, 재생, 대기, 에러 상태를 CMS에 보고해야 한다.

## 플레이어 유형

| 유형 | 용도 | 기본 플레이어 | 비고 |
|------|------|---------------|------|
| `signage` | 삼성 QMC/Tizen | `/client` + WGT shell | MDC/AVPlay 가능 |
| `pc_web` | 일반 16:9 PC 재생 | `/client` | 브라우저 전체화면 운용 |
| `welcome_board_pc` | 웰컴보드/고해상도/비정형 송출 | 별도 앱 | Electron/Chromium 우선 검토 |

## 연결 방식

### WebSocket

플레이어는 CMS의 WebSocket에 연결한다.

```text
ws://{cms-host}/ws/player?duid={deviceId}
```

기본 규칙:

- `duid`는 플레이어를 식별하는 안정적인 기기 ID다.
- `duid`가 없으면 CMS는 접속 IP를 임시 ID로 사용할 수 있다.
- 등록 기기에 채널이 연결되어 있으면 CMS는 연결 직후 현재 스케줄을 전송한다.
- 플레이어는 연결 직후 `heartbeat`를 1회 보내고, 이후 10초 내외 주기로 반복 전송한다.

### HTTP 조회

WebSocket 연결 전후에 현재 스케줄을 직접 조회할 수 있다.

```text
GET /api/schedule/current?channel={channelId}
```

이 API는 디버그, 복구, 웰컴보드 플레이어 초기 동기화에 사용한다.

## CMS → 플레이어 메시지

모든 CMS 발신 메시지는 `type` 필드를 가진다.

### 1. 스케줄 업데이트

현재 구현 호환 메시지:

```json
{
  "type": "update",
  "channel": "channel-id",
  "name": "채널명",
  "scheduleId": "schedule-id",
  "scheduleSource": "default",
  "ruleId": null,
  "items": []
}
```

표준 해석 규칙:

- `type: "update"`는 플레이어가 현재 재생 큐를 교체해야 한다는 뜻이다.
- `channel`은 현재 채널 ID다.
- `name`은 플레이어 상태 보고에 사용할 표시명이다.
- `scheduleSource`는 `default` 또는 `rule`이다.
- `ruleId`가 있으면 예약/요일 규칙에 의해 선택된 스케줄이다.
- `items`는 순서대로 반복 재생한다.
- `items`가 비어 있으면 플레이어는 검은 화면 또는 대기 화면 상태가 된다.

### 2. 모드 전환

현재 구현 호환 메시지:

```json
{
  "type": "mode",
  "mode": "schedule"
}
```

```json
{
  "type": "mode",
  "mode": "streaming",
  "url": "http://example.local/live.m3u8",
  "playbackProfile": "balanced",
  "targetEpochMs": 1778123456789
}
```

표준 해석 규칙:

- `mode: "schedule"`은 일반 스케줄 재생으로 복귀한다.
- `mode: "streaming"`은 지정 URL을 우선 재생한다.
- `playbackProfile`은 `stable`, `balanced`, `low_latency` 중 하나다.
- `targetEpochMs`가 있으면 해당 시각에 맞춰 재생을 시작한다.

### 3. 재로드

```json
{
  "type": "reload"
}
```

표준 해석 규칙:

- 웹 플레이어는 페이지를 새로고침한다.
- 웰컴보드용 앱은 렌더러 새로고침 또는 앱 내부 재시작으로 처리한다.
- 앱 전체 재시작이 필요한 경우에는 별도 명령 타입을 추가한다.

## 재생 아이템 계약

`items[]`의 각 항목은 하나의 재생 단위다.

### 공통 필드

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `type` | string | 예 | `image`, `video`, `web` |
| `filename` | string | 조건부 | `image`, `video` 원본 파일명 |
| `webUrl` | string | 조건부 | `web` 콘텐츠 URL 또는 내부 렌더 URL |
| `label` | string | 아니오 | 표시명/상태 보고용 이름 |
| `duration` | number | 아니오 | 초 단위 재생 시간. 웹/이미지는 기본 10초 |
| `muted` | boolean | 아니오 | 영상 음소거 여부 |
| `startAt` | string | 아니오 | 아이템 재생 가능 시작 시각 |
| `endAt` | string | 아니오 | 아이템 재생 가능 종료 시각 |
| `alwaysOn` | boolean | 아니오 | 기간과 무관하게 항상 재생 |
| `sourceFilename` | string | 아니오 | 디자이너 메타로 래핑된 원본 파일명 |
| `sourceType` | string | 아니오 | 디자이너 메타 래핑 전 원본 타입 |

### 타입별 해석

#### `image`

- `/media/{filename}`을 이미지로 표시한다.
- `duration`이 없으면 10초 재생한다.
- 로딩 실패 시 `image_load_error`를 보고하고 다음 아이템으로 넘어간다.

#### `video`

- `/media/{filename}`을 영상으로 재생한다.
- `muted`가 true면 음소거한다.
- 단일 영상만 재생 중이면 영상 종료 이벤트를 우선한다.
- 로딩 실패 시 `video_load_error`를 보고하고 다음 아이템으로 넘어간다.

#### `web`

- `webUrl`을 iframe 또는 앱 내 웹뷰로 표시한다.
- 외부 URL과 내부 URL을 모두 허용한다.
- 날씨 콘텐츠와 배치형 콘텐츠도 `web`으로 해석한다.
- 디자이너 메타가 붙은 일반 미디어도 CMS가 `web`으로 변환할 수 있다.

## 출력 영역 계약

v1에서 기본 출력은 전체 화면이다.

웰컴보드용 플레이어는 이후 아래 필드를 추가로 해석한다.

```json
{
  "output": {
    "mode": "fullscreen",
    "canvas": { "width": 3840, "height": 2160 },
    "rect": { "x": 0, "y": 0, "width": 3840, "height": 2160 }
  }
}
```

규칙:

- `output`이 없으면 전체 화면으로 본다.
- `mode`는 우선 `fullscreen`, `rect`만 사용한다.
- `canvas`는 기준 해상도다.
- `rect`는 실제 송출 영역이다.
- 기본 웹 플레이어는 v1에서 `output`을 무시해도 된다.
- 웰컴보드용 플레이어는 `output`을 반드시 해석해야 한다.

## 플레이어 → CMS 메시지

### Heartbeat

현재 구현 호환 메시지:

```json
{
  "type": "heartbeat",
  "ts": 1778123456789,
  "force": false,
  "player": {
    "mode": "schedule",
    "playback": "playing",
    "currentType": "video",
    "currentFilename": "sample.mp4",
    "streamUrl": null,
    "playbackProfile": "balanced",
    "syncTargetEpochMs": null,
    "channelId": "channel-id",
    "channelName": "채널명",
    "itemIndex": 0,
    "queueSize": 3,
    "lastError": null
  }
}
```

필수 상태:

| 필드 | 값 |
|------|----|
| `mode` | `schedule`, `streaming` |
| `playback` | `idle`, `ready`, `playing`, `buffering`, `armed`, `waiting_window`, `error` |
| `currentType` | `image`, `video`, `web`, `streaming`, null |
| `currentFilename` | 파일명, 웹 콘텐츠명, null |
| `channelId` | 현재 채널 ID |
| `itemIndex` | 현재 재생 인덱스 |
| `queueSize` | 현재 큐 크기 |
| `lastError` | 마지막 에러 코드 또는 null |

웰컴보드용 플레이어는 이후 아래 정보를 추가 보고한다.

```json
{
  "player": {
    "appType": "welcome_board_pc",
    "appVersion": "0.1.0",
    "screen": { "width": 7680, "height": 2160, "scaleFactor": 1 },
    "output": { "x": 0, "y": 0, "width": 7680, "height": 2160 },
    "ready": true
  }
}
```

## 에러 코드 기준

| 코드 | 의미 |
|------|------|
| `image_load_error` | 이미지 로딩 실패 |
| `video_load_error` | 영상 로딩 또는 재생 실패 |
| `web_load_error` | 웹 콘텐츠 로딩 실패 |
| `stream_url_missing` | 스트리밍 URL 없음 |
| `avplay_unavailable` | Tizen AVPlay 사용 불가 |
| `avplay_prepare_timeout` | AVPlay 준비 시간 초과 |
| `avplay_prepare_error` | AVPlay 준비 실패 |
| `avplay_no_playtime` | 준비 후 재생 시간 증가 없음 |
| `avplay_runtime_error` | AVPlay 런타임 에러 |
| `contract_invalid` | CMS 메시지 형식 오류 |

## 버전 관리 규칙

- 현재 계약 버전은 `playerContractVersion: 1`로 본다.
- 기존 웹 플레이어 호환을 위해 `type: "update"` 메시지는 유지한다.
- 새 필드는 선택 필드로 추가한다.
- 기존 필드 의미를 바꿔야 할 때는 계약 버전을 올린다.
- 웰컴보드용 플레이어는 모르는 필드를 무시하되, 모르는 `type`은 에러로 처리하지 않고 로그만 남긴다.

## 다음 구현 순서

1. 웰컴보드 플레이어 설치/배포 패키징 설계
2. 웰컴보드 플레이어 자동 실행 등록 방식 정리
3. 웰컴보드 출력 설정 UI를 전용 편집 모달로 개선
4. 고해상도/비정형 출력 검증 항목을 `VALIDATION_MATRIX.md`에 추가

## 현재 코드 반영 상태

- CMS 메시지에 `playerContractVersion: 1` 추가
- 기기 유형 정규화에 `pc_web`, `welcome_board_pc` 추가
- 기존 `pc` 값은 호환을 위해 `pc_web`으로 해석
- 웰컴보드용 PC 등록 시 PC가 출력할 전체 화면 해상도를 `output.canvas`에 저장하고, 호환용 `output.rect`는 기본적으로 전체 화면과 동일하게 둠
- 웰컴보드 출력 설정 UI는 모니터 해상도만 입력하며, 콘텐츠 배치 영역은 콘텐츠 등록 단계에서 결정
- 웰컴보드용 PC에 전송하는 스케줄 payload에 기기별 `output` 포함
- 콘텐츠 등록 팝업은 웰컴보드 모드로 전환할 수 있고, 등록된 웰컴보드 PC의 `output.canvas` 해상도를 디자이너 stageSize로 불러올 수 있음
- 웹 플레이어 heartbeat에 `appType`, `appVersion`, `screen`, `output`, `ready` 선택 필드 추가
- `/client`는 Tizen 환경이면 `appType: signage`, 일반 브라우저면 `appType: pc_web`으로 보고
- 서버는 heartbeat 확장 필드를 `/api/players/online`의 `player` 객체에 보존
- 관리자 기기 카드에 준비 상태, 현재 콘텐츠, 앱 정보, 마지막 에러 표시
- `welcome-player/`에 Electron 기반 웰컴보드 플레이어 MVP 추가
- 웰컴보드 플레이어 MVP는 CMS 연결, `update` 수신, `output.canvas`/`output.rect` 해석, heartbeat 보고를 처리
