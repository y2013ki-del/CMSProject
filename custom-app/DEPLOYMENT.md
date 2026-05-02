# Custom App Deployment Draft

> 읽는 시점: 삼성 QMC `Custom App`으로 `/client`를 강제 실행하고 싶을 때
> 관련 문서: `README.md`, `md file/FIRMWARE.md`, `md file/OPERATIONS.md`, `custom-app/README.md`

## 목표

- 일반 웹 브라우저 대신 `Custom App` 실행
- 앱 시작 시 `http://12.23.67.245:8080/client` 로드
- USB 또는 URL 기반 설치 초안 확보

## 앱 구조

```text
custom-app/
├── app.js
├── config.xml
├── index.html
├── styles.css
├── sssp_config.xml.example
└── README.md
```

## 앱 동작

- 앱은 전체화면 셸로 실행됨
- 내부 `iframe`이 `/client`를 로드
- 로드가 늦으면 오버레이 유지 후 재시도 버튼 노출
- 리모컨 `Back` 입력 시 앱 종료 대신 `/client` 재로드

## 빌드 목표물

- 최종 패키지명 예: `cmsplayer.wgt`
- `sssp_config.xml`의 `widgetname`은 확장자 없는 패키지명과 맞춤

예시:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<widget>
  <ver>0.1.0</ver>
  <size>123456</size>
  <widgetname>cmsplayer</widgetname>
  <webtype>tizen</webtype>
  <auto_launch>true</auto_launch>
</widget>
```

주의:
- `<size>`는 실제 `.wgt` 파일 바이트 크기로 교체
- `widgetname`과 실제 파일명이 다르면 설치 실패 가능성 큼

## USB 배포 초안

```text
USB root/
└── SSSP/
    ├── sssp_config.xml
    └── cmsplayer.wgt
```

권장 순서:
1. USB를 FAT32로 포맷
2. 루트에 `SSSP` 폴더 생성
3. `cmsplayer.wgt`, `sssp_config.xml` 복사
4. TV에서 `Custom App` 또는 `URL Launcher`의 USB 설치 메뉴 진입
5. 설치 후 자동 실행 여부 확인

## URL 배포 초안

웹서버 경로 예:

```text
http://12.23.67.245/deploy/custom-app/sssp_config.xml
http://12.23.67.245/deploy/custom-app/cmsplayer.wgt
```

서버 폴더 예:

```text
deploy/custom-app/
├── sssp_config.xml
└── cmsplayer.wgt
```

권장 순서:
1. `.wgt` 빌드 후 서버 업로드
2. `sssp_config.xml`의 `size`, `ver`, `widgetname` 수정
3. TV의 `Custom App` 설치 URL에 `sssp_config.xml` 주소 입력
4. 설치 및 자동 실행 여부 확인

## 인증서 접근 순서

1. 대상 삼성 QMC 장비의 `DUID` 확인
2. DUID를 포함한 Samsung Certificate Profile 생성
3. 개발용 signed `.wgt` 1대 설치 테스트
4. USB 또는 URL 설치 성공 여부 확인
5. 설치가 막히면 Signage 서명/재서명 정책 검토
6. 필요 시 삼성 파트너 채널로 배포 인증서 절차 확인

## 다음 작업 메모

- 다음 작업은 반드시 `DUID 확인`부터 시작
- DUID 없이는 개발용 서명 패키지도 대상 장비 설치 검증이 어려움
- 현재 문서 기준으로 실제 장비 DUID 값은 아직 확보되지 않음
- 브라우저 기반 `/client` 확인 결과 `productinfo unavailable`이므로, 일반 웹 페이지 방식으로는 DUID 확보가 되지 않음

## 현재 결론

- 브라우저 홈 변경은 QMC 계열에서 메뉴가 보장되지 않음
- 현재 CMS는 `/client`를 그대로 재사용 가능
- 가장 유력한 강제 실행 수단은 `Custom App (.wgt)`
- 다만 현재 QMC에서는 `Apps` 개발자 모드 진입이 재현되지 않아, 개발/배포 경로 확인이 추가로 필요함
