// Firebase 설정
import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import { getAnalytics } from 'firebase/analytics';

// 환경변수에서 Firebase 구성 정보 가져오기
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID
};

// 환경 변수 검증
const requiredEnvVars = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_STORAGE_BUCKET',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FIREBASE_APP_ID'
];

const missingVars = requiredEnvVars.filter(
  varName => !import.meta.env[varName]
);

if (missingVars.length > 0) {
  const errorMessage = `Firebase 환경 변수가 설정되지 않았습니다: ${missingVars.join(', ')}\n\nNetlify 대시보드에서 환경 변수를 설정해주세요.`;
  console.error('❌ Firebase 설정 오류:', errorMessage);
  console.error('누락된 환경 변수:', missingVars);
  console.error('현재 firebaseConfig:', firebaseConfig);
  
  // 프로덕션에서도 화면에 오류 표시
  if (typeof window !== 'undefined') {
    const app = document.querySelector('#app');
    if (app) {
      app.innerHTML = `
        <div style="padding: 40px; text-align: center; color: #fff;">
          <h2 style="color: #ff6b6b; margin-bottom: 20px;">⚠️ Firebase 설정 오류</h2>
          <p style="margin-bottom: 10px;">다음 환경 변수가 설정되지 않았습니다:</p>
          <ul style="list-style: none; padding: 0; margin: 20px 0;">
            ${missingVars.map(v => `<li style="margin: 5px 0;">• ${v}</li>`).join('')}
          </ul>
          <p style="margin-top: 20px; font-size: 14px; color: #ccc;">
            Netlify 대시보드 → Site settings → Environment variables에서 설정해주세요.
          </p>
        </div>
      `;
    }
  }
  
  // 개발 환경에서는 오류를 던짐
  if (import.meta.env.DEV) {
    throw new Error(errorMessage);
  }
}

// Firebase 초기화
let app, auth, db, storage;
try {
  console.log('Firebase 초기화 시작...');
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  storage = getStorage(app);
  console.log('✅ Firebase 초기화 완료');
} catch (error) {
  console.error('❌ Firebase 초기화 실패:', error);
  if (typeof window !== 'undefined') {
    const appElement = document.querySelector('#app');
    if (appElement) {
      appElement.innerHTML = `
        <div style="padding: 40px; text-align: center; color: #fff;">
          <h2 style="color: #ff6b6b; margin-bottom: 20px;">⚠️ Firebase 초기화 실패</h2>
          <p style="margin-bottom: 10px;">${error.message}</p>
          <button onclick="location.reload()" style="margin-top: 20px; padding: 10px 20px; background: #667eea; color: white; border: none; border-radius: 5px; cursor: pointer;">새로고침</button>
        </div>
      `;
    }
  }
  throw error;
}
const googleProvider = new GoogleAuthProvider();

// Google 로그인 설정 - 쿠키 문제 해결
googleProvider.setCustomParameters({
  prompt: 'select_account'
});

// Analytics는 브라우저 환경에서만 초기화
let analytics = null;
if (typeof window !== 'undefined') {
  analytics = getAnalytics(app);
}

export { auth, db, storage, googleProvider, analytics };
