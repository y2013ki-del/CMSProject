# UI_GUIDE — 관리자 UI 및 플레이어 UI 방향성

> 읽는 시점: 관리자 화면, 플레이어 UI, 제어 패널 동작을 확인할 때
> 관련 문서: `README.md`, `md file/DOC_INDEX.md`, `md file/API_REFERENCE.md`

> 새 화면을 개발하거나 기존 UI를 수정할 때 이 문서를 기준으로 삼으세요.  
> 디자인 결정 사항이 생기면 이 문서에 추가하세요.

---

## 공통 디자인 원칙

1. **심플 우선** — 기능 과잉 금지. 유지보수 인원이 직관적으로 조작 가능해야 함
2. **IP 기반** — 기기 식별은 항상 IP로. DUID는 UI에 노출하지 않음
3. **상태 명확** — ONLINE/OFFLINE 상태는 색상으로 즉각 구분
4. **반응 피드백** — 모든 액션은 toast 알림으로 결과 전달
5. **인라인 편집** — 모달/팝업 최소화, 테이블에서 직접 편집

---

## 관리자 UI (`public/index.html`)

### 색상 팔레트

```css
--bg: #f8f9fa          /* 페이지 배경 */
--surface: #ffffff      /* 카드/섹션 배경 */
--surface2: #f1f3f5    /* 보조 배경, 툴바 */
--border: #dee2e6       /* 구분선 */
--accent: #C9A227       /* 주 강조색 (골드) */
--accent-h: #A8841A    /* 호버 강조색 */
--text: #212529         /* 본문 텍스트 */
--muted: #868e96        /* 보조 텍스트, 레이블 */
--online: #40c057       /* 온라인 상태 */
--danger: #fa5252       /* 오프라인 / 삭제 / 오류 */
--primary: #228be6      /* 보조 액션 (파란색) */
```

**헤더**: `#1a1a1a` (다크) — 흰색 텍스트, sticky 상단 고정

### 탭 구조

| 탭 | 역할 |
|----|------|
| 기기 관리 | IP 기반 디스플레이 등록/상태/채널 배정/MDC 제어 |
| 콘텐츠 | 미디어 파일 업로드 / 라이브러리 |
| 스케줄 | 스케줄(콘텐츠 리스트) 편집, 즉시 배포 |
| 채널 | 채널별 기본 스케줄/시간 규칙/우선순위 스케줄링 |
| CCTV | MagicInfo ZIP 생성, 카메라 관리, 자체 CMS 라이브 뷰 |
| 로그 | 카테고리별 이벤트 로그 (스트림/제어/스케줄/시스템) |

### 기기 관리 탭 UI 규칙

**구조: 2-패널 분리**

| 영역 | 역할 |
|------|------|
| 접속 감지 (좌) | 미등록 신규 기기만 표시. "이 기기 등록하기" 버튼으로 모달 팝업 |
| 구역별 현황 (우/메인) | 등록된 기기를 구역(zone) 카드 뷰로 실시간 표시 |

**구역 카드 뷰 규칙**
- DUID 표시 없음 (서버 내부 처리)
- **WebSocket 상태**: `ONLINE`(초록) / `OFFLINE`(빨강) 태그 — URL Launcher 연결 여부
- **MDC 상태 바**: 전원·볼륨·입력소스를 30초마다 자동 폴링해 카드 상단에 표시. `↻` 버튼으로 즉시 갱신
- 기기명·구역: 클릭 시 `prompt()` 인라인 편집 (즉시 저장)
- CMS 채널 배정: 카드 내 `<select>` — 변경 즉시 API 호출
- **확장 제어 섹션**: 입력 소스 드롭다운 / 볼륨 숫자 입력 / TV 채널 번호 입력
- 전원 켜기 버튼: MAC 주소 등록 시 활성화, 내부적으로 UDP Magic Packet 전송
- MAC 미등록: 카드 하단 "+ MAC 주소 등록 (전원 켜기)" 클릭 → `prompt()` 입력
- 기기 관리 탭 진입 시 30초 자동 갱신 (`_dashInterval`)

**MDC 입력 소스 코드 대응표**

| UI 표시 | value 값 | MDC 코드 |
|---------|----------|----------|
| MagicInfo (CMS) | `magicinfo` | `0x20` |
| TV (튜너) | `tv` | `0x00` |
| HDMI 1 | `hdmi1` | `0x21` |
| HDMI 2 | `hdmi2` | `0x23` |
| DisplayPort | `dp` | `0x25` |
| DVI | `dvi` | `0x18` |

**신규 기기 등록 모달 필드**

| 필드 | 비고 |
|------|------|
| IP | 자동 입력 (readonly) |
| 기기명 | 필수 |
| 구역 | 선택 (미입력 시 "미분류") |
| MAC 주소 | 선택 (전원 켜기 사용 시) |
| 채널 | 드롭다운 선택 |

- 원격 재시작: OFFLINE 시 disabled 처리

### 로그 탭 UI 규칙

- 카테고리 컬러 뱃지:
  - `스트림` → `#2471a3` (파랑)
  - `제어` → `#9b59b6` (보라)
  - `스케줄` → `#e67e22` (주황)
  - `시스템` → `#7f8c8d` (회색)
- 배경: `#1a1a1a` (다크 터미널 스타일), monospace 폰트
- 실시간 검색 + 카테고리 필터 + 최대 500건

### CCTV 탭 UI 규칙

- 분할 모드(`1/2/4`)에 맞춰 정확히 같은 수의 카메라를 선택해야 ZIP 생성 가능
- 선택된 카메라는 카드에서 실시간 MJPEG 미리보기 표시
- 카드/테이블 모두에서 `재시작`, `PW 변경`, `삭제` 가능
- `자체 CMS 라이브 뷰` 버튼은 `/cctv/live?...` URL을 새 창으로 열어 MagicInfo 없이도 동일 레이아웃 확인 가능
- `라이브 URL 복사`는 자체 CMS 채널/웹뷰 이식 시 바로 재사용 가능한 링크 제공

### 콘텐츠 탭 UI 규칙

- 미디어 그룹 시스템: 업로드 시 그룹 지정 가능 (`data/media-groups.json`)
- 그룹 탭으로 필터링, "전체" 탭은 항상 맨 앞
- 동영상 파일: `<video preload="metadata" controls>` 태그로 인라인 미리보기 제공
- 이미지 파일: `<img>` 썸네일

### 스케줄 탭 UI 규칙

- 채널 선택 후 콘텐츠 피커에서 그룹 탭으로 필터링
- 항목 추가: 누적 추가 방식 (클릭할 때마다 기존 목록에 append, 교체 아님)
- 순서 변경: HTML5 Drag & Drop (`draggable` 속성, `schedDragSrcIdx` 상태 변수)
- 기간 미입력 시: `∞ 무한재생` 배지 표시 (startAt·endAt 모두 비어 있을 때)
- 피커 영역: `renderPicker()` 와 `renderSchedItems()` 분리 — 항목 추가 시 피커 그룹 탭 상태 유지
- 스케줄 그룹: 좌측 목록에서 `그룹 추가` 버튼으로 생성
- 그룹 묶기: 스케줄 카드 드래그앤드롭으로 그룹 박스에 배치 (`groupId` 저장)

### 채널 탭 UI 규칙

- 채널 단위로 송출 대상을 관리 (디스플레이는 채널에 연결)
- 기본 스케줄: 시간 규칙이 없거나 미적용일 때 사용
- 시간 규칙: `기간 규칙` 또는 `주간 반복(요일/시작시간/종료시간)` + 스케줄 + 우선순위 + 활성 여부
- 동일 시간대 규칙 중복 시 우선순위(숫자 큰 값) 기준으로 자동 선택
- 우선순위가 같으면 최근 수정 규칙이 우선 적용

---

## 플레이어 UI (`public/client/`)

> 이 경로가 QMC URL Launcher의 실제 재생 화면입니다.

### 핵심 원칙

1. **전체화면** — 항상 100vw × 100vh, overflow hidden
2. **검정 배경** — 콘텐츠 없는 영역은 `#000000`
3. **UI 없음** — 관리자 UI 요소(버튼, 레이블) 플레이어에 표시 금지
4. **자동 복구** — 네트워크 끊김 시 마지막 스케줄로 자동 유지
5. **무소음 실패** — 오류가 발생해도 화면이 멈추지 않도록 처리

### 재생 로직 방향

```
서버 연결 → WebSocket /ws/player?channel=xxx 구독
→ 스케줄 수신 → 아이템 순서대로 재생
→ 이미지: CSS transition / 동영상: AVPlay API (Tizen) 또는 <video>
→ WebSocket 메시지 type:update → 즉시 스케줄 교체
→ 연결 끊김 → 5초 후 재연결 시도 (무한 반복)
```

### AVPlay 운영 기본값 (QM43 / QM65 공통)

- QMC 계열(QM43/QM65)은 동일한 기본 프리셋으로 시작
- 재생 프로필:
  - `안정형(stable)`: `play buffer 8s`, `resume buffer 12s`, `buffer timeout 8s`
  - `균형형(balanced, 기본)`: `play buffer 6s`, `resume buffer 8s`, `buffer timeout 6s`
  - `저지연형(low_latency)`: `play buffer 4s`, `resume buffer 5s`, `buffer timeout 4s`
- 적용 순서: `open()` → `setListener()` → `setBufferingParam()` / `setTimeoutForBuffering()` → `prepareAsync()` → `play()`
- 스트리밍 일괄 실행 시 서버가 공통 `targetEpochMs`를 내려주고, 플레이어는 `prepareAsync` 완료 후 목표 시각에 `play()` 실행

### 오버레이 레이어

- `overlay.png` — 반투명 PNG, 콘텐츠 위에 고정
- `pointer-events: none` — 클릭 이벤트 통과
- 로딩 실패 시 `display:none` 처리 (숨김)

### 디버그 모드

```js
var DEBUG = true; // 화면 하단에 연결 상태 / 현재 재생 항목 표시
```

PC 브라우저 테스트 시에만 활성화, QMC 배포 전 `false`로 복원.

---

## 개발 시 체크리스트

### 새 관리자 화면 추가 시
- [ ] 탭 버튼 추가 (`switchTab` 연결)
- [ ] 인증 필요 API는 `authMiddleware` 적용 확인
- [ ] 오류는 `toast(message, 'error')` 로 표시
- [ ] 성공은 `toast(message)` 로 표시

### HTML 동적 생성 시 주의
- 템플릿 리터럴(`` ` ``) 내부 ternary 분기 모두 템플릿 리터럴로 작성할 것
- 일반 문자열(`'...'`) 안에서 `${var}` 는 보간되지 않음 → onclick 오작동 원인
  ```js
  // 금지
  `${cond ? `<span>ok</span>` : '<span onclick="fn(\'${id}\')">x</span>'}`
  // 정상
  `${cond ? `<span>ok</span>` : `<span onclick="fn('${id}')">x</span>`}`
  ```

### 새 플레이어 기능 추가 시
- [ ] SSSP 7 이상 호환 확인 (구형 Tizen API 주의)
- [ ] `URLSearchParams` 미사용 (수동 파서 사용)
- [ ] `crypto.randomUUID()` 미사용 (HTTP 환경 비호환)
- [ ] muted 속성 값 주의 (`muted="false"` 금지 → 속성 제거)
- [ ] DEBUG 모드 false 확인 후 배포
