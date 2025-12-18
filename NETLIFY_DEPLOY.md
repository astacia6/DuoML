# Netlify 배포 가이드

## 환경 변수 설정

Netlify 대시보드에서 다음 환경 변수들을 설정해야 합니다:

### Firebase 환경 변수 (필수)

1. Netlify 대시보드 접속
2. Site settings → Environment variables 이동
3. 다음 변수들을 추가:

```
VITE_FIREBASE_API_KEY=your-firebase-api-key
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project-id
VITE_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=your-messaging-sender-id
VITE_FIREBASE_APP_ID=your-app-id
VITE_FIREBASE_MEASUREMENT_ID=your-measurement-id (선택)
```

### OpenAI 환경 변수 (필수)

```
OPENAI_API_KEY=your-openai-api-key
OPENAI_MODEL=gpt-4.1-mini (선택, 기본값: gpt-4.1-mini)
```

## Firebase 설정 값 찾는 방법

1. [Firebase Console](https://console.firebase.google.com/) 접속
2. 프로젝트 선택
3. 프로젝트 설정 (⚙️ 아이콘) 클릭
4. "일반" 탭에서 "내 앱" 섹션의 웹 앱 설정 확인
5. `firebaseConfig` 객체에서 필요한 값들을 복사

## 배포 후 확인

1. 환경 변수 설정 후 **새로 빌드** 필요 (자동 재배포 또는 수동 재배포)
2. 브라우저 콘솔에서 Firebase 오류가 사라졌는지 확인
3. 로그인 기능이 정상 작동하는지 확인

## 주의사항

- 환경 변수는 빌드 시점에 번들에 포함되므로, 변경 후 반드시 재배포가 필요합니다
- `VITE_` 접두사가 붙은 변수만 클라이언트 번들에 포함됩니다
- 민감한 정보는 절대 코드에 하드코딩하지 마세요

