# CODE_REVIEW — 현재 코드 기준 리뷰 정리

> 재정리일: 2026-05-05
> 기준 코드: `server.js`, `public/index.html`, `public/client/index.html`
> 목적: 과거 리뷰 문서의 유효성을 현재 코드 기준으로 다시 판정

---

## 상태 범례

| 상태 | 의미 |
|------|------|
| `[ ]` | 아직 유효, 실제 수정 필요 |
| `[~]` | 일부 개선됐지만 후속 작업 필요 |
| `[x]` | 현재 코드 기준 해결됨 |
| `[-]` | 운영 정책 또는 우선순위상 보류 / 해당 없음 |

---

## P0 — 실제로 아직 강한 우선순위인 항목

### P0-1. 관리자 인증 정보 하드코딩

- **상태**: `[ ]`
- **위치**: [server.js](/Users/yu-kyoungin/Documents/Cloude%20Project/06.%20CMS%20Project/server.js:17)

**현재 상태**
```js
const ADMIN_ID = 'admin';
const ADMIN_PW = '!!@@password';
```

**판정**
- 현재도 유효
- 운영 환경에서는 `.env` 또는 실행 환경 변수로 분리하는 것이 맞음

**메모**
- 개발 편의상 기본값을 유지할 수는 있으나, 운영 기본값은 제거 권장

---

### P0-2. JSON 저장 경쟁 조건

- **상태**: `[~]`
- **위치**: [server.js](/Users/yu-kyoungin/Documents/Cloude%20Project/06.%20CMS%20Project/server.js:69)

**현재 상태**
```js
function saveJson(file, data) { /* tmp + rename 원자 저장 적용 */ }
async function queueJsonMutation(file, defaultVal, mutator) { /* 파일별 직렬화 큐 */ }
```

**판정**
- `tmp + rename` 방식의 원자 저장은 적용됨
- 따라서 저장 도중 프로세스 종료로 JSON 파일이 반쯤 깨질 위험은 줄어듦
- 주요 변경 API는 파일별 직렬화 큐를 거치도록 보완됨
- 다만 `ensure*Data()` 같은 정규화 보정 경로와 여러 파일을 한 작업에서 함께 바꾸는 흐름은 완전한 트랜잭션이 아니므로, 일부 잔여 경쟁 조건은 남아 있음

**권장 방향**
- 현재 적용 완료: 임시 파일 저장 후 rename
- 현재 적용 완료: 주요 JSON 변경 API 파일별 직렬화 큐
- 후속 권장: `ensure*Data()` 저장 경로 비동기 직렬화 전환, 다중 파일 갱신 서비스화

**수정 메모**
- 2026-05-05: `saveJson()`을 원자 저장 방식으로 변경
- 2026-05-05: 주요 콘텐츠/스케줄/채널/기기 JSON 변경 API에 파일별 직렬화 큐 적용

---

## P1 — 다음 정리 때 손보는 것이 좋은 항목

### P1-1. WebSocket 메시지 파싱 에러 무시

- **상태**: `[ ]`
- **위치**: [server.js](/Users/yu-kyoungin/Documents/Cloude%20Project/06.%20CMS%20Project/server.js:2740)

**현재 상태**
```js
    } catch {}
```

**판정**
- 현재도 유효
- 잘못된 heartbeat/ping 메시지가 와도 로그가 남지 않아 추적이 어려움

**권장 방향**
- `ws_parse_error` 로그 추가

---

### P1-2. heartbeat 없는 플레이어 정리 누락

- **상태**: `[ ]`
- **위치**: [server.js](/Users/yu-kyoungin/Documents/Cloude%20Project/06.%20CMS%20Project/server.js:2789)

**현재 상태**
```js
if (!info.lastHeartbeatAt) continue;
```

**판정**
- 현재도 유효
- 최초 연결 후 heartbeat가 한 번도 오지 않는 플레이어는 메모리에 오래 남을 수 있음

**권장 방향**
- `lastSeen` 또는 `connectTime` 기준 fallback 정리

---

### P1-3. 미디어 삭제 흐름의 완전한 원자성 부족

- **상태**: `[~]`
- **위치**: [server.js](/Users/yu-kyoungin/Documents/Cloude%20Project/06.%20CMS%20Project/server.js:1727)

**판정**
- 예전보다 개선됨
- 현재는 숨김 원본 정리, 그룹 정리, 메타 정리까지 들어가 있음
- 다만 파일 삭제와 JSON 갱신이 완전한 트랜잭션은 아니므로 중간 실패 시 일부 불일치 가능성은 남아 있음

**메모**
- 예전 문서처럼 P0급은 아님
- 지금은 `P1 유지보수 개선` 정도로 보는 것이 적절

---

### P1-4. 우선순위 정렬 기준 문서 불일치

- **상태**: `[ ]`
- **위치**
  - 코드: [server.js](/Users/yu-kyoungin/Documents/Cloude%20Project/06.%20CMS%20Project/server.js:402)
  - 문서: [md file/UI_GUIDE.md](/Users/yu-kyoungin/Documents/Cloude%20Project/06.%20CMS%20Project/md%20file/UI_GUIDE.md:148)

**현재 코드**
- 숫자가 큰 `priority`가 우선
- 동률이면 최근 `updatedAt` 우선

**판정**
- 코드와 실제 동작은 명확함
- 문서 표현이 아직 모호함

**권장 방향**
- 문서에 “숫자가 높을수록 우선” 명시

---

### P1-5. 구형 Tizen 호환성 일부 미정리

- **상태**: `[ ]`
- **위치**: [public/client/index.html](/Users/yu-kyoungin/Documents/Cloude%20Project/06.%20CMS%20Project/public/client/index.html:76)

**현재 상태**
```js
const queryDuid = new URLSearchParams(window.location.search).get('duid');
```

**판정**
- 현재도 유효
- 과거 문서에서 지적된 `URLSearchParams` 이슈가 플레이어 코드에 일부 남아 있음

**메모**
- 전면 호환성 보강이 목표라면 수동 파서로 교체 권장

---

## P2 — 선택적 개선 항목

### P2-1. 로그 레벨 구분 없음

- **상태**: `[ ]`
- **위치**: [server.js](/Users/yu-kyoungin/Documents/Cloude%20Project/06.%20CMS%20Project/server.js:643)

**판정**
- 현재 `category`는 있으나 `level`은 없음
- 운영 분석 시 `info / warn / error / debug` 분리가 있으면 더 좋음

**메모**
- 기능 장애보다는 운영 가시성 개선 항목

---

## 이미 해결되었거나 현재 우선순위가 낮은 항목

### R-1. FFmpeg 프로세스 누수

- **상태**: `[x]`
- **근거 위치**: [server.js](/Users/yu-kyoungin/Documents/Cloude%20Project/06.%20CMS%20Project/server.js:838)

**판정**
- 과거 문서의 “맵 정리 없음” 설명은 현재 코드와 다름
- `exit`에서 `cameraProcesses.delete(cam.name)`가 이미 수행됨
- 추가 개선 여지는 있지만, 기존 문서 수준의 치명 이슈는 아님

---

### R-2. UI 에러 메시지 필드 불일치

- **상태**: `[x]`
- **근거 위치**: [public/index.html](/Users/yu-kyoungin/Documents/Cloude%20Project/06.%20CMS%20Project/public/index.html:1189)

**현재 상태**
```js
throw new Error(e.error || 'API Error');
```

**판정**
- 이미 해결됨

---

### R-3. 인증 미들웨어 경계 불명확

- **상태**: `[-]`
- **근거 위치**: [server.js](/Users/yu-kyoungin/Documents/Cloude%20Project/06.%20CMS%20Project/server.js:1637)

**판정**
- 현재는 공개 라우트 뒤에 `app.use(authMiddleware)` 경계가 분명히 있음
- 가독성 개선은 가능하지만, 현재 기준의 주요 리뷰 포인트는 아님

---

### R-4. CCTV IP 화이트리스트 비어 있으면 전체 허용

- **상태**: `[-]`
- **근거 위치**: [server.js](/Users/yu-kyoungin/Documents/Cloude%20Project/06.%20CMS%20Project/server.js:100)

**판정**
- 현재 정책상 “호환 모드”로 의도된 동작
- 게다가 CCTV 자체가 기본 비활성이라 우선순위 낮음

---

### R-5. PM2/systemd 미구성

- **상태**: `[-]`

**판정**
- 코드 리뷰라기보다 운영 권고 사항
- `OPERATIONS.md`에 운영 방식으로 분리 관리하는 것이 더 적절

---

## 현재 기준 진짜로 남은 핵심 항목 요약

1. 관리자 계정/비밀번호 하드코딩
2. JSON 저장 경쟁 조건
3. WebSocket parse error 무시
4. heartbeat 없는 플레이어 정리
5. 우선순위 기준 문서 명확화
6. 구형 Tizen `URLSearchParams` 정리

---

## 다음 액션 추천 순서

1. `ADMIN_*` 환경변수화
2. `saveJson()` 원자적 저장으로 변경
3. WebSocket parse error 로그 추가
4. 플레이어 stale 정리 fallback 추가
5. 문서(`UI_GUIDE.md`)에 우선순위 기준 명시
6. `public/client/index.html` 쿼리 파서 구형 호환 처리

---

## 재검토 메모

- 이 문서는 과거 리뷰 내용을 그대로 유지하지 않고, 현재 코드 기준으로 주기적으로 다시 판정해야 함
- 다음 재검토 시점 권장:
  - 플레이어 구조 변경 후
  - 운영 배포 전
  - 50대 이상 확장 전
