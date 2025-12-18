// 프로젝트 목록 페이지 기능 관리
import './style.css';
import { auth, db } from './firebaseConfig.js';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { collection, query, where, getDocs, addDoc, orderBy, serverTimestamp, deleteDoc, updateDoc, doc } from 'firebase/firestore';

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
        ${projects.map(project => {
          const projectColor = project.color || '#667eea';
          const projectIcon = project.icon || '📊';
          const projectStatus = getProjectStatus(project);
          return `
          <div class="project-card" data-project-id="${project.id}" style="--project-color: ${projectColor}">
            <div class="project-card-content">
              <div class="project-card-header">
                <div class="project-card-actions">
                  <button class="project-action-btn edit-btn" data-project-id="${project.id}" title="이름 변경">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                    </svg>
                  </button>
                  <button class="project-action-btn delete-btn" data-project-id="${project.id}" title="삭제">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="3 6 5 6 21 6"></polyline>
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                  </button>
                </div>
                ${project.isFavorite ? '<span class="favorite-icon">★</span>' : ''}
              </div>
              <div class="project-card-icon" style="background: ${projectColor}20; color: ${projectColor}">
                <span class="project-icon-emoji">${projectIcon}</span>
              </div>
              <div class="project-card-body">
                <h3 class="project-title" data-project-id="${project.id}">${escapeHtml(project.name)}</h3>
                <div class="project-status">
                  <span class="project-status-badge status-${projectStatus.level}">
                    ${projectStatus.text}
                  </span>
                </div>
                <p class="project-date">${formatDate(project.createdAt)}</p>
              </div>
            </div>
          </div>
        `;
        }).join('')}
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
            <div class="form-group">
              <label>아이콘 선택</label>
              <div class="icon-selector">
                ${['📊', '📈', '🔬', '💡', '🎯', '🚀', '📝', '🔍', '⚡', '🎨'].map(icon => `
                  <button type="button" class="icon-option ${icon === '📊' ? 'selected' : ''}" data-icon="${icon}">
                    ${icon}
                  </button>
                `).join('')}
              </div>
            </div>
            <div class="form-group">
              <label>색상 선택</label>
              <div class="color-selector">
                ${[
                  { name: '보라색', value: '#667eea' },
                  { name: '파란색', value: '#4285f4' },
                  { name: '초록색', value: '#34a853' },
                  { name: '주황색', value: '#ff9800' },
                  { name: '빨간색', value: '#ea4335' },
                  { name: '핑크색', value: '#e91e63' },
                  { name: '청록색', value: '#00bcd4' },
                  { name: '갈색', value: '#795548' }
                ].map((color, index) => `
                  <button type="button" class="color-option ${index === 0 ? 'selected' : ''}" 
                    data-color="${color.value}" 
                    style="background: ${color.value}"
                    title="${color.name}">
                  </button>
                `).join('')}
              </div>
            </div>
            <div class="form-actions">
              <button type="button" class="btn-secondary" id="cancelBtn">취소</button>
              <button type="submit" class="btn-primary">생성</button>
            </div>
          </form>
        </div>
      </div>
    </div>

    <!-- 프로젝트 이름 변경 모달 -->
    <div id="editProjectModal" class="modal">
      <div class="modal-content">
        <div class="modal-header">
          <h2>프로젝트 이름 변경</h2>
          <button class="modal-close" id="closeEditModal">&times;</button>
        </div>
        <div class="modal-body">
          <form id="editProjectForm">
            <div class="form-group">
              <label for="editProjectName">프로젝트 이름</label>
              <input 
                type="text" 
                id="editProjectName" 
                name="editProjectName" 
                placeholder="프로젝트 이름을 입력하세요" 
                required
                autofocus
              />
            </div>
            <div class="form-actions">
              <button type="button" class="btn-secondary" id="cancelEditBtn">취소</button>
              <button type="submit" class="btn-primary">저장</button>
            </div>
          </form>
        </div>
      </div>
    </div>

    <!-- 삭제 확인 모달 -->
    <div id="deleteProjectModal" class="modal">
      <div class="modal-content">
        <div class="modal-header">
          <h2>프로젝트 삭제</h2>
          <button class="modal-close" id="closeDeleteModal">&times;</button>
        </div>
        <div class="modal-body">
          <p>정말로 이 프로젝트를 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.</p>
          <div class="form-actions">
            <button type="button" class="btn-secondary" id="cancelDeleteBtn">취소</button>
            <button type="button" class="btn-danger" id="confirmDeleteBtn">삭제</button>
          </div>
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

  // 아이콘 선택
  const iconOptions = document.querySelectorAll('.icon-option');
  iconOptions.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      iconOptions.forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
  });

  // 색상 선택
  const colorOptions = document.querySelectorAll('.color-option');
  colorOptions.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      colorOptions.forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
  });

  // 프로젝트 카드 클릭 (액션 버튼 제외)
  const projectCards = document.querySelectorAll('.project-card:not(.new-project-card)');
  projectCards.forEach(card => {
    card.addEventListener('click', (e) => {
      // 액션 버튼이나 입력 필드 클릭 시에는 카드 클릭 이벤트 무시
      if (e.target.closest('.project-card-actions') || e.target.closest('.project-title-input')) {
        return;
      }
      const projectId = card.getAttribute('data-project-id');
      if (projectId) {
        window.location.href = `editor.html?projectId=${projectId}`;
      }
    });
  });

  // 프로젝트 이름 변경 버튼
  const editButtons = document.querySelectorAll('.edit-btn');
  editButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const projectId = btn.getAttribute('data-project-id');
      if (projectId) {
        handleEditProject(projectId);
      }
    });
  });

  // 프로젝트 삭제 버튼
  const deleteButtons = document.querySelectorAll('.delete-btn');
  deleteButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const projectId = btn.getAttribute('data-project-id');
      if (projectId) {
        handleDeleteProject(projectId);
      }
    });
  });

  // 이름 변경 모달 이벤트
  const editModal = document.getElementById('editProjectModal');
  const closeEditModal = document.getElementById('closeEditModal');
  const cancelEditBtn = document.getElementById('cancelEditBtn');
  const editProjectForm = document.getElementById('editProjectForm');

  if (closeEditModal) {
    closeEditModal.addEventListener('click', () => {
      if (editModal) editModal.style.display = 'none';
    });
  }

  if (cancelEditBtn) {
    cancelEditBtn.addEventListener('click', () => {
      if (editModal) editModal.style.display = 'none';
    });
  }

  if (editModal) {
    editModal.addEventListener('click', (e) => {
      if (e.target === editModal) {
        editModal.style.display = 'none';
      }
    });
  }

  if (editProjectForm) {
    editProjectForm.addEventListener('submit', handleUpdateProject);
  }

  // 삭제 확인 모달 이벤트
  const deleteModal = document.getElementById('deleteProjectModal');
  const closeDeleteModal = document.getElementById('closeDeleteModal');
  const cancelDeleteBtn = document.getElementById('cancelDeleteBtn');
  const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');

  if (closeDeleteModal) {
    closeDeleteModal.addEventListener('click', () => {
      if (deleteModal) deleteModal.style.display = 'none';
    });
  }

  if (cancelDeleteBtn) {
    cancelDeleteBtn.addEventListener('click', () => {
      if (deleteModal) deleteModal.style.display = 'none';
    });
  }

  if (deleteModal) {
    deleteModal.addEventListener('click', (e) => {
      if (e.target === deleteModal) {
        deleteModal.style.display = 'none';
      }
    });
  }

  if (confirmDeleteBtn) {
    confirmDeleteBtn.addEventListener('click', handleConfirmDelete);
  }

  // 로그아웃 버튼
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', handleLogout);
  }
}

let currentEditProjectId = null;
let currentDeleteProjectId = null;

// 프로젝트 이름 변경
function handleEditProject(projectId) {
  currentEditProjectId = projectId;
  const projectCard = document.querySelector(`[data-project-id="${projectId}"]`);
  const projectTitle = projectCard?.querySelector('.project-title');
  const currentName = projectTitle?.textContent || '';

  const editModal = document.getElementById('editProjectModal');
  const editProjectNameInput = document.getElementById('editProjectName');
  
  if (editModal && editProjectNameInput) {
    editProjectNameInput.value = currentName;
    editModal.style.display = 'flex';
    editProjectNameInput.focus();
    editProjectNameInput.select();
  }
}

// 프로젝트 이름 업데이트
async function handleUpdateProject(e) {
  e.preventDefault();
  
  if (!currentEditProjectId || !currentUser) {
    return;
  }

  const editProjectNameInput = document.getElementById('editProjectName');
  const newName = editProjectNameInput?.value.trim();
  
  if (!newName) {
    return;
  }

  const submitBtn = e.target.querySelector('button[type="submit"]');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = '저장 중...';
  }

  try {
    const projectRef = doc(db, 'projects', currentEditProjectId);
    await updateDoc(projectRef, {
      name: newName,
      updatedAt: serverTimestamp()
    });

    const editModal = document.getElementById('editProjectModal');
    if (editModal) {
      editModal.style.display = 'none';
    }

    // 프로젝트 목록 새로고침
    await loadProjects();

  } catch (error) {
    console.error('프로젝트 이름 변경 오류:', error);
    alert(`프로젝트 이름 변경 실패: ${error.message}`);
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = '저장';
    }
    currentEditProjectId = null;
  }
}

// 프로젝트 삭제 확인
function handleDeleteProject(projectId) {
  currentDeleteProjectId = projectId;
  const deleteModal = document.getElementById('deleteProjectModal');
  if (deleteModal) {
    deleteModal.style.display = 'flex';
  }
}

// 프로젝트 삭제 확인 처리
async function handleConfirmDelete() {
  if (!currentDeleteProjectId || !currentUser) {
    return;
  }

  const confirmBtn = document.getElementById('confirmDeleteBtn');
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = '삭제 중...';
  }

  try {
    const projectRef = doc(db, 'projects', currentDeleteProjectId);
    await deleteDoc(projectRef);

    const deleteModal = document.getElementById('deleteProjectModal');
    if (deleteModal) {
      deleteModal.style.display = 'none';
    }

    // 프로젝트 목록 새로고침
    await loadProjects();

  } catch (error) {
    console.error('프로젝트 삭제 오류:', error);
    alert(`프로젝트 삭제 실패: ${error.message}`);
  } finally {
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = '삭제';
    }
    currentDeleteProjectId = null;
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

  // 선택된 아이콘과 색상 가져오기
  const selectedIcon = document.querySelector('.icon-option.selected')?.getAttribute('data-icon') || '📊';
  const selectedColor = document.querySelector('.color-option.selected')?.getAttribute('data-color') || '#667eea';

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
      icon: selectedIcon,
      color: selectedColor,
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
    // 선택 초기화
    document.querySelectorAll('.icon-option, .color-option').forEach(btn => {
      btn.classList.remove('selected');
    });
    document.querySelector('.icon-option[data-icon="📊"]')?.classList.add('selected');
    document.querySelector('.color-option[data-color="#667eea"]')?.classList.add('selected');
  }
}

// 프로젝트 상태 계산
function getProjectStatus(project) {
  const nocodeState = project.nocodeState;
  
  if (!nocodeState || !nocodeState.data) {
    return { level: 'empty', text: '시작 전' };
  }
  
  const hasData = nocodeState.data && nocodeState.columns;
  const hasPreprocessing = nocodeState.operationHistory && nocodeState.operationHistory.length > 0;
  const hasVisualization = nocodeState.chartConfigs && nocodeState.chartConfigs.length > 0;
  
  if (hasVisualization) {
    return { level: 'complete', text: '시각화 완료' };
  } else if (hasPreprocessing) {
    return { level: 'processing', text: '전처리 완료' };
  } else if (hasData) {
    return { level: 'loaded', text: '데이터 로드됨' };
  }
  
  return { level: 'empty', text: '시작 전' };
}

// 프로젝트 목록 불러오기
async function loadProjects() {
  if (!currentUser) {
    return;
  }

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
        icon: data.icon || '📊',
        color: data.color || '#667eea',
        nocodeState: data.nocodeState || null,
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
try {
  const unsubscribe = onAuthStateChanged(auth, (user) => {
    try {
      if (!user) {
        // 로그인되지 않은 사용자는 로그인 페이지로 리다이렉트
        window.location.href = 'index.html';
      } else {
        // 로그인된 사용자는 프로젝트 목록 로드
        currentUser = user;
        loadProjects();
      }
    } catch (error) {
      console.error('인증 상태 변경 처리 중 오류:', error);
      const app = document.querySelector('#app');
      const loadingScreen = document.getElementById('loadingScreen');
      if (loadingScreen) {
        loadingScreen.style.display = 'none';
      }
      if (app) {
        app.innerHTML = `
          <div class="error-container">
            <h2>인증 오류가 발생했습니다</h2>
            <p>${error.message}</p>
            <p style="font-size: 12px; color: #666; margin-top: 10px;">
              Firebase 환경 변수가 제대로 설정되었는지 확인해주세요.
            </p>
            <button onclick="location.reload()">새로고침</button>
            <button onclick="window.location.href='index.html'" style="margin-left: 10px;">로그인 페이지로</button>
          </div>
        `;
      }
    }
  });
} catch (error) {
  console.error('onAuthStateChanged 설정 오류:', error);
  const app = document.querySelector('#app');
  const loadingScreen = document.getElementById('loadingScreen');
  if (loadingScreen) {
    loadingScreen.style.display = 'none';
  }
  if (app) {
    app.innerHTML = `
      <div class="error-container">
        <h2>초기화 오류가 발생했습니다</h2>
        <p>${error.message}</p>
        <button onclick="location.reload()">새로고침</button>
      </div>
    `;
  }
}
