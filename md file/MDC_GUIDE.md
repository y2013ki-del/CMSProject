# MDC_GUIDE — 삼성 MDC 제어 가이드

> 읽는 시점: TV 제어, MDC 포트/ID, 전원 켜기(WoL), timeout 진단을 할 때
> 관련 문서: `README.md`, `md file/DOC_INDEX.md`, `md file/ERROR_LOG.md`, `md file/API_REFERENCE.md`

## 연결 기준

```text
접속 포트: TCP 1515
기기 ID: 0x01   ← 현재 장비 설정 기준 (Device ID = 1)
대체 ID: 0x00   ← 장비 설정이 0인 경우에만 사용
프레임: 0xAA [CMD] [ID] [LEN] [DATA...] [CHECKSUM]
GET(쿼리): LEN=0x00, DATA 없음
응답: 0xAA 0xFF [ID] [LEN] 0x41(ACK) [CMD] [DATA] [CS]
```

## 주요 명령

```text
전원:   CMD 0x11 / SET: 0x01(ON) 0x00(OFF) / GET: LEN=0
볼륨:   CMD 0x12 / SET: 0x00~0x64          / GET: LEN=0
음소거: CMD 0x13 / SET: 0x01(ON) 0x00(OFF) / GET: LEN=0
입력:   CMD 0x14 / SET: 0x20(MagicInfo) 0x00(TV) 0x21(HDMI1) 0x23(HDMI2) 0x25(DP) 0x18(DVI)
채널:   CMD 0x04 / SET: [high][low] (2바이트, 채널 1~999)
밝기:   CMD 0x76 / SET: 0x00~0x64
```

## TV 설정 확인

- `QMC 설정 → 일반 → 네트워크 → 서버 네트워크 설정 → MDC 연결 ON`
- TV의 서버 연결은 `12.23.67.245:8080`
- MDC 제어는 기본 포트 `1515` 사용

## 진단 순서

1. TV IP와 서버가 같은 네트워크인지 확인
2. Windows PowerShell에서 `Test-NetConnection <TV_IP> -Port 1515` 확인
3. `TcpTestSucceeded : True`면 포트 접근 가능
4. TV의 Device ID 값과 `server.js`의 `MDC_ID`가 같은지 확인

## 주의

- 웹 플레이어 연결 상태와 MDC 연결 상태는 다를 수 있음
- 일부 모델은 `power_off` 시 응답 없이 내려갈 수 있음
- `tv_restart`는 운영상 `전원 OFF → 대기 → 전원 켜기(WoL)` 흐름으로 보는 것이 안전
- 현재 장비 기준으로 `전원 OFF`는 MDC가 동작하지만, `전원 켜기`는 WoL 기반으로 보는 것이 안전
