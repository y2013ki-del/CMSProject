# PROJECT_STATUS — 개발 현황

> 읽는 시점: 현재 구현 범위, 우선순위, 남은 작업을 파악할 때
> 관련 문서: `README.md`, `md file/DOC_INDEX.md`, `md file/ERROR_LOG.md`

## 현재 진행 상황

```text
Phase 1 — 서버 기반 + 05 기능 이전          ✅ 완료
  ├── Express 서버 (인증 / 세션 / 로그)
  ├── CCTV 스트리밍 (05 완전 이전)
  └── 디스플레이 등록 / 상태 관리 (IP 기반)

Phase 2 — 콘텐츠 + 스케줄                   ✅ 완료
  ├── 미디어 업로드 / 라이브러리
  ├── 미디어 그룹 시스템 (media-groups.json)
  ├── 스케줄 CRUD + 엔진
  ├── WebSocket 스케줄 즉시 푸시
  ├── 스케줄 드래그앤드롭 순서 변경
  └── 콘텐츠 피커 그룹 탭 + 누적 추가

Phase 3 — QMC 플레이어 앱                   🔄 진행중
  ├── URL Launcher → /client 방식 확인됨
  ├── WGT Shell (player/index.html) 완성
  ├── /client 플레이어 UI 구현됨
  ├── `/client` DUID 진단 오버레이 추가됨
  └── 브라우저 컨텍스트에서 `webapis.productinfo` 미노출 확인

Phase 4 — TV 제어 + 씽크                    🔄 진행중
  ├── MDC 모듈 구현됨 (전원/입력/볼륨/채널/음소거)
  ├── MDC 상태 폴링 구현됨 (30초 주기, GET 쿼리 방식)
  ├── Wake-on-LAN 구현됨 (UDP Magic Packet, MAC 주소 등록)
  ├── 구역 카드 뷰 실시간 모니터링 구현됨
  ├── 일괄 제어 UI/결과 패널 추가됨
  ├── MDC Device ID `1` 확인 후 제어 정상화
  ├── `전원 OFF`, 입력, 볼륨 제어 성공 확인
  ├── `전원 켜기(WoL)`는 송신 성공까지 확인, 실제 기동은 실패
  └── NTP 타임스탬프 기반 씽크 커맨드 — ⏳ 예정
```

## 운영 메모

- 서버: `12.23.67.245:8080`
- 초기 로그인: `admin / !!@@password`
- 디스플레이: 삼성 QMC 시리즈 (SSSP 7/10)
- 기반 프로젝트: `05. CCTV Magicinfo`

## 다음 작업 시작점

- 다음 작업은 삼성 QMC 장비의 `DUID 확인`부터 진행
- 이유: `Custom App (.wgt)` 서명과 설치 테스트에는 대상 장비의 실제 DUID가 필요함
- 현재 확보된 값: IP, MAC, Device ID
- 현재 미확보 값: 일부 장비의 서명용 DUID
- 현재 진단 결과:
  - 브라우저 기반 `/client`에서는 `productinfo unavailable`
  - 서버에 저장된 `TV_xxxxx` 값은 임시 fallback 식별자
  - `Apps > 12345` 개발자 모드 진입은 현재 QMC UI에서 재현 실패
  - Tizen Device Manager 기준 QMC 장비 1대 DUID 확인: `KLCC36H4KBI6A` (`12.23.67.100`)
- WoL 관련 현재 결론:
  - 서버는 `255.255.255.255`와 `12.23.68.255` 모두 테스트 가능하도록 수정 완료
  - 로그상 `targetIp="12.23.68.255" port="9"` 전송 성공 확인
  - 실제 전원 ON 실패 원인은 CMS가 아니라 QMC WoL 지원성 또는 사내망 broadcast 정책 가능성 높음
- 후속 순서:
  1. 장비 DUID 확인
  2. Samsung Certificate Profile 생성
  3. signed `.wgt` 빌드
  4. USB 또는 URL 설치 테스트

## 최신 작업 요약 (2026-04-21)

- 기기 제어 UI를 `모니터링` / `제어` 탭으로 분리
- 개별 제어를 `선택 후 확인` 흐름으로 변경하고 순차 전송 구조 적용
- `전원 켜기(WoL)` / `전원 OFF` / `웹 플레이어 복귀` / `TV 재시작` 흐름 정리
- `전원 켜기(WoL)`는 사용자 표기를 `전원 켜기`로 통일
- WoL 브로드캐스트 대상을 환경변수 `WOL_BROADCAST_IP`로 분리
- `MDC_ID = 0x01` 적용 후 QMC 제어 정상 동작 확인
- `웹 플레이어 복귀`는 서버에 이미 붙어 있는 플레이어에만 유효함을 확인
- `MagicInfo 입력 전환`은 현재 장비에서 `현재 모드에서는 지원되지 않습니다` 확인
- 브라우저 기반 `/client`는 삼성 전용 `webapis.productinfo` 컨텍스트가 아님을 확인
- 커스텀 앱 초안(`custom-app/`) 및 USB/URL 배포 문서 작성 완료

## 최신 작업 요약 (2026-04-27)

- Windows 환경에서 `sdb connect 12.23.67.100:26101` 연결 성공 상태 확인 (`device qm65c`)
- Tizen Device Manager에서 실제 DUID 확인: `KLCC36H4KBI6A`
- DUID 확인용 페이지 추가: `/client/duid-check.html`
