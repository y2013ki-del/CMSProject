# OPERATIONS — 설치 및 운영 가이드

> 읽는 시점: 서버 설치, 운영 절차, 기기 등록 흐름을 확인할 때
> 관련 문서: `README.md`, `md file/DOC_INDEX.md`, `md file/FIRMWARE.md`, `md file/ERROR_LOG.md`

## 사전 준비

- **Node.js** LTS — `node -v` 로 확인
- **FFmpeg** — CCTV 사용 시 필요. Windows: `C:\ffmpeg\bin\ffmpeg.exe`
- 서버 PC ↔ QMC 디스플레이 **동일 네트워크** 필수
- 서버 PC **고정 IP** 권장
- 방화벽 TCP **8080** 인바운드 허용

## 설치

```bash
# 1. 프로젝트 폴더를 서버 PC에 복사
#    예) D:\cms-server\

# 2. 패키지 설치
cd D:\cms-server
npm install

# 사내망 인터넷 차단 시: 외부 PC에서 npm install 후 node_modules 폴더 통째로 복사
```

## IP 설정

`server.js` 상단의 `PROXY_IP`를 서버 PC의 실제 IP로 설정:

```js
const PROXY_IP = '12.23.67.245';
```

실제 IP 확인: CMD → `ipconfig` → IPv4 주소

## 서버 실행

```bash
node server.js
```

정상 출력:

```text
CMS 서버 실행 중: http://localhost:8080
플레이어 앱:       http://12.23.67.245:8080/player?channel=<채널ID>
RTSP 프록시:      http://localhost:8080/stream/<카메라명>
```

초기 로그인: `admin` / `!!@@password`

## Windows 자동 시작

```cmd
# 등록 (관리자 CMD)
schtasks /create /tn "CMS-Server" /tr "node D:\cms-server\server.js" /sc onstart /ru SYSTEM /f

# 수동 제어
schtasks /run /tn "CMS-Server"      ← 시작
schtasks /end /tn "CMS-Server"      ← 중지
schtasks /query /tn "CMS-Server"    ← 상태
tasklist | findstr node             ← 프로세스 확인
```

## 기기 등록 및 채널 배정 흐름

```text
Step 1. 서버 실행
Step 2. 관리자 UI → http://12.23.67.245:8080 접속
Step 3. 콘텐츠 탭 → 파일 업로드 (이미지/동영상)
Step 4. 스케줄 탭 → 채널 생성 → 콘텐츠 추가 → 저장
Step 5. QMC URL Launcher에 http://12.23.67.245:8080/client 입력
Step 6. 기기 관리 탭 → IP로 기기 확인 → 채널 배정
         (미등록 기기는 자동 감지 → "이 기기 등록하기" 버튼)
Step 7. 스케줄 수정 → 저장 → WebSocket으로 즉시 전체 반영
```

## DUID 처리 정책

- 유지보수 인원은 **IP 주소만** 알면 됨
- DUID는 QMC가 서버에 자동 전달
- 서버가 IP 매칭으로 `displays.json`에 자동 저장
- 관리자 UI에는 IP만 표시, DUID는 내부 처리
