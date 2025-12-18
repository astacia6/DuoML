// 로그인 페이지 기능 관리
import './style.css';
import { auth, googleProvider } from './firebaseConfig.js';
import { signInWithPopup, onAuthStateChanged } from 'firebase/auth';

// 로그인 페이지 HTML 렌더링
function renderLoginPage() {
  const app = document.querySelector('#app');
  app.innerHTML = `
    <div class="login-container">
      <div class="login-header">
        <h1>DuoML</h1>
        <p class="subtitle">
          <span class="highlight">노코드</span>와 <span class="highlight">코드</span>를 모두 지원하는<br>
          데이터 분석·머신러닝 플랫폼
        </p>
      </div>

      <button id="googleLoginBtn" class="login-button">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
        </svg>
        Google로 로그인
      </button>

      <p id="loadingText" class="loading-text">로그인 중입니다...</p>
      <p id="errorMessage" class="error-message"></p>

      <div class="features">
        <h3>주요 기능</h3>
        <ul>
          <li>직관적인 노코드 ML 에디터</li>
          <li>Python 코드 기반 에디터</li>
          <li>데이터 전처리 및 시각화</li>
          <li>회귀/분류 모델 학습</li>
          <li>AI 챗봇 지원</li>
        </ul>
      </div>
    </div>
  `;

  // 로그인 버튼 이벤트 리스너
  const loginButton = document.getElementById('googleLoginBtn');
  if (loginButton) {
    loginButton.addEventListener('click', handleGoogleLogin);
  }
}

// Google 로그인 처리
async function handleGoogleLogin() {
  try {
    const loginButton = document.getElementById('googleLoginBtn');
    const loadingText = document.getElementById('loadingText');
    const errorMessage = document.getElementById('errorMessage');
    
    // 로딩 상태 표시
    if (loginButton) {
      loginButton.disabled = true;
      loginButton.textContent = '로그인 중...';
    }
    if (loadingText) {
      loadingText.style.display = 'block';
    }
    if (errorMessage) {
      errorMessage.style.display = 'none';
    }

    // Google 로그인 팝업 실행
    const result = await signInWithPopup(auth, googleProvider);
    const user = result.user;

    console.log('로그인 성공:', user.email);
    
    // 로그인 성공 시 프로젝트 목록 페이지로 이동
    window.location.href = 'projectList.html';
    
  } catch (error) {
    console.error('로그인 오류:', error);
    
    // 에러 메시지 표시
    const errorMessage = document.getElementById('errorMessage');
    if (errorMessage) {
      let errorText = `로그인 실패: ${error.message}`;
      
      // 쿠키/도메인 관련 오류인 경우 안내 메시지 추가
      if (error.code === 'auth/unauthorized-domain' || error.message.includes('domain')) {
        errorText += '\n\nFirebase Console에서 Netlify 도메인을 인증된 도메인으로 추가해주세요.';
      }
      
      errorMessage.textContent = errorText;
      errorMessage.style.display = 'block';
    }
    
    // 버튼 상태 복원
    const loginButton = document.getElementById('googleLoginBtn');
    const loadingText = document.getElementById('loadingText');
    if (loginButton) {
      loginButton.disabled = false;
      loginButton.innerHTML = `
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
        </svg>
        Google로 로그인
      `;
    }
    if (loadingText) {
      loadingText.style.display = 'none';
    }
  }
}

// 인증 상태 확인 - 이미 로그인되어 있으면 프로젝트 목록으로 이동
onAuthStateChanged(auth, (user) => {
  if (user) {
    // 로그인된 사용자는 프로젝트 목록으로 리다이렉트
    window.location.href = 'projectList.html';
  } else {
    // 로그인되지 않은 사용자는 로그인 페이지 표시
    renderLoginPage();
  }
});
