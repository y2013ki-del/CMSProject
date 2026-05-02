# ERROR_LOG — CMS 오류 발생 기록

> 읽는 시점: 장애 원인 추적, 임시 조치, 재현 이력을 확인할 때
> 관련 문서: `README.md`, `md file/DOC_INDEX.md`, `md file/MDC_GUIDE.md`, `md file/PROJECT_STATUS.md`

> 새 오류 발생 시 이 파일에 기록하세요.  
> 문제 해결 전 **이 파일을 먼저 확인**하면 동일 오류의 재조사를 방지할 수 있습니다.

---

## 기록 형식

```
## [날짜] 오류 제목
- **증상**: 어떤 상황에서 어떤 현상이 발생했는가
- **원인**: 확인된 원인
- **해결**: 적용한 수정 내용 (파일명:라인 포함)
- **참고**: 관련 커밋 / 문서 링크
```

---

## 기존 패치 이력 (적용 완료)

### [2026-04-21] CCTV 탭 이식 누락으로 카메라/ZIP 기능 실동작 실패

- **증상**: CMS의 CCTV 탭에서 카메라 목록이 비정상 렌더링되거나, 분할 수와 무관하게 전체 카메라로 ZIP 생성이 시도되어 MagicInfo 업로드용 패키지와 자체 CMS용 레이아웃 검증이 어려움
- **원인**:
  - `public/index.html`의 `loadCameras()`가 `/api/cameras` 응답 `{ cameras: [] }`를 배열로 오인
  - `05. CCTV Magicinfo`의 선택형 카메라 흐름이 누락되어 분할 수 검증/카메라 선택/비밀번호 변경/재시작 UX가 빠짐
- **해결**:
  - `public/index.html` CCTV 탭을 선택형 레이아웃으로 복구
  - `/cctv/live` 공개 라우트를 추가해 MagicInfo 없이도 동일 스트림 레이아웃 사용 가능하게 확장
  - `server.js`에서 ZIP 생성 시 분할 수와 카메라 수를 검증하고 `/api/logs`에 `lines` 호환 파라미터 추가
- **참고**:
  - `server.js`
  - `public/index.html`
  - `md file/API_REFERENCE.md`

### [2026-04-14] `muted="false"` 오디오 재생 안 됨

- **증상**: 플레이어에서 동영상 재생 시 오디오가 출력되지 않음
- **원인**: HTML boolean 속성은 값과 무관하게 속성 존재 자체가 true. `muted="false"`는 사실상 `muted` 처리됨
- **해결**: `player/index.html`에서 `muted="false"` 제거
- **참고**: MDN — Boolean attributes

---

### [2026-04-14] `URLSearchParams` 구형 SSSP 미지원

- **증상**: 구형 SSSP 펌웨어(6 이하) 기기에서 채널 파라미터 파싱 실패
- **원인**: `URLSearchParams`가 SSSP 6 이하 Tizen에 미지원
- **해결**: `player/index.html` — 수동 쿼리 파서로 교체
  ```js
  // 변경 전
  const ch = new URLSearchParams(location.search).get('channel');
  // 변경 후
  var ch = (location.search.match(/[?&]channel=([^&]*)/) || [])[1] || '';
  ```

---

### [2026-04-14] `crypto.randomUUID()` HTTPS 전용 오류

- **증상**: HTTP 환경(내부망)에서 기기 ID 생성 실패
- **원인**: `crypto.randomUUID()`는 Secure Context(HTTPS) 전용 API
- **해결**: `player/index.html` — 대체 구현
  ```js
  // 변경 전
  const id = crypto.randomUUID();
  // 변경 후
  var id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  ```

---

### [2026-04-14] multer 한글 파일명 깨짐

- **증상**: 한글 포함 파일명 업로드 시 파일명 깨짐
- **원인**: multer가 multipart 파일명을 latin1로 파싱
- **해결**: `server.js` multer filename 콜백에 try/catch 추가
  ```js
  let original = file.originalname;
  try { original = Buffer.from(file.originalname, 'latin1').toString('utf8'); } catch {}
  ```

---

### [2026-04-16] MAC 주소 등록 클릭 시 "디스플레이 없음" 팝업

- **증상**: 등록된 기기 카드에서 "+ MAC 주소 등록 (WoL)" 클릭 시 404 "디스플레이 없음" 팝업 발생
- **원인**: `renderZones()` 내부 ternary 표현식의 falsy 분기가 일반 문자열(`'...'`)로 작성되어 `${d.id}`가 문자 그대로 출력됨. onclick이 `editField('${d.id}','mac','')` 를 호출 → 존재하지 않는 ID라 404 반환
- **해결**: `public/index.html` 510번 줄 — falsy 분기를 템플릿 리터럴로 교체
  ```js
  // 변경 전 (버그)
  ${d.mac?`<div>MAC: ${d.mac}</div>`:'<div onclick="editField(\'${d.id}\',\'mac\',\'\')">+ MAC 주소 등록</div>'}

  // 변경 후 (정상)
  ${d.mac
    ? `<div style="...">MAC: ${d.mac}</div>`
    : `<div style="..." onclick="editField('${d.id}','mac','')">+ MAC 주소 등록 (WoL)</div>`}
  ```
- **참고**: UI_GUIDE.md → 개발 시 체크리스트 "HTML 동적 생성 시 주의" 항목 추가

---

## 미해결 / 추적 중

### [2026-04-21] 브라우저 기반 `/client`에서 실제 DUID 확보 실패

- **증상**: 서버에 저장된 플레이어 식별값이 `TV_VWPKMF13R` 형태로 보이며, 서명용 삼성 DUID 확보에 실패
- **원인**:
  - `public/client/index.html`의 `webapis.productinfo.getDUID()`가 브라우저 환경에서 노출되지 않음
  - TV 화면 진단 결과 `productinfo unavailable` 확인
  - 현재 값 `TV_xxxxx`는 localStorage 또는 랜덤 fallback 식별자
- **해결/조치**:
  - `public/client/index.html`에 DUID 진단 오버레이 추가
  - `source: webapis.productinfo.getDUID() / tizen.systeminfo / localStorage fallback / generated fallback` 구분 표시
  - 결론적으로 브라우저만으로는 DUID 확보가 어렵다고 판단
- **참고**:
  - `public/client/index.html`
  - `custom-app/DEPLOYMENT.md`
  - `md file/PROJECT_STATUS.md`

---

### [2026-04-21] WoL 송신 성공 후에도 실제 TV 전원 ON 실패

- **증상**: `전원 켜기` 실행 시 서버 로그에는 `wol_sent`가 찍히고 `targetIp="12.23.68.255" port="9"`까지 확인되지만 TV는 켜지지 않음
- **원인 (추정)**:
  - QMC 모델/펌웨어의 WoL 지원성 또는 전원 대기 조건 불충분
  - 사내망의 directed broadcast 전달 제한 가능성
- **해결/조치**:
  - `server.js`에 `WOL_BROADCAST_IP` 설정 추가
  - `255.255.255.255`와 `12.23.68.255` 비교 테스트 가능하게 수정
  - 결론적으로 WoL 실패 원인은 CMS보다 장비 또는 네트워크 정책일 가능성이 높음
- **참고**:
  - `server.js`
  - `md file/MDC_GUIDE.md`
  - `md file/PROJECT_STATUS.md`

---

### [2026-04-17] MDC `ECONNREFUSED 12.23.68.40:7001`

- **증상**: MDC 제어 및 상태 폴링 시 `connect ECONNREFUSED IP:7001` 오류
- **원인 (추정)**: MDC 포트를 서버 코드에서 7001로 변경했으나, TV QMC 설정에서 동일하게 변경되지 않았거나 MDC 자체가 비활성화 상태일 가능성
- **해결 방법 (택일)**:
  1. TV 설정 변경: `QMC → 설정 → 일반 → 네트워크 → 서버 네트워크 설정 → MDC 포트: 7001, MDC 연결: ON`
  2. 서버 포트 복구: `server.js` 내 `7001` → `1515` 전체 치환
- **현재 상태**: 서버 기준 `1515` 복구로 방향 전환. TV 서버 연결은 `12.23.67.245:8080`, MDC 제어는 기본 포트 `1515` 사용 권장

---

## 주의사항

- SSSP 앱 설치 시 Package ID가 `[10자리].[앱이름]` 형식이 아니면 설치 자체가 되지 않음
- sssp_config.xml 다운로드 중 멈춤 → MIME Type 확인 (`.wgt`는 반드시 `application/widget`)
- QMC 시간이 맞지 않으면 wgt 설치 실패 가능 (NTP 설정 필수)
- QMC 브라우저 환경은 `webapis.productinfo`를 항상 노출하지 않으므로, 브라우저 기반 DUID 확보는 실패할 수 있음
- `Apps > 12345` 개발자 모드 경로는 현재 QMC UI에서 재현되지 않았으며, 일반 TV와 동일하게 가정하면 안 됨
