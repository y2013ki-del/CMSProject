# FIRMWARE — 펌웨어 및 배포 방향성

> 읽는 시점: URL Launcher, WGT, SSSP 설치/배포 전략을 볼 때
> 관련 문서: `README.md`, `md file/DOC_INDEX.md`, `md file/OPERATIONS.md`

> 이 문서는 QMC에 올라가는 앱(펌웨어)의 빌드·배포·업데이트 전략을 정의합니다.  
> 변경 사항은 이 문서를 업데이트하고 git으로 추적하세요.

---

## 배포 전략 결정

### 채택: URL Launcher 방식 (최우선)

```
QMC 부팅 → URL Launcher → http://12.23.67.245:8080/client 자동 실행
```

**이유:**
- 설치 과정 없음 → 실패 리스크 0
- 서버 `/public/client/` 파일만 수정하면 전체 TV 즉시 반영
- 50대 이상 운영에서 가장 높은 신뢰성
- Tizen 인증서 없이도 동작

**대량 배포 시:**  
마스터 1대 설정 → USB 설정 복제 → 나머지 TV에 USB 적용 (기기당 10초)

---

### 대안: Custom App (.wgt) 방식

URL Launcher가 불가한 기종 또는 오프라인 운영 필요 시 사용.

**구조:**
- `player/index.html` — WGT Shell (최소 기능: 서버 URL로 리다이렉트)
- 실제 플레이어 로직은 서버 `/client`에서 서빙 → WGT 재설치 불필요

**WGT 빌드 순서:**

```bash
# 1. Tizen Studio CLI 필요
#    설치 경로: ~/tizen-studio/
#    PATH 등록: ~/.zshrc에 추가됨

# 2. Samsung 인증서 프로파일 생성
#    Certificate Manager.app 실행:
#    ~/tizen-studio/tools/certificate-manager/Certificate-manager.app
#    → + 버튼 → Samsung 선택 → Profile: CMSProfile
#    → Author 인증서 정보 입력 → Samsung Developer Account 로그인

# 3. WGT 패키지 빌드
cd "/Users/yu-kyoungin/Documents/Cloude Project/06. CMS Project"
tizen package -t wgt -s "CMSProfile" -- player/
mv player/*.wgt public/app.wgt

# 4. QMC에 설치
#    앱 관리 → Install Custom App → http://12.23.67.245:8080/download/app.wgt
```

---

## SSSP 앱 설치 필수 규칙

SSSP 앱 관리 방식으로 설치 시 아래 규칙을 **반드시** 준수:

| 항목 | 규칙 | 위반 시 |
|------|------|--------|
| Package ID | `[10자리].[앱이름]` 예: `y2013ki000.CMSPlayer` | 설치 자체 불가 |
| XML 태그명 | PascalCase: `AppID`, `AppVersion`, `AppURL` | 파싱 실패 |
| .xml MIME | `text/xml` | 200 응답 후 중단 |
| .wgt MIME | `application/widget` | 다운로드 실패 |
| QMC 시간 | NTP 동기화 필수 | 인증서 검증 실패 |

---

## 서버 엔드포인트 (배포 관련)

| 경로 | 역할 |
|------|------|
| `/deploy/sssp_config.xml` | SSSP 앱 설치 설정 파일 |
| `/download/app.wgt` | WGT 실제 파일 다운로드 |
| `/deploy/` | player/ 폴더 전체 서빙 |
| `/client` | 플레이어 실제 UI (public/client/) |
| `/player` | WGT Shell HTML |

---

## 플레이어 기기 식별 방식

QMC가 서버에 접속 시 DUID를 자동 전달:

```js
// player/index.html (WGT Shell)
deviceId = tizen.systeminfo.getCapability("http://tizen.org/system/tizenid");
window.location.replace(SERVER_URL + "?duid=" + encodeURIComponent(deviceId));
```

서버에서:
- DUID를 받으면 IP 매칭으로 displays.json에 자동 저장
- DUID 없으면 `IP_xxx_xxx_xxx_xxx` 형식으로 내부 처리
- 유지보수 인원은 IP만 알면 됨

---

## 버전 관리 정책

- `player/index.html` (WGT Shell): 한 번 설치 후 변경 최소화 (재설치 비용 높음)
- `public/client/` (플레이어 UI): 서버 파일 교체만으로 업데이트, 적극 개발
- `server.js`: git으로 추적, 배포 전 반드시 테스트
- `data/*.json`: git 제외 (운영 데이터)

---

## 현재 Tizen Studio 설치 상태 (macOS)

- Tizen Studio CLI 2.5.25 설치 완료
- PATH 등록 완료 (`~/.zshrc`)
- `cert-add-on` (Samsung Certificate Extension) 설치 완료
- Certificate Manager.app 실행 경로:  
  `~/tizen-studio/tools/certificate-manager/Certificate-manager.app`

**다음 단계:** Certificate Manager에서 Samsung 프로파일 생성 후 WGT 빌드
