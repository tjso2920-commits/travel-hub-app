# Travel Hub · Claude Code 인수인계 v5

사용자 결정: **지금 디자인 그대로 간다.** 이 묶음은 2026-09-09 속도 개선까지 반영한 승인 디자인 코드다. 예전 design_v1 ZIP보다 우선한다.

## 사용자 사용법
1. 이 ZIP을 기존 여행웹 개발을 하던 Claude Code 환경에 제공한다. ZIP 첨부를 지원하지 않으면 PC에서 압축 해제 후 폴더 경로를 알려준다.
2. `01_CLAUDE_PROMPT.txt` 내용을 첫 요청으로 보낸다.
3. 본인의 실제 CSV 또는 Google Takeout의 저장 목록 ZIP을 별도 제공한다. CSV를 수작업으로 만들거나 열 이름을 바꾸지 않는다.
4. 첫 완료 기준: 실제 저장 장소 → 도시별 정리 → 도시 선택 → 승인된 디자인 카드로 표시. 사진·GPS·최단 동선 모두를 한꺼번에 구현하지 않는다.

## 파일
- approved-design/: 승인 화면 원본 HTML/CSS/JS, 사진, 로컬 폰트, 라이선스. 이 폴더를 디자인 기준으로 보존한다.
- 01_CLAUDE_PROMPT.txt: Claude에게 보낼 실행 지시.
- 02_DESIGN_CONTRACT.md: 디자인 보존 규칙 및 파일별 역할.
- 03_INTEGRATION_AND_ACCEPTANCE.md: 실제 기능 연결, 개발 순서, 완료 기준.
- 04_MOBILE_DATA_GUIDE.md: 아이폰에서 실제 저장 목록 준비.
- 05_IMPORT_ONBOARDING_SPEC.md: Takeout 접속부터 다운로드·복귀까지 단계별 화면 문구와 오류 처리(최신 추가 요구).
- PERFORMANCE.json: 측정된 파일 용량. 실회선 속도 결과가 아님.
- SOURCE_VERSION.txt / SHA256SUMS.json / verify_bundle.py: 버전과 코드 무결성 확인.

## 현재 상태
12개 샘플 장소, 3개 샘플 도시. 검색/분류/선택/도시별 목록은 샘플로 동작한다. 가져오기 결과 화면·GPS 안내·프로필은 데모다. 실제 구글 데이터 가져오기, 지점 매칭, 사진 API, GPS, 동선 최적화, 교통 안내, 계정 연동은 이 디자인 패키지에서 구현 완료된 것이 아니다.

브라우저/아이폰 시각 테스트와 느린 회선 실측은 미실시. JS 구문·파일 참조·사진/폰트 유효성 확인, DOM 스텁으로 도시 필터·검색·도시별 선택 격리 확인을 했다. '오류 없음'이나 '완전히 동일하게 통합 완료'로 보고하지 않는다.

## 중요
approved-design/classic.html은 이전 디자인 미리보기의 기존 앱 사본이다. 사용자의 최신 Claude 작업 결과가 아니다. **현재 개발 저장소를 classic.html로 덮어쓰지 않는다.** approved-design/sw.js는 미리보기 전용이며 실제 앱으로 이식하지 않는다. Sites 설정·Git 인증정보·개인 CSV는 이 ZIP에 포함하지 않았다.

최신 정정: 06_UPDATES_AND_EXPORT_CORRECTION.md 필독. Saved-only 안내 보완 및 여행 중 추가/재수입 요구사항 포함. approved-design의 기존 간단 안내 문구보다 이 정정이 우선한다. 디자인 외형은 유지한다.
