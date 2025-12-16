// 프로젝트 목록 페이지 기능 관리
import './style.css';
import { auth, db } from './firebaseConfig.js';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { collection, query, where, getDocs, addDoc, orderBy, serverTimestamp } from 'firebase/firestore';

let currentUser = null;

// 프로젝트 목록 페이지 HTML 렌더링
function renderProjectList(projects) {
  const app = document.querySelector('#app');
  const loadingScreen = document.getElementById('loadingScreen');
  
  if (loadingScreen) {
    loadingScreen.style.display = 'none';
  }

  app.innerHTML = `
    <div class="project-list-container">
      <header class="project-list-header">
        <h1>프로젝트</h1>
        <div class="header-actions">
          <button id="logoutBtn" class="icon-button" title="로그아웃">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
              <polyline points="16 17 21 12 16 7"></polyline>
              <line x1="21" y1="12" x2="9" y2="12"></line>
            </svg>
          </button>
        </div>
      </header>

      <div class="projects-grid">
        <!-- 신규 프로젝트 생성 카드 -->
        <div class="project-card new-project-card" id="newProjectCard">
          <div class="project-card-content">
            <div class="new-project-icon">+</div>
            <div class="new-project-label">신규 프로젝트</div>
          </div>
        </div>

        <!-- 기존 프로젝트 카드들 -->
        ${projects.map(project => `
          <div class="project-card" data-project-id="${project.id}">
            <div class="project-card-content">
              <div class="project-card-header">
                ${project.isFavorite ? '<span class="favorite-icon">★</span>' : ''}
              </div>
              <div class="project-card-body">
                <h3 class="project-title">${escapeHtml(project.name)}</h3>
                <p class="project-date">${formatDate(project.createdAt)}</p>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- 신규 프로젝트 생성 모달 -->
    <div id="newProjectModal" class="modal">
      <div class="modal-content">
        <div class="modal-header">
          <h2>새 프로젝트 생성</h2>
          <button class="modal-close" id="closeModal">&times;</button>
        </div>
        <div class="modal-body">
          <form id="newProjectForm">
            <div class="form-group">
              <label for="projectName">프로젝트 이름</label>
              <input 
                type="text" 
                id="projectName" 
                name="projectName" 
                placeholder="프로젝트 이름을 입력하세요" 
                required
                autofocus
              />
            </div>
            <div class="form-actions">
              <button type="button" class="btn-secondary" id="cancelBtn">취소</button>
              <button type="submit" class="btn-primary">생성</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  `;

  // 이벤트 리스너 설정
  setupEventListeners();
}

// 이벤트 리스너 설정
function setupEventListeners() {
  // 신규 프로젝트 카드 클릭
  const newProjectCard = document.getElementById('newProjectCard');
  if (newProjectCard) {
    newProjectCard.addEventListener('click', () => {
      const modal = document.getElementById('newProjectModal');
      if (modal) {
        modal.style.display = 'flex';
        document.getElementById('projectName')?.focus();
      }
    });
  }

  // 모달 닫기
  const closeModal = document.getElementById('closeModal');
  const cancelBtn = document.getElementById('cancelBtn');
  const modal = document.getElementById('newProjectModal');
  
  if (closeModal) {
    closeModal.addEventListener('click', () => {
      if (modal) modal.style.display = 'none';
    });
  }
  
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      if (modal) modal.style.display = 'none';
    });
  }

  // 모달 외부 클릭 시 닫기
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.style.display = 'none';
      }
    });
  }

  // 신규 프로젝트 폼 제출
  const newProjectForm = document.getElementById('newProjectForm');
  if (newProjectForm) {
    newProjectForm.addEventListener('submit', handleCreateProject);
  }

  // 프로젝트 카드 클릭
  const projectCards = document.querySelectorAll('.project-card:not(.new-project-card)');
  projectCards.forEach(card => {
    card.addEventListener('click', () => {
      const projectId = card.getAttribute('data-project-id');
      if (projectId) {
        // 프로젝트 상세 페이지로 이동 (추후 구현)
        window.location.href = `editor.html?projectId=${projectId}`;
      }
    });
  });

  // 로그아웃 버튼
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', handleLogout);
  }
}

// 신규 프로젝트 생성
async function handleCreateProject(e) {
  e.preventDefault();
  
  const projectNameInput = document.getElementById('projectName');
  const projectName = projectNameInput?.value.trim();
  
  if (!projectName || !currentUser) {
    return;
  }

  const submitBtn = e.target.querySelector('button[type="submit"]');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = '생성 중...';
  }

  try {
    // Firestore에 프로젝트 추가
    const projectData = {
      name: projectName,
      userId: currentUser.uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      isFavorite: false,
      settings: {
        mode: 'nocode' // 기본값: 노코드 모드
      }
    };

    const docRef = await addDoc(collection(db, 'projects'), projectData);
    console.log('프로젝트 생성 성공:', docRef.id);

    // 모달 닫기
    const modal = document.getElementById('newProjectModal');
    if (modal) {
      modal.style.display = 'none';
    }

    // 프로젝트 목록 새로고침
    await loadProjects();

  } catch (error) {
    console.error('프로젝트 생성 오류:', error);
    alert(`프로젝트 생성 실패: ${error.message}`);
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = '생성';
    }
    if (projectNameInput) {
      projectNameInput.value = '';
    }
  }
}

// 프로젝트 목록 불러오기
async function loadProjects() {
  if (!currentUser) return;

  try {
    const loadingScreen = document.getElementById('loadingScreen');
    if (loadingScreen) {
      loadingScreen.style.display = 'flex';
    }

    // 현재 사용자의 프로젝트만 조회 (인덱스 없이 작동하도록 orderBy 제거)
    const q = query(
      collection(db, 'projects'),
      where('userId', '==', currentUser.uid)
    );

    const querySnapshot = await getDocs(q);
    const projects = [];

    querySnapshot.forEach((doc) => {
      const data = doc.data();
      projects.push({
        id: doc.id,
        name: data.name || '이름 없음',
        createdAt: data.createdAt?.toDate() || new Date(),
        isFavorite: data.isFavorite || false,
        ...data
      });
    });

    // 클라이언트 측에서 생성일 기준 내림차순 정렬
    projects.sort((a, b) => {
      const dateA = a.createdAt instanceof Date ? a.createdAt : new Date(a.createdAt);
      const dateB = b.createdAt instanceof Date ? b.createdAt : new Date(b.createdAt);
      return dateB - dateA; // 최신순
    });

    renderProjectList(projects);

  } catch (error) {
    console.error('프로젝트 목록 불러오기 오류:', error);
    
    const app = document.querySelector('#app');
    const loadingScreen = document.getElementById('loadingScreen');
    if (loadingScreen) {
      loadingScreen.style.display = 'none';
    }
    
    if (app) {
      app.innerHTML = `
        <div class="error-container">
          <h2>오류가 발생했습니다</h2>
          <p>${error.message}</p>
          <button onclick="location.reload()">새로고침</button>
        </div>
      `;
    }
  }
}

// 로그아웃 처리
async function handleLogout() {
  try {
    await signOut(auth);
    window.location.href = 'index.html';
  } catch (error) {
    console.error('로그아웃 오류:', error);
    alert(`로그아웃 실패: ${error.message}`);
  }
}

// 날짜 포맷팅
function formatDate(date) {
  if (!date) return '';
  
  const d = date instanceof Date ? date : date.toDate();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? '오후' : '오전';
  const displayHours = hours % 12 || 12;

  return `${year}. ${month}. ${day}. ${ampm} ${displayHours}:${minutes}`;
}

// HTML 이스케이프
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// 인증 상태 확인 및 프로젝트 목록 로드
onAuthStateChanged(auth, (user) => {
  if (!user) {
    // 로그인되지 않은 사용자는 로그인 페이지로 리다이렉트
    window.location.href = 'index.html';
  } else {
    // 로그인된 사용자는 프로젝트 목록 로드
    currentUser = user;
    loadProjects();
  }
});
