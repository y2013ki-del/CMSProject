# Samsung Custom App Draft

이 폴더는 삼성 사이니지 `Custom App` 배포용 초안입니다.

목적:
- 전원 켜기 후 일반 웹 브라우저 대신 CMS 플레이어를 바로 실행
- 브라우저 기본 홈(`samsung.com`) 의존 제거
- USB 또는 URL 기반 배포를 위한 최소 파일 구조 제공

포함 파일:
- `config.xml`: Tizen Web App 기본 설정
- `index.html`: 앱 진입점
- `app.js`: `/client` 로드 및 재시도
- `styles.css`: 기본 전체화면 스타일
- `sssp_config.xml.example`: USB/URL 배포용 예시 파일

기본 대상 주소:
- `http://12.23.67.245:8080/client`

참고:
- 실제 `.wgt` 빌드와 서명은 Tizen Studio 또는 Tizen CLI 환경이 필요
- 운영 장비 배포 시 삼성 Signage 인증서 정책 검토가 필요할 수 있음
