
// 에디터 페이지 기능 관리
import './style.css';
import { auth, db } from './firebaseConfig.js';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc, runTransaction, serverTimestamp, updateDoc, arrayUnion } from 'firebase/firestore';

let currentUser = null;
let currentProjectId = null;
let currentMode = 'nocode'; // 'nocode' or 'code'
let chatbotOpen = true; // 챗봇 패널 열림 상태
let currentCredits = null; // 남은 크레딧 (null이면 아직 불러오지 않음)
let pyodideInstance = null; // 브라우저 파이썬 실행용
let lastSavedState = null; // 마지막 저장된 상태 (변경사항 추적용)
window.pyodideDataPath = window.pyodideDataPath || null;
window.currentData = window.currentData || null;
window.currentColumns = window.currentColumns || null;
window.originalFileName = window.originalFileName || null;
window.operationHistory = window.operationHistory || [];
window.generatedCodeCells = window.generatedCodeCells || [];
window.chartConfigs = window.chartConfigs || [];
window.selectedFeatures = window.selectedFeatures || [];
window.featureExtractionState = window.featureExtractionState || { pairplotGenerated: false, heatmapGenerated: false };
window.modelConfig = window.modelConfig || null;

// Pyodide 초기화
async function getPyodideInstance() {
  if (pyodideInstance) return pyodideInstance;

  if (typeof window.loadPyodide !== 'function') {
    throw new Error('Pyodide 스크립트를 불러오지 못했습니다.');
  }

  pyodideInstance = await window.loadPyodide({
    indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.25.1/full/',
  });

  // 데이터 분석용 기본 패키지 미리 로드 (pandas, matplotlib 등)
  try {
    await pyodideInstance.loadPackage(['pandas', 'matplotlib']);
  } catch (e) {
    console.warn('Pyodide 패키지 로드 중 경고:', e);
  }

  return pyodideInstance;
}

// 한글 폰트를 Pyodide 파일 시스템에 다운로드
async function syncFontToPyodide() {
  const pyodide = await getPyodideInstance();
  const fontPath = '/data/NanumGothic-Regular.ttf';

  // 이미 있으면 스킵
  try {
    if (pyodide.FS.analyzePath(fontPath).exists) {
      console.log('한글 폰트가 이미 존재합니다.');
      return true;
    }
  } catch (e) {
    // 파일이 없으면 계속 진행
  }

  // /data 디렉토리 보장
  try {
    pyodide.FS.mkdir('/data');
  } catch (e) {
    // 이미 있으면 무시
  }

  // Vite: public 폴더는 루트(/)에서 서빙됨
  const fontUrl = '/fonts/NanumGothic-Regular.ttf';

  try {
    console.log('폰트 다운로드 시도:', fontUrl);
    const response = await fetch(fontUrl);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const fontArrayBuffer = await response.arrayBuffer();
    console.log('폰트 파일 크기:', fontArrayBuffer.byteLength, 'bytes');

    if (fontArrayBuffer.byteLength < 10000) {
      throw new Error('폰트 파일이 너무 작습니다');
    }

    const fontUint8Array = new Uint8Array(fontArrayBuffer);
    pyodide.FS.writeFile(fontPath, fontUint8Array);
    console.log('✅ 한글 폰트 로드 완료');
    return true;
  } catch (e) {
    console.error('❌ 폰트 로드 실패:', e.message);
    console.error('public/fonts/NanumGothic-Regular.ttf 파일이 있는지 확인하세요.');
    return false;
  }
}

// 현재 JS 데이터(window.currentData, currentColumns)를 Pyodide 가상 파일로 동기화
async function syncDataToPyodide() {
  if (!window.currentData || !window.currentColumns) return;

  const pyodide = await getPyodideInstance();

  // CSV 문자열로 직렬화
  const cols = window.currentColumns;
  const escapeCsv = (val) => {
    if (val === null || val === undefined) return '';
    const s = String(val);
    if (s.includes('"') || s.includes(',') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const lines = [];
  lines.push(cols.map(escapeCsv).join(','));
  window.currentData.forEach((row) => {
    const values = cols.map((col) => escapeCsv(row[col]));
    lines.push(values.join(','));
  });
  const csvText = lines.join('\n');

  // /data 디렉토리 보장
  try {
    pyodide.FS.mkdir('/data');
  } catch (e) {
    // 이미 있으면 무시
  }

  const filename = window.originalFileName || 'data.csv';
  const virtualPath = `/data/${filename}`;
  pyodide.FS.writeFile(virtualPath, csvText);
  window.pyodideDataPath = virtualPath;

  // 한글 폰트도 함께 동기화
  await syncFontToPyodide();
}

// 주피터처럼 마지막 표현식 자동 출력 처리
function prepareCodeForExecution(rawCode) {
  if (!rawCode) return '';

  const lines = rawCode.split('\n');
  let lastIdx = lines.length - 1;

  // 끝에서부터 비어있는 줄은 스킵
  while (lastIdx >= 0 && lines[lastIdx].trim() === '') {
    lastIdx--;
  }

  if (lastIdx < 0) return rawCode;

  const lastLine = lines[lastIdx];
  const trimmed = lastLine.trim();

  // 주석이거나 이미 print(...)인 경우는 그대로 둠
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('print(')) {
    return rawCode;
  }

  // 대입문(df = ...)처럼 '=' 이 포함된 경우는 표현식이 아니라 문장으로 보고 건드리지 않음
  if (
    trimmed.includes('=') &&
    !trimmed.includes('==') &&
    !trimmed.includes('!=') &&
    !trimmed.includes('<=') &&
    !trimmed.includes('>=')
  ) {
    return rawCode;
  }

  // 제어문/함수정의 등은 건드리지 않음 (간단한 휴리스틱)
  const keywordPrefix = [
    'if ',
    'for ',
    'while ',
    'def ',
    'class ',
    'with ',
    'try:',
    'except ',
    'finally:',
    'elif ',
    'else:',
    'return ',
    'import ',
    'from ',
  ];
  if (keywordPrefix.some((kw) => trimmed.startsWith(kw))) {
    return rawCode;
  }

  // 마지막 줄을 print(마지막식) 으로 감싸기
  const indentMatch = lastLine.match(/^\s*/);
  const indent = indentMatch ? indentMatch[0] : '';
  lines[lastIdx] = `${indent}print(${trimmed})`;

  return lines.join('\n');
}

// URL에서 projectId 가져오기
function getProjectIdFromURL() {
  const params = new URLSearchParams(window.location.search);
  return params.get('projectId');
}

// 에디터 페이지 HTML 렌더링
function renderEditorPage(projectData) {
  const app = document.querySelector('#app');
  const loadingScreen = document.getElementById('loadingScreen');
  
  if (loadingScreen) {
    loadingScreen.style.display = 'none';
  }

  app.innerHTML = `
    <div class="editor-container">
      <!-- 에디터 영역 -->
      <div class="editor-panel">
        <!-- 에디터 헤더 -->
        <div class="editor-header">
          <div class="editor-header-left">
            <button class="back-button" id="backButton" title="프로젝트 목록으로">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M19 12H5M12 19l-7-7 7-7"/>
              </svg>
            </button>
            <h2 class="project-title-header">${escapeHtml(projectData?.name || '프로젝트')}</h2>
          </div>
          <div class="mode-header-right">
            <div class="mode-actions">
              <button class="mode-action-button" id="saveProjectBtn">저장</button>
              <button class="mode-action-button mode-action-primary" id="generateCodeBtn">생성</button>
            </div>
            <div class="mode-toggle">
              <button 
                class="mode-button ${currentMode === 'nocode' ? 'active' : ''}" 
                id="nocodeModeBtn"
                data-mode="nocode"
              >
                노코드
              </button>
              <button 
                class="mode-button ${currentMode === 'code' ? 'active' : ''}" 
                id="codeModeBtn"
                data-mode="code"
              >
                코드
              </button>
            </div>
          </div>
        </div>

        <!-- 에디터 콘텐츠 영역 -->
        <div class="editor-content">
          <div id="editorContent">
            ${currentMode === 'nocode' ? renderNoCodeEditor() : renderCodeEditor()}
          </div>
        </div>
      </div>

      <!-- 챗봇 패널 -->
      <div class="chatbot-panel ${chatbotOpen ? 'open' : 'closed'}" id="chatbotPanel">
        <div class="chatbot-header">
          <button class="chatbot-toggle" id="chatbotToggle" title="${chatbotOpen ? '챗봇 닫기' : '챗봇 열기'}">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              ${chatbotOpen 
                ? '<path d="M9 18l6-6-6-6"/>' 
                : '<path d="M15 18l-6-6 6-6"/>'
              }
            </svg>
          </button>
          ${chatbotOpen ? `
            <h3 class="chatbot-title">AI 챗봇</h3>
            <div class="chatbot-header-right">
              <span class="chatbot-emoji" aria-hidden="true">💰</span>
              <span class="chatbot-credits-badge">
                <span id="chatbotCreditsValue">-</span> 크레딧
              </span>
            </div>
          ` : ''}
        </div>
        <div class="chatbot-content" id="chatbotContent" style="display: ${chatbotOpen ? 'flex' : 'none'}; flex-direction: column;">
          <div class="chatbot-messages" id="chatbotMessages">
            <!-- 챗봇 메시지들이 여기에 표시됩니다 -->
          </div>
          <div class="chatbot-input-area">
            <textarea 
              id="chatbotInput" 
              placeholder="메시지를 입력하세요... (Shift+Enter: 줄바꿈, Enter: 전송)"
              class="chatbot-input"
              rows="1"
            ></textarea>
            <button class="chatbot-send-btn" id="chatbotSendBtn">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="22" y1="2" x2="11" y2="13"></line>
                <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  `;

  // 이벤트 리스너 설정
  setupEventListeners();
  // 프로젝트 저장된 상태 복원
  restoreProjectState(projectData);
}

// 노코드 에디터 렌더링
function renderNoCodeEditor() {
  return `
    <div class="no-code-editor">
      <div class="no-code-section">
        <h3 class="section-title">1. 데이터 불러오기</h3>
        
        <div class="upload-area" id="uploadArea">
          <input type="file" id="csvFileInput" accept=".csv,.xlsx" style="display: none;">
          <div class="upload-box" id="uploadBox">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="17 8 12 3 7 8"></polyline>
              <line x1="12" y1="3" x2="12" y2="15"></line>
            </svg>
            <p class="upload-text">CSV 또는 XLSX 파일을 드래그하거나 클릭하여 업로드</p>
            <p class="upload-hint">지원 형식: .csv, .xlsx</p>
          </div>
        </div>

        <div id="dataTableSection" class="data-table-section" style="display: none;">
          <h4 class="table-title">데이터 미리보기</h4>
          <div class="table-container" id="dataTableContainer">
            <!-- 데이터 테이블이 여기에 표시됩니다 -->
          </div>
        </div>

        <div id="dataInfoSection" class="data-info-section" style="display: none;">
          <h4 class="info-title">데이터프레임 정보</h4>
          <div class="info-grid" id="dataInfoGrid">
            <!-- 데이터프레임 정보가 여기에 표시됩니다 -->
          </div>
        </div>
      </div>

      <div class="no-code-section" id="preprocessingSection" style="display: none;">
        <h3 class="section-title">2. 데이터 전처리</h3>
        
        <!-- 결측치 확인 및 해결 -->
        <div class="preprocessing-block">
          <h4 class="block-title">결측치 처리</h4>
          
          <div class="preprocessing-actions">
            <button class="action-button" id="checkMissingBtn">결측치 확인하기</button>
          </div>

          <div id="missingDataSection" class="result-section" style="display: none;">
            <h5 class="result-title">결측치 확인 결과</h5>
            <div id="missingDataInfo" class="result-content"></div>
            <div style="margin-top: 1rem;">
              <button class="action-button" id="resolveMissingBtn" disabled>결측치 해결하기</button>
            </div>
          </div>

          <div id="resolveMissingSection" class="result-section" style="display: none;">
            <h5 class="result-title">결측치 해결 방법</h5>
            <p class="resolve-hint">선택한 속성에 대해 하나의 방법을 선택하세요.</p>
            <div class="resolve-options">
              <label class="option-label">
                <input type="radio" name="missingStrategy" value="drop" checked>
                <span>결측치가 있는 행 삭제</span>
              </label>
              <label class="option-label">
                <input type="radio" name="missingStrategy" value="mean">
                <span>평균값으로 채우기</span>
              </label>
              <label class="option-label">
                <input type="radio" name="missingStrategy" value="median">
                <span>중앙값으로 채우기</span>
              </label>
              <label class="option-label">
                <input type="radio" name="missingStrategy" value="mode">
                <span>최빈값으로 채우기</span>
              </label>
              <label class="option-label">
                <input type="radio" name="missingStrategy" value="forward">
                <span>이전 값으로 채우기 (Forward Fill)</span>
              </label>
            </div>
            <button class="apply-button" id="applyMissingBtn">적용하기</button>
          </div>
        </div>

        <!-- 이상치 확인 및 해결 -->
        <div class="preprocessing-block">
          <h4 class="block-title">이상치 처리</h4>
          
          <div class="preprocessing-actions">
            <button class="action-button" id="checkOutlierBtn">이상치 확인하기</button>
          </div>

          <div id="outlierDataSection" class="result-section" style="display: none;">
            <h5 class="result-title">이상치 확인 결과 (상자 그림)</h5>
            <div id="boxPlotContainer" class="box-plot-container">
              <!-- 각 속성별 상자 그림이 여기에 동적으로 생성됩니다 -->
            </div>
            <div id="outlierDataInfo" class="result-content"></div>
            <div style="margin-top: 1rem;">
              <button class="action-button" id="resolveOutlierBtn" disabled>이상치 해결하기</button>
            </div>
          </div>

          <div id="resolveOutlierSection" class="result-section" style="display: none;">
            <h5 class="result-title">이상치 해결 방법</h5>
            <p class="resolve-hint">선택한 속성에 대해 처리 방법을 선택하세요.</p>
            <div class="resolve-options">
              <label class="option-label">
                <input type="radio" name="outlierAction" value="dropRow" checked>
                <span>행 삭제하기 (이상치가 있는 행 전체 삭제)</span>
              </label>
              <label class="option-label">
                <input type="radio" name="outlierAction" value="dropValue">
                <span>값 삭제하기 (이상치 값만 삭제, 행은 유지)</span>
              </label>
            </div>
            <div class="outlier-detection-method" style="margin-top: 1.5rem;">
              <h6 class="method-title">이상치 감지 방법</h6>
              <div class="resolve-options">
                <label class="option-label">
                  <input type="radio" name="outlierDetection" value="iqr" checked>
                  <span>IQR 방법 (Q1-1.5*IQR ~ Q3+1.5*IQR 범위 외)</span>
                </label>
                <label class="option-label">
                  <input type="radio" name="outlierDetection" value="zscore">
                  <span>Z-score 방법 (|Z| > 3)</span>
                </label>
                <label class="option-label">
                  <input type="radio" name="outlierDetection" value="percentile">
                  <span>백분위수 방법 (1% ~ 99% 범위만 유지)</span>
                </label>
              </div>
            </div>
            <button class="apply-button" id="applyOutlierBtn">적용하기</button>
          </div>
        </div>

        <!-- 정규화 -->
        <div class="preprocessing-block">
          <h4 class="block-title">정규화</h4>
          
          <div class="preprocessing-actions">
            <button class="action-button" id="normalizeBtn">정규화하기</button>
          </div>

          <div id="normalizeSection" class="result-section" style="display: none;">
            <h5 class="result-title">정규화할 속성 선택</h5>
            <div id="normalizeColumnList" class="normalize-column-list">
              <!-- 숫자형 속성 목록이 여기에 동적으로 생성됩니다 -->
            </div>
            <div class="normalize-method-section" style="margin-top: 1.5rem;">
              <h6 class="method-title">정규화 방법</h6>
              <div class="resolve-options">
                <label class="option-label">
                  <input type="radio" name="normalizeMethod" value="minmax" checked>
                  <span>Min-Max 정규화 (0 ~ 1 범위로 스케일링)</span>
                </label>
                <label class="option-label">
                  <input type="radio" name="normalizeMethod" value="zscore">
                  <span>Z-score 정규화 (평균 0, 표준편차 1로 변환)</span>
                </label>
              </div>
            </div>
            <button class="apply-button" id="applyNormalizeBtn">적용하기</button>
          </div>
        </div>

        <!-- 데이터 시각화 -->
        <div class="preprocessing-block">
          <h4 class="block-title">데이터 시각화</h4>
          
          <div id="chartsContainer" class="charts-container">
            <!-- 그래프들이 여기에 동적으로 추가됩니다 -->
            <div class="visualization-actions">
              <button class="action-button" id="addChartBtn">그래프 추가하기</button>
            </div>
          </div>
        </div>
      </div>

      <div class="no-code-section" id="featureExtractionSection" style="display: none;">
        <h3 class="section-title">4. 핵심 속성 추출하기</h3>
        
        <!-- 속성 선택 -->
        <div class="preprocessing-block">
          <h4 class="block-title">속성 선택</h4>
          <p class="block-hint">분석하고 싶은 속성을 선택하세요. (최소 2개 이상 선택)</p>
          <div id="featureSelectionList" class="feature-selection-list">
            <!-- 속성 체크박스가 여기에 동적으로 생성됩니다 -->
          </div>
          <div class="preprocessing-actions" style="margin-top: 1rem;">
            <button class="action-button" id="selectAllFeaturesBtn">전체 선택</button>
            <button class="action-button" id="deselectAllFeaturesBtn">전체 해제</button>
          </div>
        </div>

        <!-- 산점도 (Pairplot) -->
        <div class="preprocessing-block">
          <h4 class="block-title">산점도 (Pairplot)</h4>
          <p class="block-hint">선택한 속성들 간의 관계를 산점도로 확인할 수 있습니다.</p>
          <div class="preprocessing-actions">
            <button class="action-button" id="generatePairplotBtn">산점도 생성하기</button>
          </div>
          <div id="pairplotContainer" class="pairplot-container" style="display: none;">
            <!-- Pairplot이 여기에 동적으로 생성됩니다 -->
          </div>
        </div>

        <!-- 히트맵 -->
        <div class="preprocessing-block">
          <h4 class="block-title">히트맵</h4>
          <p class="block-hint">선택한 속성들 간의 상관관계를 히트맵으로 확인할 수 있습니다.</p>
          <div class="preprocessing-actions">
            <button class="action-button" id="generateHeatmapBtn">히트맵 생성하기</button>
          </div>
          <div id="heatmapContainer" class="heatmap-container" style="display: none;">
            <!-- 히트맵이 여기에 동적으로 생성됩니다 -->
          </div>
        </div>
      </div>

      <div class="no-code-section" id="modelSection" style="display: none;">
        <h3 class="section-title">5. 모델 생성하기</h3>
        
        <!-- 알고리즘 선정 -->
        <div class="preprocessing-block">
          <h4 class="block-title">알고리즘 선정</h4>
          <p class="block-hint">사용할 머신러닝 알고리즘을 선택하세요.</p>
          <div class="algorithm-selection">
            <div class="algorithm-group">
              <h5 class="algorithm-group-title">회귀</h5>
              <label class="algorithm-option">
                <input type="radio" name="algorithm" value="linear_regression">
                <span>선형회귀 (Linear Regression)</span>
              </label>
            </div>
            <div class="algorithm-group">
              <h5 class="algorithm-group-title">분류</h5>
              <label class="algorithm-option">
                <input type="radio" name="algorithm" value="decision_tree">
                <span>결정트리 (Decision Tree)</span>
              </label>
              <label class="algorithm-option">
                <input type="radio" name="algorithm" value="knn">
                <span>kNN (k-Nearest Neighbors)</span>
              </label>
              <label class="algorithm-option">
                <input type="radio" name="algorithm" value="logistic_regression">
                <span>로지스틱회귀 (Logistic Regression)</span>
              </label>
            </div>
            <div class="algorithm-group">
              <h5 class="algorithm-group-title">군집</h5>
              <label class="algorithm-option">
                <input type="radio" name="algorithm" value="kmeans">
                <span>K-means</span>
              </label>
            </div>
          </div>
        </div>

        <!-- 변수 선정 (회귀/분류용) -->
        <div class="preprocessing-block" id="targetVariableBlock" style="display: none;">
          <h4 class="block-title">변수 선정</h4>
          
          <!-- 독립 변수 선택 -->
          <div class="variable-selection-group">
            <h5 class="variable-group-title">독립 변수 (여러 개 선택 가능)</h5>
            <p class="block-hint">예측에 사용할 변수들을 선택하세요.</p>
            <div id="independentVariablesList" class="variable-checkboxes">
              <!-- 독립 변수 체크박스가 여기에 동적으로 생성됩니다 -->
            </div>
            <div class="preprocessing-actions" style="margin-top: 1rem;">
              <button class="action-button" id="selectAllIndependentBtn">전체 선택</button>
              <button class="action-button" id="deselectAllIndependentBtn">전체 해제</button>
            </div>
          </div>

          <!-- 종속 변수 선택 -->
          <div class="variable-selection-group" style="margin-top: 1.5rem;">
            <h5 class="variable-group-title">종속 변수 (하나만 선택)</h5>
            <p class="block-hint">예측하고자 하는 변수를 선택하세요.</p>
            <div class="preprocessing-actions">
              <select id="dependentVariableSelect" class="target-variable-select">
                <option value="">선택하세요</option>
              </select>
            </div>
          </div>
        </div>

        <!-- 훈련/테스트 데이터 분할 -->
        <div class="preprocessing-block" id="trainTestSplitBlock" style="display: none;">
          <h4 class="block-title">훈련 데이터와 테스트 데이터 분할</h4>
          <p class="block-hint">전체 데이터를 훈련 데이터와 테스트 데이터로 나누는 비율을 설정하세요.</p>
          <div class="split-ratio-section">
            <div class="split-ratio-input">
              <label class="split-ratio-label">훈련 데이터 비율:</label>
              <input type="number" id="trainRatioInput" class="ratio-input" min="0.1" max="0.9" step="0.1" value="0.8">
              <span class="ratio-display">80%</span>
            </div>
            <div class="split-ratio-input">
              <label class="split-ratio-label">테스트 데이터 비율:</label>
              <input type="number" id="testRatioInput" class="ratio-input" min="0.1" max="0.9" step="0.1" value="0.2" readonly>
              <span class="ratio-display">20%</span>
            </div>
          </div>
        </div>

        <!-- 하이퍼파라미터 조정 -->
        <div class="preprocessing-block" id="hyperparameterBlock" style="display: none;">
          <h4 class="block-title">하이퍼파라미터 조정</h4>
          <p class="block-hint">알고리즘의 성능을 조정하기 위한 하이퍼파라미터를 설정하세요.</p>
          <div id="hyperparameterControls" class="hyperparameter-controls">
            <!-- 알고리즘별 하이퍼파라미터가 여기에 동적으로 생성됩니다 -->
          </div>
        </div>

        <!-- 모델 학습 -->
        <div class="preprocessing-block" id="trainModelBlock" style="display: none;">
          <div class="preprocessing-actions">
            <button class="action-button" id="trainModelBtn">모델 학습하기</button>
          </div>
          <div id="modelResults" class="model-results" style="display: none;">
            <!-- 모델 학습 결과가 여기에 표시됩니다 -->
          </div>
        </div>
      </div>
    </div>
  `;
}

// 코드 에디터 렌더링
function renderCodeEditor() {
  const cells = Array.isArray(window.generatedCodeCells) ? window.generatedCodeCells : [];

  if (!cells.length) {
    return `
      <div class="code-editor">
        <div class="code-cells">
          <button class="code-cell-add-btn code-cell-add-btn-last" data-insert-after="-1" title="셀 추가">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
            <span>셀 추가</span>
          </button>
        </div>
        <div class="editor-placeholder">
          <h3>코드 에디터</h3>
          <p>Python 코드를 작성하고 실행할 수 있는 Jupyter 스타일 에디터입니다.</p>
          <p class="placeholder-note">위의 "셀 추가" 버튼을 눌러 코드 셀을 추가하거나, 우측 상단의 "코드 생성" 버튼을 눌러 노코드 작업을 코드로 변환해 보세요.</p>
        </div>
      </div>
    `;
  }

  return `
    <div class="code-editor">
      <div class="code-cells">
        ${cells
          .map(
            (code, idx) => `
              <div class="code-cell-wrapper">
                <button class="code-cell-add-btn" data-insert-after="${idx}" title="아래에 셀 추가">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="12" y1="5" x2="12" y2="19"></line>
                    <line x1="5" y1="12" x2="19" y2="12"></line>
                  </svg>
                </button>
                <div class="code-cell" data-cell-index="${idx}">
                  <div class="code-cell-header">
                    <span class="code-cell-label">셀 ${idx + 1}</span>
                    <div class="code-cell-actions">
                      <button class="code-cell-delete-btn" data-cell-index="${idx}" title="셀 삭제">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <polyline points="3 6 5 6 21 6"></polyline>
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                      </button>
                      <button class="code-cell-run-btn" data-cell-index="${idx}">셀 실행</button>
                    </div>
                  </div>
                  <textarea class="code-cell-editor" spellcheck="false" data-cell-index="${idx}">${escapeHtml(
                    code,
                  )}</textarea>
                  <div class="code-cell-output" id="codeCellOutput_${idx}">
                    <span class="code-cell-output-placeholder">아직 실행 전입니다. 셀 실행 버튼을 눌러 코드를 실행해 보세요.</span>
                  </div>
                </div>
              </div>
            `,
          )
          .join('')}
        <button class="code-cell-add-btn code-cell-add-btn-last" data-insert-after="${cells.length - 1}" title="맨 아래에 셀 추가">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          <span>셀 추가</span>
        </button>
      </div>
    </div>
  `;
}

// 코드 셀 추가
function addCodeCell(insertAfterIndex) {
  if (!Array.isArray(window.generatedCodeCells)) {
    window.generatedCodeCells = [];
  }
  
  const newIndex = insertAfterIndex < 0 ? 0 : insertAfterIndex + 1;
  window.generatedCodeCells.splice(newIndex, 0, '');
  
  // 에디터 다시 렌더링
  const editorContent = document.getElementById('editorContent');
  if (editorContent) {
    editorContent.innerHTML = renderCodeEditor();
    setupCodeEditorEvents();
    
    // 새로 추가된 셀에 포커스
    const newTextarea = document.querySelector(
      `.code-cell-editor[data-cell-index="${newIndex}"]`,
    );
    if (newTextarea) {
      setTimeout(() => newTextarea.focus(), 100);
    }
  }
  
  updateSaveButtonColor();
}

// 코드 셀 삭제
function deleteCodeCell(cellIndex) {
  if (!Array.isArray(window.generatedCodeCells)) {
    return;
  }
  
  if (window.generatedCodeCells.length <= 1) {
    alert('최소 하나의 셀은 남겨두어야 합니다.');
    return;
  }
  
  if (confirm(`셀 ${cellIndex + 1}을(를) 삭제하시겠습니까?`)) {
    window.generatedCodeCells.splice(cellIndex, 1);
    
    // 에디터 다시 렌더링
    const editorContent = document.getElementById('editorContent');
    if (editorContent) {
      editorContent.innerHTML = renderCodeEditor();
      setupCodeEditorEvents();
    }
    
    updateSaveButtonColor();
  }
}

// 코드 에디터 이벤트 설정 (셀 수정/실행)
function setupCodeEditorEvents() {
  const editors = document.querySelectorAll('.code-cell-editor');
  const runButtons = document.querySelectorAll('.code-cell-run-btn');
  const addButtons = document.querySelectorAll('.code-cell-add-btn');
  const deleteButtons = document.querySelectorAll('.code-cell-delete-btn');

  // 내용 수정 시 전역 상태 업데이트
  editors.forEach((textarea) => {
    textarea.addEventListener('input', () => {
      const idx = Number(textarea.getAttribute('data-cell-index') || '0');
      if (!Array.isArray(window.generatedCodeCells)) {
        window.generatedCodeCells = [];
      }
      window.generatedCodeCells[idx] = textarea.value;
      updateSaveButtonColor();
    });
  });
  
  // 셀 추가 버튼
  addButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const insertAfter = Number(btn.getAttribute('data-insert-after') || '-1');
      addCodeCell(insertAfter);
    });
  });
  
  // 셀 삭제 버튼
  deleteButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.getAttribute('data-cell-index') || '0');
      deleteCodeCell(idx);
    });
  });

  // 셀 실행 버튼 → Pyodide로 실제 파이썬 실행
  runButtons.forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = Number(btn.getAttribute('data-cell-index') || '0');
      const output = document.getElementById(`codeCellOutput_${idx}`);
      const textarea = document.querySelector(
        `.code-cell-editor[data-cell-index="${idx}"]`,
      );

      if (!output || !textarea) return;

      const rawCode = textarea.value || '';
      const code = prepareCodeForExecution(rawCode);
      output.innerHTML =
        '<div class="code-cell-output-message running">파이썬 코드를 실행 중입니다...</div>';

      try {
        const pyodide = await getPyodideInstance();

        // 노코드 데이터가 있다면 Pyodide 가상 파일 시스템과 동기화
        await syncDataToPyodide();

        // stdout/stderr 캡처를 위한 래핑 코드 생성
        const indented = code
          .split('\n')
          .map((line) => `    ${line}`)
          .join('\n');

        const wrappedCode = `
import sys, io
_buf = io.StringIO()
_stdout = sys.stdout
_stderr = sys.stderr
sys.stdout = _buf
sys.stderr = _buf
try:
    # Matplotlib를 이미지로 저장하기 위한 설정 (화면에 직접 그리지 않도록 Agg 백엔드 사용)
    try:
        import matplotlib
        matplotlib.use("Agg")
    except Exception:
        pass
${indented}
finally:
    sys.stdout = _stdout
    sys.stderr = _stderr
_output = _buf.getvalue()

# Matplotlib 그래프가 있다면 PNG로 인코딩
_img_b64 = ""
try:
    import matplotlib.pyplot as _plt
    from io import BytesIO as _BytesIO
    import base64 as _base64
    _fig = _plt.gcf()
    if _fig.axes:
        _buf_img = _BytesIO()
        _fig.savefig(_buf_img, format="png", bbox_inches="tight")
        _img_b64 = _base64.b64encode(_buf_img.getvalue()).decode("ascii")
        _plt.close(_fig)
except Exception:
    _img_b64 = ""
`;

        await pyodide.runPythonAsync(wrappedCode);
        const result = pyodide.globals.get('_output');
        const text = result ? String(result) : '(출력 없음)';
        const imgB64 = pyodide.globals.get('_img_b64');
        pyodide.globals.delete('_output');
        pyodide.globals.delete('_img_b64');

        let html = '';
        if (text && text.trim()) {
          html += `<pre class="code-cell-output-pre">${escapeHtml(text)}</pre>`;
        }
        if (imgB64 && String(imgB64).trim()) {
          html += `<div class="code-cell-output-figure"><img src="data:image/png;base64,${String(
            imgB64,
          )}" alt="그래프" /></div>`;
        }
        if (!html) {
          html = '<span class="code-cell-output-placeholder">(출력 없음)</span>';
        }

        output.innerHTML = html;
      } catch (e) {
        output.innerHTML = `<pre class="code-cell-output-pre error">실행 중 오류가 발생했습니다.\\n${escapeHtml(
          String(e),
        )}</pre>`;
      }
    });
  });
}

// 이벤트 리스너 설정
function setupEventListeners() {
  // 뒤로가기 버튼
  const backButton = document.getElementById('backButton');
  if (backButton) {
    backButton.addEventListener('click', () => {
      window.location.href = 'projectList.html';
    });
  }

  // 프로젝트 저장 버튼
  const saveProjectBtn = document.getElementById('saveProjectBtn');
  if (saveProjectBtn) {
    saveProjectBtn.addEventListener('click', handleSaveProject);
  }

  // 코드 생성 버튼
  const generateCodeBtn = document.getElementById('generateCodeBtn');
  if (generateCodeBtn) {
    generateCodeBtn.addEventListener('click', handleGenerateCode);
  }

  // 모드 전환 버튼
  const nocodeModeBtn = document.getElementById('nocodeModeBtn');
  const codeModeBtn = document.getElementById('codeModeBtn');
  
  if (nocodeModeBtn) {
    nocodeModeBtn.addEventListener('click', () => switchMode('nocode'));
  }
  
  if (codeModeBtn) {
    codeModeBtn.addEventListener('click', () => switchMode('code'));
  }

  // 챗봇 토글 버튼
  const chatbotToggle = document.getElementById('chatbotToggle');
  if (chatbotToggle) {
    chatbotToggle.addEventListener('click', toggleChatbot);
  }

  // 챗봇 메시지 전송
  const chatbotSendBtn = document.getElementById('chatbotSendBtn');
  const chatbotInput = document.getElementById('chatbotInput');
  
  if (chatbotSendBtn && chatbotInput) {
    chatbotSendBtn.addEventListener('click', handleChatbotSend);
    chatbotInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleChatbotSend();
      }
    });
    // textarea 자동 높이 조절
    chatbotInput.addEventListener('input', () => {
      chatbotInput.style.height = 'auto';
      chatbotInput.style.height = chatbotInput.scrollHeight + 'px';
    });
  }

  // CSV 파일 업로드 이벤트
  setupFileUpload();

  // 데이터 전처리 이벤트
  setupPreprocessing();
}

// 데이터 전처리 설정
function setupPreprocessing() {
  const checkMissingBtn = document.getElementById('checkMissingBtn');
  const resolveMissingBtn = document.getElementById('resolveMissingBtn');
  const applyMissingBtn = document.getElementById('applyMissingBtn');
  const checkOutlierBtn = document.getElementById('checkOutlierBtn');
  const resolveOutlierBtn = document.getElementById('resolveOutlierBtn');
  const applyOutlierBtn = document.getElementById('applyOutlierBtn');

  if (checkMissingBtn) {
    checkMissingBtn.addEventListener('click', handleCheckMissing);
  }

  if (resolveMissingBtn) {
    resolveMissingBtn.addEventListener('click', () => {
      const section = document.getElementById('resolveMissingSection');
      if (section) {
        section.style.display = 'block';
      }
    });
  }

  if (applyMissingBtn) {
    applyMissingBtn.addEventListener('click', handleApplyMissing);
  }

  if (checkOutlierBtn) {
    checkOutlierBtn.addEventListener('click', handleCheckOutlier);
  }

  if (resolveOutlierBtn) {
    resolveOutlierBtn.addEventListener('click', () => {
      const section = document.getElementById('resolveOutlierSection');
      if (section) section.style.display = 'block';
    });
  }

  if (applyOutlierBtn) {
    applyOutlierBtn.addEventListener('click', handleApplyOutlier);
  }

  // 정규화 이벤트
  const normalizeBtn = document.getElementById('normalizeBtn');
  const applyNormalizeBtn = document.getElementById('applyNormalizeBtn');

  if (normalizeBtn) {
    normalizeBtn.addEventListener('click', handleNormalize);
  }

  if (applyNormalizeBtn) {
    applyNormalizeBtn.addEventListener('click', handleApplyNormalize);
  }

  // 시각화 이벤트
  const addChartBtn = document.getElementById('addChartBtn');
  if (addChartBtn) {
    addChartBtn.addEventListener('click', handleAddChart);
  }

  // 핵심 속성 추출 이벤트
  setupFeatureExtraction();
}

// 핵심 속성 추출 설정
function setupFeatureExtraction() {
  const selectAllBtn = document.getElementById('selectAllFeaturesBtn');
  const deselectAllBtn = document.getElementById('deselectAllFeaturesBtn');
  const generatePairplotBtn = document.getElementById('generatePairplotBtn');
  const generateHeatmapBtn = document.getElementById('generateHeatmapBtn');

  if (selectAllBtn) {
    selectAllBtn.addEventListener('click', () => {
      const checkboxes = document.querySelectorAll('.feature-checkbox');
      checkboxes.forEach(cb => cb.checked = true);
      updateSelectedFeatures();
      updateSaveButtonColor();
    });
  }

  if (deselectAllBtn) {
    deselectAllBtn.addEventListener('click', () => {
      const checkboxes = document.querySelectorAll('.feature-checkbox');
      checkboxes.forEach(cb => cb.checked = false);
      updateSelectedFeatures();
      updateSaveButtonColor();
    });
  }

  if (generatePairplotBtn) {
    generatePairplotBtn.addEventListener('click', handleGeneratePairplot);
  }

  if (generateHeatmapBtn) {
    generateHeatmapBtn.addEventListener('click', handleGenerateHeatmap);
  }

  // 모델 생성 이벤트
  setupModelTraining();
}

// 모델 생성 설정
function setupModelTraining() {
  // 알고리즘 선택 이벤트
  const algorithmRadios = document.querySelectorAll('input[name="algorithm"]');
  algorithmRadios.forEach(radio => {
    radio.addEventListener('change', handleAlgorithmChange);
  });

  // 종속 변수 선택 이벤트
  const dependentVariableSelect = document.getElementById('dependentVariableSelect');
  if (dependentVariableSelect) {
    dependentVariableSelect.addEventListener('change', () => {
      updateModelTrainingUI();
      updateSaveButtonColor();
    });
  }

  // 독립 변수 전체 선택/해제 버튼
  const selectAllIndependentBtn = document.getElementById('selectAllIndependentBtn');
  const deselectAllIndependentBtn = document.getElementById('deselectAllIndependentBtn');
  if (selectAllIndependentBtn) {
    selectAllIndependentBtn.addEventListener('click', () => {
      const checkboxes = document.querySelectorAll('.independent-variable-checkbox');
      checkboxes.forEach(cb => cb.checked = true);
      updateIndependentVariables();
      updateSaveButtonColor();
    });
  }
  if (deselectAllIndependentBtn) {
    deselectAllIndependentBtn.addEventListener('click', () => {
      const checkboxes = document.querySelectorAll('.independent-variable-checkbox');
      checkboxes.forEach(cb => cb.checked = false);
      updateIndependentVariables();
      updateSaveButtonColor();
    });
  }

  // 훈련/테스트 비율 조정 이벤트
  const trainRatioInput = document.getElementById('trainRatioInput');
  if (trainRatioInput) {
    trainRatioInput.addEventListener('input', handleTrainRatioChange);
  }

  // 모델 학습 버튼
  const trainModelBtn = document.getElementById('trainModelBtn');
  if (trainModelBtn) {
    trainModelBtn.addEventListener('click', handleTrainModel);
  }
}

// 모델 섹션 초기화
function initializeModelSection(columns) {
  if (!columns) return;

  // 독립 변수 체크박스 초기화 (수치형 데이터만)
  const independentVariablesList = document.getElementById('independentVariablesList');
  if (independentVariablesList) {
    // 수치형 컬럼만 필터링
    const dataInfo = calculateDataFrameInfo(window.currentData || [], columns);
    const numericColumns = dataInfo.columns
      .filter(col => col.isNumeric)
      .map(col => col.name);
    
    if (numericColumns.length === 0) {
      independentVariablesList.innerHTML = '<p class="no-numeric-warning">수치형 데이터가 없습니다.</p>';
    } else {
    
    // 저장된 독립 변수가 있으면 복원
    const savedIndependent = window.modelConfig?.independentVariables || [];
    
    let html = '<div class="variable-checkboxes-container">';
    numericColumns.forEach(col => {
      const isChecked = savedIndependent.includes(col);
      html += `
        <label class="variable-checkbox-label">
          <input type="checkbox" class="independent-variable-checkbox" data-column="${escapeHtml(col)}" ${isChecked ? 'checked' : ''}>
          <span>${escapeHtml(col)}</span>
        </label>
      `;
      });
      html += '</div>';
      independentVariablesList.innerHTML = html;

      // 체크박스 변경 이벤트 리스너 추가
      const checkboxes = independentVariablesList.querySelectorAll('.independent-variable-checkbox');
      checkboxes.forEach(checkbox => {
        checkbox.addEventListener('change', () => {
          updateIndependentVariables();
          updateSaveButtonColor();
        });
      });

      // 독립 변수 상태 업데이트
      updateIndependentVariables();
    }
  }

  // 종속 변수 선택 드롭다운 초기화
  const dependentVariableSelect = document.getElementById('dependentVariableSelect');
  if (dependentVariableSelect) {
    dependentVariableSelect.innerHTML = '<option value="">선택하세요</option>';
    columns.forEach(col => {
      const option = document.createElement('option');
      option.value = escapeHtml(col);
      option.textContent = escapeHtml(col);
      dependentVariableSelect.appendChild(option);
    });

    // 저장된 종속 변수가 있으면 복원
    if (window.modelConfig && window.modelConfig.dependentVariable) {
      dependentVariableSelect.value = window.modelConfig.dependentVariable;
    }
  }

  // 저장된 모델 설정이 있으면 복원
  if (window.modelConfig) {
    // 알고리즘 복원
    if (window.modelConfig.algorithm) {
      const algorithmRadio = document.querySelector(`input[name="algorithm"][value="${window.modelConfig.algorithm}"]`);
      if (algorithmRadio) {
        algorithmRadio.checked = true;
        handleAlgorithmChange();
      }
    }

    // 종속 변수 복원 (이미 위에서 처리됨)

    // 훈련/테스트 비율 복원
    if (window.modelConfig.trainRatio) {
      const trainRatioInput = document.getElementById('trainRatioInput');
      if (trainRatioInput) {
        trainRatioInput.value = window.modelConfig.trainRatio;
        handleTrainRatioChange();
      }
    }

    // UI 업데이트
    setTimeout(() => {
      updateModelTrainingUI();
    }, 100);
  }
}

// 독립 변수 업데이트
function updateIndependentVariables() {
  const selectedColumns = Array.from(document.querySelectorAll('.independent-variable-checkbox:checked'))
    .map(cb => cb.getAttribute('data-column'));
  
  if (!window.modelConfig) {
    window.modelConfig = {};
  }
  window.modelConfig.independentVariables = selectedColumns;
}

// 알고리즘 변경 핸들러
function handleAlgorithmChange() {
  const selectedAlgorithm = document.querySelector('input[name="algorithm"]:checked')?.value;
  if (!selectedAlgorithm) {
    document.getElementById('targetVariableBlock').style.display = 'none';
    document.getElementById('trainTestSplitBlock').style.display = 'none';
    document.getElementById('hyperparameterBlock').style.display = 'none';
    document.getElementById('trainModelBlock').style.display = 'none';
    return;
  }

  // 군집 알고리즘(K-means)은 타겟 변수가 필요 없음
  const isClustering = selectedAlgorithm === 'kmeans';
  const targetVariableBlock = document.getElementById('targetVariableBlock');
  if (targetVariableBlock) {
    targetVariableBlock.style.display = isClustering ? 'none' : 'block';
  }

  // 훈련/테스트 분할 블록 표시
  const trainTestSplitBlock = document.getElementById('trainTestSplitBlock');
  if (trainTestSplitBlock) {
    trainTestSplitBlock.style.display = 'block';
  }

  // 하이퍼파라미터 블록 표시 및 생성
  renderHyperparameters(selectedAlgorithm);

  updateModelTrainingUI();
  updateSaveButtonColor();
}

// 하이퍼파라미터 렌더링
function renderHyperparameters(algorithm) {
  const hyperparameterControls = document.getElementById('hyperparameterControls');
  const hyperparameterBlock = document.getElementById('hyperparameterBlock');
  if (!hyperparameterControls || !hyperparameterBlock) return;

  hyperparameterBlock.style.display = 'block';

  let html = '';

  // 저장된 하이퍼파라미터 가져오기
  const savedParams = window.modelConfig?.hyperparameters || {};

  switch (algorithm) {
    case 'linear_regression':
      html = `
        <div class="hyperparameter-group">
          <label class="hyperparameter-label">
            <span>절편 사용 (fit_intercept)</span>
            <input type="checkbox" id="linear_fit_intercept" ${savedParams.fit_intercept !== false ? 'checked' : ''}>
          </label>
        </div>
      `;
      break;

    case 'decision_tree':
      html = `
        <div class="hyperparameter-group">
          <label class="hyperparameter-label">
            <span>최대 깊이 (max_depth)</span>
            <input type="number" id="dt_max_depth" class="hyperparameter-input" min="1" max="50" value="${savedParams.max_depth || 10}">
          </label>
          <label class="hyperparameter-label">
            <span>최소 분할 샘플 수 (min_samples_split)</span>
            <input type="number" id="dt_min_samples_split" class="hyperparameter-input" min="2" value="${savedParams.min_samples_split || 2}">
          </label>
          <label class="hyperparameter-label">
            <span>최소 리프 샘플 수 (min_samples_leaf)</span>
            <input type="number" id="dt_min_samples_leaf" class="hyperparameter-input" min="1" value="${savedParams.min_samples_leaf || 1}">
          </label>
        </div>
      `;
      break;

    case 'knn':
      html = `
        <div class="hyperparameter-group">
          <label class="hyperparameter-label">
            <span>이웃 수 (n_neighbors)</span>
            <input type="number" id="knn_n_neighbors" class="hyperparameter-input" min="1" max="50" value="${savedParams.n_neighbors || 5}">
          </label>
          <label class="hyperparameter-label">
            <span>가중치 (weights)</span>
            <select id="knn_weights" class="hyperparameter-select">
              <option value="uniform" ${savedParams.weights === 'uniform' ? 'selected' : ''}>균등 (uniform)</option>
              <option value="distance" ${savedParams.weights === 'distance' ? 'selected' : ''}>거리 (distance)</option>
            </select>
          </label>
        </div>
      `;
      break;

    case 'logistic_regression':
      html = `
        <div class="hyperparameter-group">
          <label class="hyperparameter-label">
            <span>정규화 강도 (C)</span>
            <input type="number" id="lr_C" class="hyperparameter-input" min="0.01" max="100" step="0.01" value="${savedParams.C || 1.0}">
          </label>
          <label class="hyperparameter-label">
            <span>정규화 방법 (penalty)</span>
            <select id="lr_penalty" class="hyperparameter-select">
              <option value="l2" ${savedParams.penalty === 'l2' ? 'selected' : ''}>L2</option>
              <option value="l1" ${savedParams.penalty === 'l1' ? 'selected' : ''}>L1</option>
            </select>
          </label>
        </div>
      `;
      break;

    case 'kmeans':
      html = `
        <div class="hyperparameter-group">
          <label class="hyperparameter-label">
            <span>클러스터 수 (n_clusters)</span>
            <input type="number" id="kmeans_n_clusters" class="hyperparameter-input" min="2" max="20" value="${savedParams.n_clusters || 3}">
          </label>
          <label class="hyperparameter-label">
            <span>초기화 방법 (init)</span>
            <select id="kmeans_init" class="hyperparameter-select">
              <option value="k-means++" ${savedParams.init === 'k-means++' ? 'selected' : ''}>k-means++</option>
              <option value="random" ${savedParams.init === 'random' ? 'selected' : ''}>랜덤 (random)</option>
            </select>
          </label>
          <label class="hyperparameter-label">
            <span>최대 반복 횟수 (max_iter)</span>
            <input type="number" id="kmeans_max_iter" class="hyperparameter-input" min="1" max="1000" value="${savedParams.max_iter || 300}">
          </label>
        </div>
      `;
      break;
  }

  hyperparameterControls.innerHTML = html;

  // 하이퍼파라미터 변경 이벤트 추가
  const inputs = hyperparameterControls.querySelectorAll('input, select');
  inputs.forEach(input => {
    input.addEventListener('change', () => {
      updateSaveButtonColor();
    });
  });
}

// 훈련/테스트 비율 변경 핸들러
function handleTrainRatioChange() {
  const trainRatioInput = document.getElementById('trainRatioInput');
  const testRatioInput = document.getElementById('testRatioInput');
  if (!trainRatioInput || !testRatioInput) return;

  const trainRatio = parseFloat(trainRatioInput.value);
  const testRatio = 1 - trainRatio;
  
  testRatioInput.value = testRatio.toFixed(1);
  
  // 비율 표시 업데이트
  const trainDisplay = trainRatioInput.nextElementSibling;
  const testDisplay = testRatioInput.nextElementSibling;
  if (trainDisplay) trainDisplay.textContent = `${(trainRatio * 100).toFixed(0)}%`;
  if (testDisplay) testDisplay.textContent = `${(testRatio * 100).toFixed(0)}%`;

  updateSaveButtonColor();
}

// 모델 학습 UI 업데이트
function updateModelTrainingUI() {
  const selectedAlgorithm = document.querySelector('input[name="algorithm"]:checked')?.value;
  const dependentVariable = document.getElementById('dependentVariableSelect')?.value;
  const independentVariables = Array.from(document.querySelectorAll('.independent-variable-checkbox:checked'))
    .map(cb => cb.getAttribute('data-column'));
  const isClustering = selectedAlgorithm === 'kmeans';
  
  const trainModelBlock = document.getElementById('trainModelBlock');
  if (trainModelBlock) {
    // 군집 알고리즘이거나 (종속 변수와 독립 변수가 모두 선택되었으면) 학습 버튼 표시
    if (selectedAlgorithm && (isClustering || (dependentVariable && independentVariables.length > 0))) {
      trainModelBlock.style.display = 'block';
    } else {
      trainModelBlock.style.display = 'none';
    }
  }
}

// 모델 학습 핸들러
function handleTrainModel() {
  if (!window.currentData || !window.currentColumns) {
    alert('먼저 데이터를 업로드해주세요.');
    return;
  }

  const selectedAlgorithm = document.querySelector('input[name="algorithm"]:checked')?.value;
  if (!selectedAlgorithm) {
    alert('알고리즘을 선택해주세요.');
    return;
  }

  const isClustering = selectedAlgorithm === 'kmeans';
  const dependentVariable = document.getElementById('dependentVariableSelect')?.value;
  const independentVariables = Array.from(document.querySelectorAll('.independent-variable-checkbox:checked'))
    .map(cb => cb.getAttribute('data-column'));
  
  if (!isClustering) {
    if (!dependentVariable) {
      alert('종속 변수를 선택해주세요.');
      return;
    }
    if (independentVariables.length === 0) {
      alert('독립 변수를 최소 1개 이상 선택해주세요.');
      return;
    }
  }

  // 하이퍼파라미터 수집
  const hyperparameters = collectHyperparameters(selectedAlgorithm);
  
  // 훈련/테스트 비율
  const trainRatio = parseFloat(document.getElementById('trainRatioInput')?.value || 0.8);

  // 모델 설정 저장
  window.modelConfig = {
    algorithm: selectedAlgorithm,
    dependentVariable: dependentVariable || null,
    independentVariables: independentVariables || [],
    trainRatio,
    hyperparameters,
  };

  // 모델 학습 실행
  trainModel(selectedAlgorithm, dependentVariable, independentVariables, trainRatio, hyperparameters);
  
  updateSaveButtonColor();
}

// 하이퍼파라미터 수집
function collectHyperparameters(algorithm) {
  const params = {};

  switch (algorithm) {
    case 'linear_regression':
      params.fit_intercept = document.getElementById('linear_fit_intercept')?.checked !== false;
      break;

    case 'decision_tree':
      params.max_depth = parseInt(document.getElementById('dt_max_depth')?.value || 10);
      params.min_samples_split = parseInt(document.getElementById('dt_min_samples_split')?.value || 2);
      params.min_samples_leaf = parseInt(document.getElementById('dt_min_samples_leaf')?.value || 1);
      break;

    case 'knn':
      params.n_neighbors = parseInt(document.getElementById('knn_n_neighbors')?.value || 5);
      params.weights = document.getElementById('knn_weights')?.value || 'uniform';
      break;

    case 'logistic_regression':
      params.C = parseFloat(document.getElementById('lr_C')?.value || 1.0);
      params.penalty = document.getElementById('lr_penalty')?.value || 'l2';
      break;

    case 'kmeans':
      params.n_clusters = parseInt(document.getElementById('kmeans_n_clusters')?.value || 3);
      params.init = document.getElementById('kmeans_init')?.value || 'k-means++';
      params.max_iter = parseInt(document.getElementById('kmeans_max_iter')?.value || 300);
      break;
  }

  return params;
}

// 모델 학습 실행
function trainModel(algorithm, dependentVariable, independentVariables, trainRatio, hyperparameters) {
  const trainBtn = document.getElementById('trainModelBtn');
  const resultsDiv = document.getElementById('modelResults');
  
  if (trainBtn) {
    trainBtn.disabled = true;
    trainBtn.textContent = '학습 중...';
  }

  if (resultsDiv) {
    resultsDiv.style.display = 'block';
    resultsDiv.innerHTML = '<p>모델을 학습하는 중입니다...</p>';
  }

  // 선형회귀인 경우 실제 학습 수행
  if (algorithm === 'linear_regression' && !window.currentData) {
    alert('데이터를 불러오는 중입니다. 잠시 후 다시 시도해주세요.');
    if (trainBtn) {
      trainBtn.disabled = false;
      trainBtn.textContent = '모델 학습하기';
    }
    return;
  }

  if (algorithm === 'linear_regression') {
    // 선형회귀 학습
    trainLinearRegression(dependentVariable, independentVariables, trainRatio, hyperparameters, resultsDiv, trainBtn);
  } else {
    // 다른 알고리즘은 기존 로직
    setTimeout(() => {
      if (resultsDiv) {
        const isClustering = algorithm === 'kmeans';
        let resultHTML = `
          <div class="model-result-content">
            <h5 class="result-title">학습 완료</h5>
            <div class="result-info">
              <p><strong>알고리즘:</strong> ${getAlgorithmName(algorithm)}</p>
              ${!isClustering ? `
                <p><strong>종속 변수:</strong> ${escapeHtml(dependentVariable)}</p>
                <p><strong>독립 변수:</strong> ${independentVariables.map(v => escapeHtml(v)).join(', ')}</p>
              ` : ''}
              <p><strong>훈련 데이터 비율:</strong> ${(trainRatio * 100).toFixed(0)}%</p>
              <p><strong>테스트 데이터 비율:</strong> ${((1 - trainRatio) * 100).toFixed(0)}%</p>
            </div>
        `;

        if (!isClustering) {
          resultHTML += `
            <div class="model-metrics">
              <h6>모델 성능</h6>
              <p>실제 모델 학습은 코드 모드에서 Python을 통해 실행됩니다.</p>
              <p>노코드 모드에서는 설정만 저장됩니다.</p>
            </div>
          `;
        } else {
          resultHTML += `
            <div class="model-metrics">
              <h6>클러스터링 결과</h6>
              <p>실제 클러스터링은 코드 모드에서 Python을 통해 실행됩니다.</p>
              <p>노코드 모드에서는 설정만 저장됩니다.</p>
            </div>
          `;
        }

        resultHTML += '</div>';
        resultsDiv.innerHTML = resultHTML;
      }

      if (trainBtn) {
        trainBtn.disabled = false;
        trainBtn.textContent = '모델 학습하기';
      }
    }, 1000);
  }
}

// 선형회귀 학습
function trainLinearRegression(dependentVariable, independentVariables, trainRatio, hyperparameters, resultsDiv, trainBtn) {
  const data = window.currentData;
  const fitIntercept = hyperparameters.fit_intercept !== false;

  // 데이터 준비
  const X = [];
  const y = [];
  
  data.forEach(row => {
    const xRow = independentVariables.map(col => {
      const val = parseFloat(row[col]);
      return isNaN(val) ? null : val;
    });
    
    const yVal = parseFloat(row[dependentVariable]);
    
    // 모든 값이 유효한 경우만 추가
    if (!xRow.includes(null) && !isNaN(yVal)) {
      X.push(xRow);
      y.push(yVal);
    }
  });

  if (X.length === 0) {
    alert('유효한 데이터가 없습니다.');
    if (trainBtn) {
      trainBtn.disabled = false;
      trainBtn.textContent = '모델 학습하기';
    }
    return;
  }

  // 선형회귀 계산 (최소제곱법)
  const coefficients = calculateLinearRegression(X, y, fitIntercept);
  
  // 회귀식 생성
  const equation = generateRegressionEquation(coefficients, independentVariables, fitIntercept);
  
  // R² 계산
  const rSquared = calculateRSquared(X, y, coefficients, fitIntercept);

  // 결과 표시
  let resultHTML = `
    <div class="model-result-content">
      <h5 class="result-title">학습 완료</h5>
      <div class="result-info">
        <p><strong>알고리즘:</strong> 선형회귀</p>
        <p><strong>종속 변수:</strong> ${escapeHtml(dependentVariable)}</p>
        <p><strong>독립 변수:</strong> ${independentVariables.map(v => escapeHtml(v)).join(', ')}</p>
        <p><strong>훈련 데이터 비율:</strong> ${(trainRatio * 100).toFixed(0)}%</p>
        <p><strong>테스트 데이터 비율:</strong> ${((1 - trainRatio) * 100).toFixed(0)}%</p>
      </div>
      <div class="model-metrics">
        <h6>회귀식</h6>
        <div class="regression-equation">${equation}</div>
        <p><strong>R² (결정계수):</strong> ${rSquared.toFixed(4)}</p>
      </div>
  `;

  // 그래프 표시 (1차원, 2차원, 3차원까지)
  if (independentVariables.length <= 3) {
    resultHTML += `
      <div class="regression-chart-container">
        <h6>회귀 그래프</h6>
        <div id="regressionChartContainer"></div>
      </div>
    `;
  }

  resultHTML += '</div>';
  resultsDiv.innerHTML = resultHTML;

  // 그래프 그리기
  if (independentVariables.length <= 3) {
    setTimeout(() => {
      drawRegressionChart(X, y, coefficients, independentVariables, dependentVariable, fitIntercept);
    }, 100);
  }

  if (trainBtn) {
    trainBtn.disabled = false;
    trainBtn.textContent = '모델 학습하기';
  }
}

// 선형회귀 계수 계산 (최소제곱법)
function calculateLinearRegression(X, y, fitIntercept) {
  const n = X.length;
  const m = X[0].length;

  if (fitIntercept) {
    // 절편 포함: y = a0 + a1*x1 + a2*x2 + ...
    // X 행렬에 1 컬럼 추가
    const XWithIntercept = X.map(row => [1, ...row]);
    return solveNormalEquation(XWithIntercept, y);
  } else {
    // 절편 없음: y = a1*x1 + a2*x2 + ...
    return solveNormalEquation(X, y);
  }
}

// 정규방정식 풀이
function solveNormalEquation(X, y) {
  const n = X.length;
  const m = X[0].length;

  // X^T * X 계산
  const XTX = [];
  for (let i = 0; i < m; i++) {
    XTX[i] = [];
    for (let j = 0; j < m; j++) {
      let sum = 0;
      for (let k = 0; k < n; k++) {
        sum += X[k][i] * X[k][j];
      }
      XTX[i][j] = sum;
    }
  }

  // X^T * y 계산
  const XTy = [];
  for (let i = 0; i < m; i++) {
    let sum = 0;
    for (let k = 0; k < n; k++) {
      sum += X[k][i] * y[k];
    }
    XTy[i] = sum;
  }

  // (X^T * X)^(-1) * X^T * y 계산 (가우스 소거법)
  return gaussianElimination(XTX, XTy);
}

// 가우스 소거법
function gaussianElimination(A, b) {
  const n = A.length;
  const augmented = A.map((row, i) => [...row, b[i]]);

  // 전진 소거
  for (let i = 0; i < n; i++) {
    // 피벗 찾기
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(augmented[k][i]) > Math.abs(augmented[maxRow][i])) {
        maxRow = k;
      }
    }
    [augmented[i], augmented[maxRow]] = [augmented[maxRow], augmented[i]];

    // 소거
    for (let k = i + 1; k < n; k++) {
      const factor = augmented[k][i] / augmented[i][i];
      for (let j = i; j < n + 1; j++) {
        augmented[k][j] -= factor * augmented[i][j];
      }
    }
  }

  // 후진 대입
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    x[i] = augmented[i][n];
    for (let j = i + 1; j < n; j++) {
      x[i] -= augmented[i][j] * x[j];
    }
    x[i] /= augmented[i][i];
  }

  return x;
}

// 회귀식 문자열 생성
function generateRegressionEquation(coefficients, independentVariables, fitIntercept) {
  let equation = 'y = ';
  let terms = [];

  if (fitIntercept) {
    const intercept = coefficients[0];
    terms.push(`${intercept >= 0 ? '' : '-'}${Math.abs(intercept).toFixed(4)}`);
    
    for (let i = 1; i < coefficients.length; i++) {
      const coef = coefficients[i];
      const varName = independentVariables[i - 1];
      if (Math.abs(coef) > 1e-10) {
        terms.push(`${coef >= 0 ? '+' : ''}${coef.toFixed(4)}${escapeHtml(varName)}`);
      }
    }
  } else {
    for (let i = 0; i < coefficients.length; i++) {
      const coef = coefficients[i];
      const varName = independentVariables[i];
      if (Math.abs(coef) > 1e-10) {
        terms.push(`${coef >= 0 ? '' : '-'}${Math.abs(coef).toFixed(4)}${escapeHtml(varName)}`);
        if (i < coefficients.length - 1 && coefficients[i + 1] >= 0) {
          terms[terms.length - 1] += ' +';
        }
      }
    }
  }

  equation += terms.join(' ');
  return equation;
}

// R² 계산
function calculateRSquared(X, y, coefficients, fitIntercept) {
  const n = y.length;
  const yMean = y.reduce((a, b) => a + b, 0) / n;
  
  let ssRes = 0; // 잔차 제곱합
  let ssTot = 0; // 총 제곱합

  for (let i = 0; i < n; i++) {
    let predicted = 0;
    if (fitIntercept) {
      predicted = coefficients[0];
      for (let j = 0; j < X[i].length; j++) {
        predicted += coefficients[j + 1] * X[i][j];
      }
    } else {
      for (let j = 0; j < X[i].length; j++) {
        predicted += coefficients[j] * X[i][j];
      }
    }
    
    ssRes += Math.pow(y[i] - predicted, 2);
    ssTot += Math.pow(y[i] - yMean, 2);
  }

  return 1 - (ssRes / ssTot);
}

// 회귀 그래프 그리기
function drawRegressionChart(X, y, coefficients, independentVariables, dependentVariable, fitIntercept) {
  const container = document.getElementById('regressionChartContainer');
  if (!container) return;

  const dim = independentVariables.length;

  if (dim === 1) {
    // 1차원: 2D 산점도 + 회귀선
    draw2DRegressionChart(X, y, coefficients, independentVariables[0], dependentVariable, fitIntercept, container);
  } else if (dim === 2) {
    // 2차원: 3D 산점도 + 회귀 평면
    draw3DRegressionChart(X, y, coefficients, independentVariables, dependentVariable, fitIntercept, container);
  } else if (dim === 3) {
    // 3차원: 3D 산점도 (3개 변수 중 2개 선택)
    draw3DRegressionChart(X, y, coefficients, independentVariables.slice(0, 2), dependentVariable, fitIntercept, container);
  }
}

// 2D 회귀 그래프 (1차원)
function draw2DRegressionChart(X, y, coefficients, xVar, yVar, fitIntercept, container) {
  container.innerHTML = '<canvas id="regressionChart2D" width="600" height="400"></canvas>';
  const canvas = document.getElementById('regressionChart2D');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  const padding = 50;

  // 데이터 포인트
  const xValues = X.map(row => row[0]);
  const xMin = Math.min(...xValues);
  const xMax = Math.max(...xValues);
  const yMin = Math.min(...y);
  const yMax = Math.max(...y);
  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;

  // 배경
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  // 그리드
  ctx.strokeStyle = '#e5e5e7';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 10; i++) {
    const x = padding + (i / 10) * (width - 2 * padding);
    ctx.beginPath();
    ctx.moveTo(x, padding);
    ctx.lineTo(x, height - padding);
    ctx.stroke();

    const y = padding + (i / 10) * (height - 2 * padding);
    ctx.beginPath();
    ctx.moveTo(padding, y);
    ctx.lineTo(width - padding, y);
    ctx.stroke();
  }

  // 회귀선 그리기
  ctx.strokeStyle = '#667eea';
  ctx.lineWidth = 2;
  ctx.beginPath();
  const x1 = padding;
  const x2 = width - padding;
  const y1 = height - padding - ((predictY(coefficients, [xMin], fitIntercept) - yMin) / yRange) * (height - 2 * padding);
  const y2 = height - padding - ((predictY(coefficients, [xMax], fitIntercept) - yMin) / yRange) * (height - 2 * padding);
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  // 데이터 포인트
  ctx.fillStyle = '#667eea';
  for (let i = 0; i < X.length; i++) {
    const x = padding + ((xValues[i] - xMin) / xRange) * (width - 2 * padding);
    const yPos = height - padding - ((y[i] - yMin) / yRange) * (height - 2 * padding);
    ctx.beginPath();
    ctx.arc(x, yPos, 4, 0, 2 * Math.PI);
    ctx.fill();
  }

  // 축 레이블
  ctx.fillStyle = '#1d1d1f';
  ctx.font = '12px Arial';
  ctx.textAlign = 'center';
  ctx.fillText(xVar, width / 2, height - 10);
  ctx.save();
  ctx.translate(15, height / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(yVar, 0, 0);
  ctx.restore();
}

// 3D 회귀 그래프 (2차원, 3차원)
function draw3DRegressionChart(X, y, coefficients, independentVariables, dependentVariable, fitIntercept, container) {
  container.innerHTML = `
    <div class="regression-3d-note">
      <p>3D 그래프는 코드 모드에서 Python의 matplotlib을 통해 표시됩니다.</p>
      <p>독립 변수: ${independentVariables.map(v => escapeHtml(v)).join(', ')}</p>
      <p>종속 변수: ${escapeHtml(dependentVariable)}</p>
    </div>
  `;
}

// 예측값 계산
function predictY(coefficients, x, fitIntercept) {
  if (fitIntercept) {
    let result = coefficients[0];
    for (let i = 0; i < x.length; i++) {
      result += coefficients[i + 1] * x[i];
    }
    return result;
  } else {
    let result = 0;
    for (let i = 0; i < x.length; i++) {
      result += coefficients[i] * x[i];
    }
    return result;
  }
}

// 알고리즘 이름 가져오기
function getAlgorithmName(algorithm) {
  const names = {
    'linear_regression': '선형회귀',
    'decision_tree': '결정트리',
    'knn': 'kNN',
    'logistic_regression': '로지스틱회귀',
    'kmeans': 'K-means'
  };
  return names[algorithm] || algorithm;
}

// 파일 업로드 설정
function setupFileUpload() {
  const csvFileInput = document.getElementById('csvFileInput');
  const uploadBox = document.getElementById('uploadBox');
  const uploadArea = document.getElementById('uploadArea');

  if (!csvFileInput || !uploadBox || !uploadArea) return;

  // 파일 입력 클릭
  uploadBox.addEventListener('click', () => {
    csvFileInput.click();
  });

  // 드래그 앤 드롭
  uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('dragover');
  });

  uploadArea.addEventListener('dragleave', () => {
    uploadArea.classList.remove('dragover');
  });

  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFileUpload(files[0]);
    }
  });

  // 파일 선택
  csvFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      handleFileUpload(file);
    }
  });
}

// 파일 업로드 처리
async function handleFileUpload(file) {
  const uploadBox = document.getElementById('uploadBox');
  const dataInfoSection = document.getElementById('dataInfoSection');
  const dataTableSection = document.getElementById('dataTableSection');
  const dataInfoGrid = document.getElementById('dataInfoGrid');
  const dataTableContainer = document.getElementById('dataTableContainer');

  if (!uploadBox || !dataInfoSection || !dataTableSection) return;

  // 로딩 상태
  uploadBox.innerHTML = '<div class="loading-spinner"></div><p>파일을 읽는 중...</p>';

  try {
    let data;
    let columns;

    if (file.name.endsWith('.csv')) {
      // CSV 파일 처리
      const text = await file.text();
      const result = parseCSV(text);
      data = result.data;
      columns = result.columns;
    } else if (file.name.endsWith('.xlsx')) {
      // XLSX 파일 처리 (추후 구현)
      alert('XLSX 파일은 추후 지원 예정입니다. CSV 파일을 사용해주세요.');
      uploadBox.innerHTML = `
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="17 8 12 3 7 8"></polyline>
          <line x1="12" y1="3" x2="12" y2="15"></line>
        </svg>
        <p class="upload-text">CSV 또는 XLSX 파일을 드래그하거나 클릭하여 업로드</p>
        <p class="upload-hint">지원 형식: .csv, .xlsx</p>
      `;
      return;
    } else {
      alert('지원하지 않는 파일 형식입니다.');
      uploadBox.innerHTML = `
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="17 8 12 3 7 8"></polyline>
          <line x1="12" y1="3" x2="12" y2="15"></line>
        </svg>
        <p class="upload-text">CSV 또는 XLSX 파일을 드래그하거나 클릭하여 업로드</p>
        <p class="upload-hint">지원 형식: .csv, .xlsx</p>
      `;
      return;
    }

    // 데이터프레임 정보 계산
    const dataInfo = calculateDataFrameInfo(data, columns);

    // 데이터 테이블 표시 (먼저 표시)
    renderDataTable(data, columns, dataTableContainer);
    dataTableSection.style.display = 'block';

    // 데이터프레임 정보 표시
    renderDataFrameInfo(dataInfo, dataInfoGrid);
    dataInfoSection.style.display = 'block';

    // 데이터 전처리 섹션 표시 (시각화 포함)
    const preprocessingSection = document.getElementById('preprocessingSection');
    if (preprocessingSection) {
      preprocessingSection.style.display = 'block';
    }

    // 핵심 속성 추출 섹션 표시 및 속성 선택 리스트 생성
    const featureExtractionSection = document.getElementById('featureExtractionSection');
    if (featureExtractionSection) {
      featureExtractionSection.style.display = 'block';
      initializeFeatureSelection(columns);
    }

    // 모델 생성 섹션 표시
    const modelSection = document.getElementById('modelSection');
    if (modelSection && columns) {
      modelSection.style.display = 'block';
      initializeModelSection(columns);
    }

    // 업로드 박스 복원 (다시 업로드 가능하도록)
    uploadBox.innerHTML = `
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
        <polyline points="17 8 12 3 7 8"></polyline>
        <line x1="12" y1="3" x2="12" y2="15"></line>
      </svg>
      <p class="upload-text">CSV 또는 XLSX 파일을 드래그하거나 클릭하여 업로드</p>
      <p class="upload-hint">지원 형식: .csv, .xlsx</p>
      <p class="upload-success" style="color: #667eea; margin-top: 0.5rem; font-weight: 500;">✓ ${escapeHtml(file.name)} 업로드 완료</p>
    `;
    uploadBox.style.pointerEvents = 'auto';
    
    // 파일 입력 초기화 (같은 파일 다시 선택 가능하도록)
    const csvFileInput = document.getElementById('csvFileInput');
    if (csvFileInput) {
      csvFileInput.value = '';
    }

    // 전역 변수에 데이터 저장 (추후 사용)
    window.currentData = data;
    window.currentColumns = columns;
    window.originalFileName = file.name;
    window.pyodideDataPath = null; // 새 파일 업로드 시 경로 초기화
    recordOperation({
      type: 'load_data',
      fileName: file.name,
      fileType: file.name.endsWith('.csv') ? 'csv' : 'xlsx',
    });
    
    updateSaveButtonColor();

  } catch (error) {
    console.error('파일 처리 오류:', error);
    alert(`파일 처리 중 오류가 발생했습니다: ${error.message}`);
    uploadBox.innerHTML = `
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
        <polyline points="17 8 12 3 7 8"></polyline>
        <line x1="12" y1="3" x2="12" y2="15"></line>
      </svg>
      <p class="upload-text">CSV 또는 XLSX 파일을 드래그하거나 클릭하여 업로드</p>
      <p class="upload-hint">지원 형식: .csv, .xlsx</p>
    `;
    uploadBox.style.pointerEvents = 'auto';
  }
}

// CSV 파싱
function parseCSV(text) {
  // 줄바꿈 문자 정규화 (Windows \r\n, Mac \r, Linux \n 모두 처리)
  const normalizedText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalizedText.split('\n').filter(line => line.trim());
  
  if (lines.length === 0) {
    throw new Error('CSV 파일이 비어있습니다.');
  }

  // 헤더도 parseCSVLine을 사용하여 따옴표로 감싸진 필드 내부의 쉼표 처리
  const columns = parseCSVLine(lines[0]).map(col => col.trim());
  const data = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    if (values.length === columns.length) {
      const row = {};
      columns.forEach((col, idx) => {
        row[col] = values[idx] || '';
      });
      data.push(row);
    } else {
      // 열 개수가 맞지 않으면 경고 (디버깅용)
      console.warn(`행 ${i + 1}: 예상 열 개수 ${columns.length}, 실제 열 개수 ${values.length}`);
    }
  }

  return { columns, data };
}

// 노코드 작업 기록
function recordOperation(operation) {
  if (!window.operationHistory) {
    window.operationHistory = [];
  }
  window.operationHistory.push({
    ...operation,
    timestamp: Date.now(),
  });
}

// CSV 라인 파싱 (쉼표와 따옴표 처리)
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  
  return result.map(val => val.replace(/^"|"$/g, ''));
}

// 데이터프레임 정보 계산
function calculateDataFrameInfo(data, columns) {
  const rowCount = data.length;
  const colCount = columns.length;

  const columnInfo = columns.map(col => {
    const values = data.map(row => row[col]);
    const validValues = values.filter(v => v !== null && v !== undefined && v !== '');
    const validCount = validValues.length;
    
    // 숫자형 값 추출
    const numericValues = validValues.map(v => parseFloat(v)).filter(v => !isNaN(v));
    const isNumeric = numericValues.length > 0 && numericValues.length === validCount;
    
    // 데이터형 판단 (수치/범주)
    let dataType = '범주';
    let categoryType = 'object';
    
    if (isNumeric) {
      dataType = '수치';
      // 정수인지 확인
      if (numericValues.every(v => Number.isInteger(v))) {
        categoryType = 'int64';
      } else {
        categoryType = 'float64';
      }
    } else if (validValues.length > 0) {
      const firstValue = validValues[0];
      if (firstValue === 'true' || firstValue === 'false' || 
          firstValue === 'True' || firstValue === 'False') {
        categoryType = 'bool';
      } else {
        categoryType = 'object';
      }
    }

    // 통계 정보 계산 (수치형인 경우만)
    let stats = {
      mean: null,
      std: null,
      max: null,
      median: null,
      min: null
    };

    if (isNumeric && numericValues.length > 0) {
      const sorted = [...numericValues].sort((a, b) => a - b);
      
      // 평균
      stats.mean = numericValues.reduce((a, b) => a + b, 0) / numericValues.length;
      
      // 표준 편차
      const mean = stats.mean;
      const variance = numericValues.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / numericValues.length;
      stats.std = Math.sqrt(variance);
      
      // 최댓값
      stats.max = sorted[sorted.length - 1];
      
      // 중앙값
      const mid = Math.floor(sorted.length / 2);
      stats.median = sorted.length % 2 === 0 
        ? (sorted[mid - 1] + sorted[mid]) / 2 
        : sorted[mid];
      
      // 최솟값
      stats.min = sorted[0];
    }

    return {
      name: col,
      validCount: validCount,
      dataType: dataType,
      categoryType: categoryType,
      isNumeric: isNumeric,
      stats: stats
    };
  });

  return {
    rowRange: `0 ~ ${rowCount - 1}`,
    rowCount: rowCount,
    colCount: colCount,
    columns: columnInfo
  };
}

// 데이터프레임 정보 렌더링
function renderDataFrameInfo(info, container) {
  if (!container) return;

  container.innerHTML = `
    <div class="info-row">
      <div class="info-item">
        <span class="info-label">행 개수</span>
        <span class="info-value">${info.rowCount}행</span>
      </div>
      <div class="info-item">
        <span class="info-label">열 개수</span>
        <span class="info-value">${info.colCount}개</span>
      </div>
    </div>
    <div class="info-item full-width">
      <span class="info-label">데이터 통계</span>
      <div class="column-table-container">
        <table class="column-info-table">
          <thead>
            <tr>
              <th>열별</th>
              <th>평균</th>
              <th>표준 편차</th>
              <th>최댓값</th>
              <th>중앙값</th>
              <th>최솟값</th>
              <th>값의 개수</th>
              <th>데이터형</th>
            </tr>
          </thead>
          <tbody>
            ${info.columns.map(col => {
              const mean = col.stats.mean !== null ? col.stats.mean.toFixed(4) : '-';
              const std = col.stats.std !== null ? col.stats.std.toFixed(4) : '-';
              const max = col.stats.max !== null ? col.stats.max.toFixed(4) : '-';
              const median = col.stats.median !== null ? col.stats.median.toFixed(4) : '-';
              const min = col.stats.min !== null ? col.stats.min.toFixed(4) : '-';
              
              return `
                <tr>
                  <td class="column-name-cell">${escapeHtml(col.name)}</td>
                  <td>${mean}</td>
                  <td>${std}</td>
                  <td>${max}</td>
                  <td>${median}</td>
                  <td>${min}</td>
                  <td>${col.validCount} / ${info.rowCount}</td>
                  <td>${col.dataType} (${col.categoryType})</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// 데이터 테이블 렌더링
function renderDataTable(data, columns, container) {
  if (!container) return;

  // 처음 5개 행만 표시하고 나머지는 스크롤로 확인
  const initialRows = 5;
  const displayData = data; // 전체 데이터를 렌더링하되, 처음 5개 행만 보이도록 CSS로 제어

  let tableHTML = `
    <table class="data-table">
      <thead>
        <tr>
          ${columns.map(col => `<th>${escapeHtml(col)}</th>`).join('')}
        </tr>
      </thead>
      <tbody>
  `;

  displayData.forEach((row, idx) => {
    tableHTML += '<tr>';
    columns.forEach(col => {
      const value = row[col] || '';
      tableHTML += `<td>${escapeHtml(String(value))}</td>`;
    });
    tableHTML += '</tr>';
  });

  tableHTML += `
      </tbody>
    </table>
  `;

  if (data.length > initialRows) {
    tableHTML += `<p class="table-note">※ 처음 ${initialRows}개 행이 표시됩니다. 스크롤하여 나머지 ${data.length - initialRows}개 행을 확인하세요. (전체 ${data.length}행)</p>`;
  }

  container.innerHTML = tableHTML;
}

// 메모리에 있는 노코드 상태로 화면 복원
function restoreNoCodeFromMemory() {
  if (!window.currentData || !window.currentColumns) return;

  const data = window.currentData;
  const columns = window.currentColumns;

  const dataTableContainer = document.getElementById('dataTableContainer');
  const dataInfoGrid = document.getElementById('dataInfoGrid');
  const dataTableSection = document.getElementById('dataTableSection');
  const dataInfoSection = document.getElementById('dataInfoSection');
  const preprocessingSection = document.getElementById('preprocessingSection');

  if (dataTableContainer && dataInfoGrid) {
    const info = calculateDataFrameInfo(data, columns);
    renderDataTable(data, columns, dataTableContainer);
    renderDataFrameInfo(info, dataInfoGrid);
  }

  if (dataTableSection) dataTableSection.style.display = 'block';
  if (dataInfoSection) dataInfoSection.style.display = 'block';
  if (preprocessingSection) preprocessingSection.style.display = 'block';

  // 핵심 속성 추출 섹션 표시 및 속성 선택 리스트 초기화
  const featureExtractionSection = document.getElementById('featureExtractionSection');
  if (featureExtractionSection) {
    featureExtractionSection.style.display = 'block';
    initializeFeatureSelection(columns);
  }

  // 모델 생성 섹션 표시
  const modelSection = document.getElementById('modelSection');
  if (modelSection && columns) {
    modelSection.style.display = 'block';
    initializeModelSection(columns);
  }

  // 그래프 UI 복원
  restoreChartsFromMemory();
}

// 모드 전환
function switchMode(mode) {
  if (currentMode === mode) return;
  
  currentMode = mode;
  
  // 버튼 활성화 상태 업데이트
  const nocodeModeBtn = document.getElementById('nocodeModeBtn');
  const codeModeBtn = document.getElementById('codeModeBtn');
  const editorContent = document.getElementById('editorContent');
  
  if (nocodeModeBtn && codeModeBtn) {
    if (mode === 'nocode') {
      nocodeModeBtn.classList.add('active');
      codeModeBtn.classList.remove('active');
    } else {
      nocodeModeBtn.classList.remove('active');
      codeModeBtn.classList.add('active');
    }
  }
  
  // 에디터 콘텐츠 업데이트
  if (editorContent) {
    editorContent.innerHTML = mode === 'nocode' 
      ? renderNoCodeEditor() 
      : renderCodeEditor();

    // 새로 렌더링된 DOM에 이벤트 다시 연결
    if (mode === 'nocode') {
      setupFileUpload();
      setupPreprocessing();
      // 메모리에 저장된 데이터/전처리 결과 복원
      restoreNoCodeFromMemory();
    } else if (mode === 'code') {
      // 코드 에디터 셀 이벤트 연결
      setupCodeEditorEvents();
    }
  }
  
  console.log('모드 전환:', mode);
}

// 현재 상태를 가져오는 함수
function getCurrentState() {
  return {
    nocodeState: {
      data: window.currentData || null,
      columns: window.currentColumns || null,
      originalFileName: window.originalFileName || null,
      operationHistory: window.operationHistory || [],
      chartConfigs: window.chartConfigs || [],
      selectedFeatures: window.selectedFeatures || [],
      featureExtractionState: window.featureExtractionState || { pairplotGenerated: false, heatmapGenerated: false },
      modelConfig: window.modelConfig || null,
    },
    codeState: {
      generatedCodeCells: window.generatedCodeCells || [],
    },
    mode: currentMode,
  };
}

// 상태 비교 함수 (깊은 비교)
function statesAreEqual(state1, state2) {
  if (!state1 || !state2) return false;
  
  // nocodeState 비교
  const nocode1 = state1.nocodeState || {};
  const nocode2 = state2.nocodeState || {};
  
  // 데이터 비교 (간단한 JSON 문자열 비교)
  const data1 = JSON.stringify(nocode1.data);
  const data2 = JSON.stringify(nocode2.data);
  if (data1 !== data2) return false;
  
  // columns 비교
  const cols1 = JSON.stringify(nocode1.columns || []);
  const cols2 = JSON.stringify(nocode2.columns || []);
  if (cols1 !== cols2) return false;
  
  // originalFileName 비교
  if (nocode1.originalFileName !== nocode2.originalFileName) return false;
  
  // operationHistory 비교
  const ops1 = JSON.stringify(nocode1.operationHistory || []);
  const ops2 = JSON.stringify(nocode2.operationHistory || []);
  if (ops1 !== ops2) return false;
  
  // chartConfigs 비교
  const charts1 = JSON.stringify(nocode1.chartConfigs || []);
  const charts2 = JSON.stringify(nocode2.chartConfigs || []);
  if (charts1 !== charts2) return false;
  
  // selectedFeatures 비교
  const features1 = JSON.stringify(nocode1.selectedFeatures || []);
  const features2 = JSON.stringify(nocode2.selectedFeatures || []);
  if (features1 !== features2) return false;
  
  // featureExtractionState 비교
  const featState1 = JSON.stringify(nocode1.featureExtractionState || {});
  const featState2 = JSON.stringify(nocode2.featureExtractionState || {});
  if (featState1 !== featState2) return false;
  
  // modelConfig 비교
  const model1 = JSON.stringify(nocode1.modelConfig || null);
  const model2 = JSON.stringify(nocode2.modelConfig || null);
  if (model1 !== model2) return false;
  
  // codeState 비교
  const code1 = JSON.stringify(state1.codeState?.generatedCodeCells || []);
  const code2 = JSON.stringify(state2.codeState?.generatedCodeCells || []);
  if (code1 !== code2) return false;
  
  // mode 비교
  if (state1.mode !== state2.mode) return false;
  
  return true;
}

// 저장 버튼 색상 업데이트
function updateSaveButtonColor() {
  const saveBtn = document.getElementById('saveProjectBtn');
  if (!saveBtn) return;
  
  const currentState = getCurrentState();
  const hasChanges = !lastSavedState || !statesAreEqual(currentState, lastSavedState);
  
  if (hasChanges) {
    // 변경사항이 있으면 파스텔 주황색
    saveBtn.style.backgroundColor = '#ffb380'; // pastel orange
    saveBtn.style.borderColor = '#ffb380';
    saveBtn.style.color = '#ffffff'; // 흰색 글씨
    saveBtn.classList.add('has-changes');
  } else {
    // 변경사항이 없으면 파스텔 초록색
    saveBtn.style.backgroundColor = '#90d4a3'; // pastel green
    saveBtn.style.borderColor = '#90d4a3';
    saveBtn.style.color = '#ffffff'; // 흰색 글씨
    saveBtn.classList.remove('has-changes');
  }
}

// 프로젝트 상태 저장
async function handleSaveProject() {
  if (!currentUser || !currentProjectId) {
    alert('프로젝트 정보를 불러오는 중입니다. 잠시 후 다시 시도해주세요.');
    return;
  }

  const saveBtn = document.getElementById('saveProjectBtn');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = '저장 중...';
  }

  try {
    await runTransaction(db, async (transaction) => {
      const projectRef = doc(db, 'projects', currentProjectId);
      const projectSnap = await transaction.get(projectRef);

      if (!projectSnap.exists()) {
        throw new Error('프로젝트를 찾을 수 없습니다.');
      }

      const prevData = projectSnap.data() || {};
      const prevSettings = prevData.settings || {};

      const nocodeState = {
        data: window.currentData || null,
        columns: window.currentColumns || null,
        originalFileName: window.originalFileName || null,
        operationHistory: window.operationHistory || [],
        chartConfigs: window.chartConfigs || [],
        selectedFeatures: window.selectedFeatures || [],
        featureExtractionState: window.featureExtractionState || { pairplotGenerated: false, heatmapGenerated: false },
        modelConfig: window.modelConfig || null,
      };

      const codeState = {
        generatedCodeCells: window.generatedCodeCells || [],
      };

      transaction.update(projectRef, {
        settings: {
          ...prevSettings,
          mode: currentMode,
        },
        nocodeState,
        codeState,
        updatedAt: serverTimestamp(),
      });
    });

    // 저장 성공 후 마지막 저장 상태 업데이트
    lastSavedState = getCurrentState();
    updateSaveButtonColor();
    
    alert('프로젝트가 성공적으로 저장되었습니다.');
  } catch (error) {
    console.error('프로젝트 저장 오류:', error);
    alert(`프로젝트 저장 중 오류가 발생했습니다: ${error.message}`);
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = '저장';
    }
  }
}

// 노코드 상태를 기반으로 Python 코드 셀 생성
function buildPythonCellsFromState() {
  const cells = [];

  const fileName = window.originalFileName || 'your_data.csv';
  // Pyodide 가상 파일 시스템에서 사용할 경로를 고정 (/data/파일명)
  const dataPath = `/data/${fileName}`;
  window.pyodideDataPath = dataPath;
  cells.push(
    [
      '# 1. 데이터 불러오기',
      'import pandas as pd',
      '',
      `# 노코드 에디터에서 업로드한 파일명: ${fileName}`,
      `# 이 에디터 안에서는 업로드한 데이터가 "${dataPath}" 경로에 저장되어 있습니다.`,
      `df = pd.read_csv("${dataPath}")`,
      '',
      'df.head()',
    ].join('\n'),
  );

  const operations = Array.isArray(window.operationHistory)
    ? window.operationHistory
    : [];

  let stepOffset = 2;

  operations
    .filter((op) => op.type !== 'load_data')
    .forEach((op, idx) => {
      switch (op.type) {
        case 'missing': {
          const cols = op.columns?.join(', ') || '';
          const strategy = op.strategy || 'mean';
          let code = [
            `# ${idx + stepOffset}. 결측치 처리 (${strategy})`,
            '# 노코드 에디터에서 선택한 열과 전략을 기반으로 생성된 코드입니다.',
          ];
          if (strategy === 'drop') {
            code.push(
              `df = df.dropna(subset=[${cols
                .split(', ')
                .map((c) => `"${c}"`)
                .join(', ')}])`,
            );
          } else {
            code.push(
              `for col in [${cols
                .split(', ')
                .map((c) => `"${c}"`)
                .join(', ')}]:`,
              `    df[col] = df[col].fillna(df[col].${strategy}())`,
            );
          }
          cells.push(code.join('\n'));
          break;
        }
        case 'outlier': {
          const cols = op.columns?.join(', ') || '';
          const method = op.detection || 'iqr';
          const action = op.action || 'dropRow';
          const code = [
            `# ${idx + stepOffset}. 이상치 처리 (${method}, ${action})`,
            '# 실제 데이터 환경에 맞게 임계값이나 처리 로직을 조정해 사용하세요.',
            `numeric_cols = [${cols
              .split(', ')
              .map((c) => `"${c}"`)
              .join(', ')}]`,
            '',
            'for col in numeric_cols:',
          ];
          if (method === 'iqr') {
            code.push(
              '    q1 = df[col].quantile(0.25)',
              '    q3 = df[col].quantile(0.75)',
              '    iqr = q3 - q1',
              '    lower = q1 - 1.5 * iqr',
              '    upper = q3 + 1.5 * iqr',
            );
          } else if (method === 'zscore') {
            code.push(
              '    mean = df[col].mean()',
              '    std = df[col].std()',
              '    lower = mean - 3 * std',
              '    upper = mean + 3 * std',
            );
          } else {
            code.push(
              '    lower = df[col].quantile(0.01)',
              '    upper = df[col].quantile(0.99)',
            );
          }

          if (action === 'dropRow') {
            code.push(
              '    df = df[(df[col] >= lower) & (df[col] <= upper)]',
            );
          } else {
            code.push(
              '    df.loc[(df[col] < lower) | (df[col] > upper), col] = pd.NA',
            );
          }

          cells.push(code.join('\n'));
          break;
        }
        case 'normalize': {
          const cols = op.columns?.join(', ') || '';
          const method = op.method || 'minmax';
          const code = [
            `# ${idx + stepOffset}. 정규화 (${method})`,
            `norm_cols = [${cols
              .split(', ')
              .map((c) => `"${c}"`)
              .join(', ')}]`,
          ];
          if (method === 'minmax') {
            code.push(
              'for col in norm_cols:',
              '    min_val = df[col].min()',
              '    max_val = df[col].max()',
              '    df[col] = (df[col] - min_val) / (max_val - min_val)',
            );
          } else {
            code.push(
              'for col in norm_cols:',
              '    mean = df[col].mean()',
              '    std = df[col].std()',
              '    df[col] = (df[col] - mean) / std',
            );
          }
          cells.push(code.join('\n'));
          break;
        }
        default:
          break;
      }
    });

  // 그래프 설정에 대한 코드 셀 추가 (matplotlib 예시)
  const chartConfigs = Array.isArray(window.chartConfigs) ? window.chartConfigs : [];
  if (chartConfigs.length > 0) {
    cells.push(
      [
        `# ${cells.length + 1}. 시각화를 위한 라이브러리 임포트`,
        'import os',
        'import matplotlib.pyplot as plt',
        'from matplotlib import font_manager, rcParams',
        '',
        '# ---- 한글 폰트 설정 (브라우저 환경용) ----',
        "# JavaScript에서 미리 다운로드한 폰트를 사용합니다.",
        "font_path = '/data/NanumGothic-Regular.ttf'",
        "try:",
        "    if os.path.exists(font_path):",
        "        font_manager.fontManager.addfont(font_path)",
        "        rcParams['font.family'] = 'NanumGothic'",
        "        print('✅ 한글 폰트 설정 완료: NanumGothic')",
        "    else:",
        "        print('⚠️ 한글 폰트를 찾을 수 없습니다. 기본 폰트를 사용합니다.')",
        "except Exception as e:",
        "    print(f'⚠️ 한글 폰트 설정 중 오류 발생: {e}')",
        "    print('기본 폰트를 사용합니다.')",
        "rcParams['axes.unicode_minus'] = False  # 마이너스 기호 깨짐 방지",
        '# ---------------------------------------',
      ].join('\n'),
    );

    chartConfigs.forEach((cfg, idx) => {
      if (!cfg || !cfg.xColumn || !cfg.yColumn || !cfg.type) return;

      const base = [
        '',
        `# 그래프 ${idx + 1}: ${cfg.type} (${cfg.xColumn} vs ${cfg.yColumn})`,
        'plt.figure(figsize=(8, 4))',
      ];

      switch (cfg.type) {
        case 'line':
          base.push(
            `plt.plot(df["${cfg.xColumn}"], df["${cfg.yColumn}"], marker='o')`,
            `plt.xlabel("${cfg.xColumn}")`,
            `plt.ylabel("${cfg.yColumn}")`,
            'plt.tight_layout()',
            'plt.show()',
          );
          break;
        case 'bar':
          base.push(
            `plt.bar(df["${cfg.xColumn}"], df["${cfg.yColumn}"])`,
            `plt.xlabel("${cfg.xColumn}")`,
            `plt.ylabel("${cfg.yColumn}")`,
            'plt.tight_layout()',
            'plt.show()',
          );
          break;
        case 'pie':
          base.push(
            `pie_data = df.groupby("${cfg.xColumn}")["${cfg.yColumn}"].sum()`,
            'plt.pie(pie_data.values, labels=pie_data.index, autopct="%1.1f%%")',
            'plt.axis("equal")',
            'plt.tight_layout()',
            'plt.show()',
          );
          break;
        case 'scatter':
          base.push(
            `plt.scatter(df["${cfg.xColumn}"], df["${cfg.yColumn}"], alpha=0.7)`,
            `plt.xlabel("${cfg.xColumn}")`,
            `plt.ylabel("${cfg.yColumn}")`,
            'plt.tight_layout()',
            'plt.show()',
          );
          break;
        case 'histogram':
          base.push(
            `plt.hist(df["${cfg.yColumn}"].dropna(), bins=10, edgecolor="black")`,
            `plt.xlabel("${cfg.yColumn}")`,
            'plt.ylabel("Count")',
            'plt.tight_layout()',
            'plt.show()',
          );
          break;
        default:
          break;
      }

      cells.push(base.join('\n'));
    });
  }

  return cells;
}

// 코드 생성 버튼 처리
function handleGenerateCode() {
  if (!window.currentData || !window.currentColumns) {
    alert('먼저 데이터를 업로드하고 필요한 전처리를 진행해주세요.');
    return;
  }

  // 기존 코드가 있으면 확인
  if (Array.isArray(window.generatedCodeCells) && window.generatedCodeCells.length > 0) {
    const hasContent = window.generatedCodeCells.some(cell => cell.trim().length > 0);
    if (hasContent) {
      if (!confirm('⚠️ 기존 코드가 있습니다.\n\n노코드 조작을 기반으로 코드를 새로 생성하면 기존 코드가 모두 덮어씌워집니다.\n\n계속하시겠습니까?')) {
        return;
      }
    }
  }

  window.generatedCodeCells = buildPythonCellsFromState();
  // 모드를 코드로 전환하면 switchMode 내부에서 코드 에디터 렌더 + 이벤트까지 설정
  switchMode('code');
  
  updateSaveButtonColor();
}

// 챗봇 토글
function toggleChatbot() {
  chatbotOpen = !chatbotOpen;
  const chatbotPanel = document.getElementById('chatbotPanel');
  const chatbotToggle = document.getElementById('chatbotToggle');
  const chatbotHeader = chatbotPanel?.querySelector('.chatbot-header');
  const chatbotContent = document.getElementById('chatbotContent');
  
  if (chatbotPanel) {
    chatbotPanel.classList.toggle('open', chatbotOpen);
    chatbotPanel.classList.toggle('closed', !chatbotOpen);
  }
  
  if (chatbotToggle) {
    chatbotToggle.setAttribute('title', chatbotOpen ? '챗봇 닫기' : '챗봇 열기');
    const svg = chatbotToggle.querySelector('svg');
    if (svg) {
      svg.innerHTML = chatbotOpen 
        ? '<path d="M9 18l6-6-6-6"/>' 
        : '<path d="M15 18l-6-6 6-6"/>';
    }
  }
  
  // 헤더에 제목 표시/숨김
  if (chatbotHeader) {
    const title = chatbotHeader.querySelector('h3');
    const headerRight = chatbotHeader.querySelector('.chatbot-header-right');
    if (chatbotOpen) {
      if (!title) {
        const h3 = document.createElement('h3');
        h3.textContent = 'AI 챗봇';
        chatbotToggle.insertAdjacentElement('afterend', h3);
      }
      if (headerRight) {
        headerRight.style.display = 'flex';
      }
    } else {
      if (title) {
        title.remove();
      }
      if (headerRight) {
        headerRight.style.display = 'none';
      }
    }
  }
  
  // 콘텐츠 표시/숨김
  if (chatbotContent) {
    if (chatbotOpen) {
      chatbotContent.style.display = 'flex';
    } else {
      chatbotContent.style.display = 'none';
    }
  }
}

// 간단한 마크다운(**bold**, 코드 블록) 렌더링 함수
function renderChatMarkdown(text) {
  if (!text) return '';
  
  // 코드 블록 먼저 처리 (```언어\n코드```, ```언어 코드```, ```코드```) - 임시 플레이스홀더로 치환
  const codeBlockPlaceholders = [];
  let processed = text.replace(/```(\w+)?\s*\n?([\s\S]*?)```/g, (match, lang, code) => {
    const placeholder = `__CODE_BLOCK_${codeBlockPlaceholders.length}__`;
    const language = lang ? lang.trim() : '';
    const codeContent = code.trim();
    codeBlockPlaceholders.push({
      language: escapeHtml(language),
      code: escapeHtml(codeContent),
      rawCode: codeContent, // 복사용 원본 코드 (언어 태그 제외)
    });
    return placeholder;
  });
  
  // 인라인 코드 처리 (`코드`)
  processed = processed.replace(/`([^`]+)`/g, '<code class="chatbot-inline-code">$1</code>');
  
  // HTML 이스케이프
  let escaped = processed
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  
  // 코드 블록 플레이스홀더를 실제 HTML로 복원 (복사 버튼 포함)
  codeBlockPlaceholders.forEach((block, idx) => {
    const placeholder = `__CODE_BLOCK_${idx}__`;
    const blockId = `code-block-${Date.now()}-${idx}`;
    escaped = escaped.replace(
      placeholder,
      `<div class="chatbot-code-block-wrapper">
        <div class="chatbot-code-block-header">
          ${block.language ? `<span class="chatbot-code-lang">${block.language}</span>` : ''}
          <button class="chatbot-code-copy-btn" data-code-id="${blockId}" title="코드 복사">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            <span>복사</span>
          </button>
        </div>
        <pre class="chatbot-code-block" data-code-id="${blockId}" data-raw-code="${escapeHtml(block.rawCode)}"><code>${block.code}</code></pre>
      </div>`
    );
  });
  
  // **굵게** 처리
  escaped = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  
  return escaped;
}

// 크레딧 뱃지 UI 업데이트
function updateChatbotCreditsUI() {
  const el = document.getElementById('chatbotCreditsValue');
  if (!el) return;

  if (currentCredits === null || Number.isNaN(currentCredits)) {
    el.textContent = '-';
    return;
  }

  el.textContent = currentCredits;
}

// Firestore에서 현재 사용자 크레딧 조회 (문서가 없으면 250으로 간주)
async function fetchUserCredits() {
  if (!currentUser) return;

  try {
    const userRef = doc(db, 'users', currentUser.uid);
    const snap = await getDoc(userRef);

    if (!snap.exists()) {
      currentCredits = 250;
    } else {
      const data = snap.data() || {};
      const credits =
        typeof data.credits === 'number' && data.credits >= 0
          ? data.credits
          : 250;
      currentCredits = credits;
    }

    updateChatbotCreditsUI();
  } catch (error) {
    console.error('크레딧 불러오기 오류:', error);
  }
}

// Firestore에서 채팅 1회당 크레딧 1 차감
// - 최초 호출 시: users/{uid} 문서가 없으면 250에서 1을 사용했다고 보고 249로 생성
// - 이후: credits > 0 이면 1 차감, 0 이하이면 실패
async function consumeChatCredit() {
  if (!currentUser) {
    return { ok: false, reason: 'no_user' };
  }

  const userRef = doc(db, 'users', currentUser.uid);
  let newCredits = null;

  try {
    await runTransaction(db, async (transaction) => {
      const userSnap = await transaction.get(userRef);

      if (!userSnap.exists()) {
        // 첫 사용: 250 크레딧 중 1개 사용
        const initialCredits = 250;
        const after = initialCredits - 1;
        newCredits = after;
        transaction.set(userRef, {
          email: currentUser.email || '',
          credits: after,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        return;
      }

      const data = userSnap.data() || {};
      const currentCredits = typeof data.credits === 'number' ? data.credits : 0;

      if (currentCredits <= 0) {
        throw new Error('NO_CREDITS');
      }

      const after = currentCredits - 1;
      newCredits = after;
      transaction.update(userRef, {
        credits: after,
        updatedAt: serverTimestamp(),
      });
    });

    currentCredits = newCredits;
    updateChatbotCreditsUI();
    return { ok: true, credits: newCredits };
  } catch (error) {
    if (error.message === 'NO_CREDITS') {
      currentCredits = 0;
      updateChatbotCreditsUI();
      return { ok: false, reason: 'no_credits' };
    }

    console.error('크레딧 차감 오류:', error);
    return { ok: false, reason: 'error' };
  }
}

// 챗봇 메시지 전송
async function handleChatbotSend() {
  const chatbotInput = document.getElementById('chatbotInput');
  const chatbotMessages = document.getElementById('chatbotMessages');
  
  if (!chatbotInput || !chatbotMessages) return;
  
  const message = chatbotInput.value.trim();
  if (!message) return;
  
  // 사용자 메시지 표시 및 저장
  addChatbotMessage('user', message);
  
  // 입력 필드 초기화
  chatbotInput.value = '';
  chatbotInput.style.height = 'auto';

  // 크레딧 차감
  const creditResult = await consumeChatCredit();
  if (!creditResult.ok) {
    if (creditResult.reason === 'no_credits') {
      const noCreditsMsg = '이 계정의 크레딧이 모두 소진되어 더 이상 질문할 수 없습니다.\n선생님께 추가 크레딧을 요청하세요.';
      addChatbotMessage('bot', noCreditsMsg);
      await saveChatMessage('bot', noCreditsMsg);
    } else {
      const errorMsg = '크레딧을 확인하는 도중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.';
      addChatbotMessage('bot', errorMsg);
      await saveChatMessage('bot', errorMsg);
    }
    return;
  }

  // 로딩 메시지 표시
  const loadingId = `loading-${Date.now()}`;
  addChatbotMessage('bot', '생각 중...', loadingId);

  try {
    // 이전 대화 내용 가져오기
    const projectData = await loadProject(currentProjectId);
    const chatHistory = projectData.chatHistory || [];
    
    // 시스템 메시지 + 이전 대화 내용 + 현재 사용자 메시지
    const messages = [
      {
        role: 'system',
        content:
          '너는 데이터분석과 그래프 해석, 간단한 코딩을 도와주는 한국어 튜터야. 고등학생이 이해할 수 있는 수준으로 쉽게 설명해 줘.',
      },
    ];
    
    // 이전 대화 내용 추가 (최근 20개만, 너무 많으면 토큰 제한에 걸릴 수 있음)
    const recentHistory = chatHistory.slice(-20);
    recentHistory.forEach((msg) => {
      if (msg.type && msg.text) {
        messages.push({
          role: msg.type === 'user' ? 'user' : 'assistant',
          content: msg.text,
        });
      }
    });
    
    // 현재 사용자 메시지 추가
    messages.push({
      role: 'user',
      content: message,
    });
    
    const response = await fetch('http://localhost:3000/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages,
        hasImage: false, // 현재는 텍스트만. 나중에 이미지 기능 추가 시 true로 보낼 수 있음
      }),
    });

    if (!response.ok) {
      throw new Error('챗봇 서버 오류');
    }

    const data = await response.json();
    const botMessage = data?.message?.content || '응답을 불러오지 못했습니다.';

    // 로딩 메시지 교체
    replaceChatbotMessage(loadingId, botMessage);
    
    // 봇 메시지 저장
    await saveChatMessage('bot', botMessage);
  } catch (error) {
    console.error('챗봇 호출 오류:', error);
    const errorMessage = '챗봇 호출 중 오류가 발생했습니다. 서버가 켜져 있는지 확인해주세요.';
    replaceChatbotMessage(loadingId, errorMessage);
    
    // 에러 메시지도 저장
    await saveChatMessage('bot', errorMessage);
  }
}

// 챗봇 메시지를 Firestore에 저장
async function saveChatMessage(type, text) {
  if (!currentUser || !currentProjectId) {
    console.warn('챗봇 메시지 저장 실패: currentUser 또는 currentProjectId가 없습니다.', {
      hasUser: !!currentUser,
      hasProjectId: !!currentProjectId,
    });
    return;
  }
  
  try {
    const projectRef = doc(db, 'projects', currentProjectId);
    await updateDoc(projectRef, {
      chatHistory: arrayUnion({
        type,
        text,
        timestamp: serverTimestamp(),
      }),
      updatedAt: serverTimestamp(),
    });
    console.log('챗봇 메시지 저장 성공:', { type, textLength: text.length });
  } catch (error) {
    console.error('챗봇 메시지 저장 오류:', error);
    // 저장 실패해도 UI에는 표시되도록 계속 진행
  }
}

// 코드 복사 버튼 이벤트 설정
function setupCodeCopyButtons(messageElement) {
  const copyButtons = messageElement.querySelectorAll('.chatbot-code-copy-btn');
  copyButtons.forEach((btn) => {
    btn.addEventListener('click', async () => {
      const codeId = btn.getAttribute('data-code-id');
      const codeBlock = messageElement.querySelector(`pre[data-code-id="${codeId}"] code`);
      if (!codeBlock) return;
      
      // code 요소의 textContent를 직접 사용 (언어 태그 제외, 전체 코드 복사)
      const codeText = codeBlock.textContent || codeBlock.innerText;
      
      try {
        await navigator.clipboard.writeText(codeText);
        // 복사 성공 피드백
        const originalText = btn.querySelector('span').textContent;
        btn.querySelector('span').textContent = '복사됨!';
        btn.style.color = '#10b981';
        setTimeout(() => {
          btn.querySelector('span').textContent = originalText;
          btn.style.color = '';
        }, 2000);
      } catch (err) {
        console.error('복사 실패:', err);
        // 폴백: 텍스트 영역에 복사
        const textarea = document.createElement('textarea');
        textarea.value = codeText;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        
        const originalText = btn.querySelector('span').textContent;
        btn.querySelector('span').textContent = '복사됨!';
        btn.style.color = '#10b981';
        setTimeout(() => {
          btn.querySelector('span').textContent = originalText;
          btn.style.color = '';
        }, 2000);
      }
    });
  });
}

// 챗봇 메시지 추가
function addChatbotMessage(type, text, id, skipSave = false) {
  const chatbotMessages = document.getElementById('chatbotMessages');
  if (!chatbotMessages) return;
  
  const messageDiv = document.createElement('div');
  messageDiv.className = `chatbot-message ${type}`;
  if (id) {
    messageDiv.dataset.id = id;
  }
  messageDiv.innerHTML = renderChatMarkdown(text);
  
  chatbotMessages.appendChild(messageDiv);
  chatbotMessages.scrollTop = chatbotMessages.scrollHeight;
  
  // 코드 복사 버튼 이벤트 설정
  setupCodeCopyButtons(messageDiv);
  
  // Firestore에 저장 (로딩 메시지와 skipSave가 true인 경우 제외)
  if (!skipSave && !id?.startsWith('loading-')) {
    saveChatMessage(type, text);
  }
}

// 특정 메시지 교체 (로딩 → 실제 응답)
function replaceChatbotMessage(id, newText) {
  const chatbotMessages = document.getElementById('chatbotMessages');
  if (!chatbotMessages) return;

  const target = chatbotMessages.querySelector(`.chatbot-message[data-id="${id}"]`);
  if (!target) {
    addChatbotMessage('bot', newText);
    return;
  }

  target.innerHTML = renderChatMarkdown(newText);
  
  // 코드 복사 버튼 이벤트 설정
  setupCodeCopyButtons(target);
}

// 프로젝트 데이터 불러오기
async function loadProject(projectId) {
  try {
    const docRef = doc(db, 'projects', projectId);
    const docSnap = await getDoc(docRef);
    
    if (docSnap.exists()) {
      const data = docSnap.data();
      return {
        id: docSnap.id,
        name: data.name || '이름 없음',
        ...data
      };
    } else {
      throw new Error('프로젝트를 찾을 수 없습니다.');
    }
  } catch (error) {
    console.error('프로젝트 불러오기 오류:', error);
    throw error;
  }
}

// 저장된 프로젝트 상태 복원
function restoreProjectState(projectData) {
  if (!projectData) return;

  const nocodeState = projectData.nocodeState;
  if (nocodeState && nocodeState.data && nocodeState.columns) {
    window.currentData = nocodeState.data;
    window.currentColumns = nocodeState.columns;
    window.originalFileName = nocodeState.originalFileName || null;
    window.operationHistory = nocodeState.operationHistory || [];
    window.chartConfigs = nocodeState.chartConfigs || [];
    window.selectedFeatures = nocodeState.selectedFeatures || [];
    window.featureExtractionState = nocodeState.featureExtractionState || { pairplotGenerated: false, heatmapGenerated: false };
    window.modelConfig = nocodeState.modelConfig || null;

    const dataTableContainer = document.getElementById('dataTableContainer');
    const dataInfoGrid = document.getElementById('dataInfoGrid');
    const dataTableSection = document.getElementById('dataTableSection');
    const dataInfoSection = document.getElementById('dataInfoSection');
    const preprocessingSection = document.getElementById('preprocessingSection');

    if (dataTableContainer && dataInfoGrid) {
      const info = calculateDataFrameInfo(window.currentData, window.currentColumns);
      renderDataTable(window.currentData, window.currentColumns, dataTableContainer);
      renderDataFrameInfo(info, dataInfoGrid);
    }

    if (dataTableSection) dataTableSection.style.display = 'block';
    if (dataInfoSection) dataInfoSection.style.display = 'block';
    if (preprocessingSection) preprocessingSection.style.display = 'block';

    // 핵심 속성 추출 섹션 표시 및 속성 선택 리스트 초기화
    const featureExtractionSection = document.getElementById('featureExtractionSection');
    if (featureExtractionSection && window.currentColumns) {
      featureExtractionSection.style.display = 'block';
      initializeFeatureSelection(window.currentColumns);
      
      // 저장된 pairplot/히트맵 복원
      if (window.featureExtractionState) {
        if (window.featureExtractionState.pairplotGenerated && window.selectedFeatures && window.selectedFeatures.length >= 2) {
          // pairplot 복원 (약간의 지연을 두어 DOM이 준비된 후 실행)
          setTimeout(() => {
            handleGeneratePairplot();
          }, 100);
        }
        if (window.featureExtractionState.heatmapGenerated && window.selectedFeatures && window.selectedFeatures.length >= 2) {
          // 히트맵 복원 (약간의 지연을 두어 DOM이 준비된 후 실행)
          setTimeout(() => {
            handleGenerateHeatmap();
          }, 200);
        }
      }
    }

    // 저장된 그래프 설정이 있다면 복원
    if (Array.isArray(window.chartConfigs) && window.chartConfigs.length > 0) {
      restoreChartsFromMemory();
    }

    // 모델 생성 섹션 표시 및 복원
    const modelSection = document.getElementById('modelSection');
    if (modelSection && window.currentColumns) {
      modelSection.style.display = 'block';
      initializeModelSection(window.currentColumns);
      
      // 저장된 모델 학습 결과가 있으면 복원
      if (window.modelConfig && window.modelConfig.algorithm) {
        setTimeout(() => {
          // 모델 학습 결과 표시
          const resultsDiv = document.getElementById('modelResults');
          if (resultsDiv && window.modelConfig) {
            const config = window.modelConfig;
            const isClustering = config.algorithm === 'kmeans';
            let resultHTML = `
              <div class="model-result-content">
                <h5 class="result-title">학습 완료</h5>
                <div class="result-info">
                  <p><strong>알고리즘:</strong> ${getAlgorithmName(config.algorithm)}</p>
                  ${!isClustering ? `
                    ${config.dependentVariable ? `<p><strong>종속 변수:</strong> ${escapeHtml(config.dependentVariable)}</p>` : ''}
                    ${config.independentVariables && config.independentVariables.length > 0 ? `<p><strong>독립 변수:</strong> ${config.independentVariables.map(v => escapeHtml(v)).join(', ')}</p>` : ''}
                  ` : ''}
                  <p><strong>훈련 데이터 비율:</strong> ${(config.trainRatio * 100).toFixed(0)}%</p>
                  <p><strong>테스트 데이터 비율:</strong> ${((1 - config.trainRatio) * 100).toFixed(0)}%</p>
                </div>
                <div class="model-metrics">
                  <h6>모델 설정</h6>
                  <p>저장된 모델 설정이 복원되었습니다.</p>
                </div>
              </div>
            `;
            resultsDiv.innerHTML = resultHTML;
            resultsDiv.style.display = 'block';
          }
        }, 300);
      }
    }
  }

  const codeState = projectData.codeState;
  if (codeState && Array.isArray(codeState.generatedCodeCells)) {
    window.generatedCodeCells = codeState.generatedCodeCells;

    if (currentMode === 'code') {
      const editorContent = document.getElementById('editorContent');
      if (editorContent) {
        editorContent.innerHTML = renderCodeEditor();
      }
    }
  }

  // 챗봇 대화 내용 복원
  const chatHistory = projectData.chatHistory;
  if (Array.isArray(chatHistory) && chatHistory.length > 0) {
    console.log('챗봇 대화 내용 복원 시작:', chatHistory.length, '개 메시지');
    
    // DOM이 완전히 렌더링될 때까지 여러 번 시도
    let attempts = 0;
    const maxAttempts = 10;
    
    const tryRestoreChat = () => {
      const chatbotMessages = document.getElementById('chatbotMessages');
      if (chatbotMessages) {
        // 기존 메시지 초기화
        chatbotMessages.innerHTML = '';
        
        // 저장된 대화 내용을 시간순으로 복원
        chatHistory.forEach((msg) => {
          if (msg.type && msg.text) {
            addChatbotMessage(msg.type, msg.text, null, true); // skipSave=true로 저장하지 않음
          }
        });
        
        console.log('챗봇 대화 내용 복원 완료');
        
        // 스크롤을 맨 아래로
        setTimeout(() => {
          chatbotMessages.scrollTop = chatbotMessages.scrollHeight;
        }, 100);
      } else if (attempts < maxAttempts) {
        attempts++;
        setTimeout(tryRestoreChat, 100);
      } else {
        console.warn('chatbotMessages 요소를 찾을 수 없습니다. (최대 시도 횟수 초과)');
      }
    };
    
    // 첫 시도
    setTimeout(tryRestoreChat, 100);
  } else {
    console.log('복원할 챗봇 대화 내용이 없습니다.');
  }
  
  // 마지막 저장 상태 초기화 (복원된 상태로 설정)
  lastSavedState = getCurrentState();
  
  // 저장 버튼 색상 업데이트
  setTimeout(() => {
    updateSaveButtonColor();
  }, 200);
}
// HTML 이스케이프
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// 단일 상자 그림 그리기 (각 속성별로)
function drawSingleBoxPlot(ctx, canvas, boxData) {
  if (!boxData) {
    console.error('상자 그림 데이터가 없습니다.');
    return;
  }

  const width = canvas.width;
  const height = canvas.height;
  const padding = { top: 40, right: 40, bottom: 60, left: 80 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const boxWidth = 120;
  const boxX = padding.left + plotWidth / 2 - boxWidth / 2;

  // 배경 지우기
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  // Y축 범위 계산 (각 속성의 데이터 범위에 맞춤)
  const allValues = boxData.allValues;
  let minVal = Math.min(...allValues);
  let maxVal = Math.max(...allValues);
  
  // 이상치도 포함하여 범위 계산
  if (boxData.outliers.length > 0) {
    minVal = Math.min(minVal, ...boxData.outliers);
    maxVal = Math.max(maxVal, ...boxData.outliers);
  }
  
  const range = maxVal - minVal;
  if (range === 0) {
    minVal -= 1;
    maxVal += 1;
  } else {
    minVal -= range * 0.1;
    maxVal += range * 0.1;
  }
  const valueRange = maxVal - minVal;

  // Y축 그리기
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top);
  ctx.lineTo(padding.left, height - padding.bottom);
  ctx.stroke();

  // Y축 눈금 및 레이블
  for (let i = 0; i <= 5; i++) {
    const y = padding.top + (plotHeight * (1 - i / 5));
    const value = minVal + (valueRange * i / 5);
    
    ctx.beginPath();
    ctx.moveTo(padding.left - 5, y);
    ctx.lineTo(padding.left, y);
    ctx.stroke();
    
    ctx.fillStyle = '#666';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(value.toFixed(2), padding.left - 10, y + 4);
  }

  // 상자 그림 그리기
  const yMin = padding.top + plotHeight * (1 - (boxData.min - minVal) / valueRange);
  const yMax = padding.top + plotHeight * (1 - (boxData.max - minVal) / valueRange);
  const yQ1 = padding.top + plotHeight * (1 - (boxData.q1 - minVal) / valueRange);
  const yMedian = padding.top + plotHeight * (1 - (boxData.median - minVal) / valueRange);
  const yQ3 = padding.top + plotHeight * (1 - (boxData.q3 - minVal) / valueRange);

  // 수염 (whisker)
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 2;
  ctx.beginPath();
  // 하단 수염
  ctx.moveTo(boxX + boxWidth / 2, yMin);
  ctx.lineTo(boxX + boxWidth / 2, yQ1);
  // 상단 수염
  ctx.moveTo(boxX + boxWidth / 2, yQ3);
  ctx.lineTo(boxX + boxWidth / 2, yMax);
  // 수염 끝단 가로선
  ctx.moveTo(boxX + boxWidth / 2 - 10, yMin);
  ctx.lineTo(boxX + boxWidth / 2 + 10, yMin);
  ctx.moveTo(boxX + boxWidth / 2 - 10, yMax);
  ctx.lineTo(boxX + boxWidth / 2 + 10, yMax);
  ctx.stroke();

  // 상자
  ctx.fillStyle = 'rgba(102, 126, 234, 0.3)';
  ctx.fillRect(boxX, yQ3, boxWidth, yQ1 - yQ3);
  ctx.strokeStyle = '#667eea';
  ctx.lineWidth = 2;
  ctx.strokeRect(boxX, yQ3, boxWidth, yQ1 - yQ3);

  // 중앙값 선
  ctx.strokeStyle = '#ff6b35';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(boxX, yMedian);
  ctx.lineTo(boxX + boxWidth, yMedian);
  ctx.stroke();

  // 이상치 점
  if (boxData.outliers.length > 0) {
    ctx.fillStyle = '#4285f4';
    boxData.outliers.forEach(outlier => {
      const yOutlier = padding.top + plotHeight * (1 - (outlier - minVal) / valueRange);
      ctx.beginPath();
      ctx.arc(boxX + boxWidth / 2, yOutlier, 4, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  // X축 레이블 (속성 이름)
  ctx.fillStyle = '#333';
  ctx.font = '14px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(boxData.label, width / 2, height - padding.bottom + 30);
}

// 결측치 확인
function handleCheckMissing() {
  if (!window.currentData || !window.currentColumns) {
    alert('먼저 데이터를 업로드해주세요.');
    return;
  }

  const data = window.currentData;
  const columns = window.currentColumns;
  const missingInfo = {};

  columns.forEach(col => {
    const missingCount = data.filter(row => {
      const value = row[col];
      return value === null || value === undefined || value === '' || 
             (typeof value === 'string' && value.trim() === '');
    }).length;
    
    if (missingCount > 0) {
      missingInfo[col] = {
        count: missingCount,
        percentage: ((missingCount / data.length) * 100).toFixed(2)
      };
    }
  });

  const missingDataSection = document.getElementById('missingDataSection');
  const missingDataInfo = document.getElementById('missingDataInfo');
  const resolveMissingBtn = document.getElementById('resolveMissingBtn');

  if (missingDataSection && missingDataInfo) {
    if (Object.keys(missingInfo).length === 0) {
      missingDataInfo.innerHTML = '<p class="success-message">✓ 결측치가 없습니다.</p>';
    } else {
      let html = '<div class="missing-table"><table><thead><tr><th><input type="checkbox" id="selectAllMissing" title="전체 선택"></th><th>열 이름</th><th>결측치 개수</th><th>결측치 비율</th></tr></thead><tbody>';
      Object.entries(missingInfo).forEach(([col, info]) => {
        html += `<tr>
          <td><input type="checkbox" class="missing-column-checkbox" data-column="${escapeHtml(col)}" checked></td>
          <td>${escapeHtml(col)}</td>
          <td>${info.count}개</td>
          <td>${info.percentage}%</td>
        </tr>`;
      });
      html += '</tbody></table></div>';
      missingDataInfo.innerHTML = html;

      // 전체 선택 체크박스 이벤트
      const selectAllCheckbox = document.getElementById('selectAllMissing');
      const columnCheckboxes = document.querySelectorAll('.missing-column-checkbox');
      
      if (selectAllCheckbox) {
        selectAllCheckbox.addEventListener('change', (e) => {
          columnCheckboxes.forEach(cb => {
            cb.checked = e.target.checked;
          });
          updateMissingResolveSection();
        });
      }

      // 개별 체크박스 이벤트
      columnCheckboxes.forEach(cb => {
        cb.addEventListener('change', () => {
          // 전체 선택 체크박스 상태 업데이트
          if (selectAllCheckbox) {
            const allChecked = Array.from(columnCheckboxes).every(c => c.checked);
            const someChecked = Array.from(columnCheckboxes).some(c => c.checked);
            selectAllCheckbox.checked = allChecked;
            selectAllCheckbox.indeterminate = someChecked && !allChecked;
          }
        });
      });
    }
    missingDataSection.style.display = 'block';
  }

  if (resolveMissingBtn) {
    resolveMissingBtn.disabled = Object.keys(missingInfo).length === 0;
  }

  // 전역 변수에 저장
  window.missingInfo = missingInfo;
}

// 결측치 해결 적용
function handleApplyMissing() {
  if (!window.currentData || !window.currentColumns) {
    alert('먼저 데이터를 업로드해주세요.');
    return;
  }

  const selectedColumns = Array.from(document.querySelectorAll('.missing-column-checkbox:checked'))
    .map(cb => cb.getAttribute('data-column'));

  if (selectedColumns.length === 0) {
    alert('결측치를 해결할 열을 선택해주세요.');
    return;
  }

  const strategy = document.querySelector('input[name="missingStrategy"]:checked')?.value;
  if (!strategy) {
    alert('결측치 해결 방법을 선택해주세요.');
    return;
  }

  let data = JSON.parse(JSON.stringify(window.currentData)); // 깊은 복사
  const columns = window.currentColumns;
  let totalRemovedRows = 0;

  // 'drop' 전략인 경우: 선택한 열 중 하나라도 결측치가 있으면 행 삭제
  if (strategy === 'drop') {
    const beforeCount = data.length;
    data = data.filter(row => {
      return selectedColumns.every(col => {
        const val = row[col];
        return val !== null && val !== undefined && val !== '' && 
               !(typeof val === 'string' && val.trim() === '');
      });
    });
    totalRemovedRows = beforeCount - data.length;
  } else {
    // 나머지 전략들: 선택한 각 열에 대해 처리
    selectedColumns.forEach(col => {
      const values = data.map(row => row[col]).filter(v => {
        return v !== null && v !== undefined && v !== '' && 
               !(typeof v === 'string' && v.trim() === '');
      });

      let fillValue = null;

      switch (strategy) {
        case 'mean':
          const numericValues = values.map(v => parseFloat(v)).filter(v => !isNaN(v));
          fillValue = numericValues.length > 0 
            ? (numericValues.reduce((a, b) => a + b, 0) / numericValues.length).toFixed(2)
            : '';
          break;
        case 'median':
          const numericValues2 = values.map(v => parseFloat(v)).filter(v => !isNaN(v)).sort((a, b) => a - b);
          fillValue = numericValues2.length > 0
            ? numericValues2[Math.floor(numericValues2.length / 2)]
            : '';
          break;
        case 'mode':
          const freq = {};
          values.forEach(v => { freq[v] = (freq[v] || 0) + 1; });
          fillValue = Object.keys(freq).reduce((a, b) => freq[a] > freq[b] ? a : b, '');
          break;
        case 'forward':
          let lastValue = '';
          data = data.map(row => {
            const val = row[col];
            if (val === null || val === undefined || val === '' || 
                (typeof val === 'string' && val.trim() === '')) {
              row[col] = lastValue;
            } else {
              lastValue = val;
            }
            return row;
          });
          return; // forward fill은 이미 처리됨
      }

      if (fillValue !== null) {
        data = data.map(row => {
          const val = row[col];
          if (val === null || val === undefined || val === '' || 
              (typeof val === 'string' && val.trim() === '')) {
            row[col] = fillValue;
          }
          return row;
        });
      }
    });
  }

  // 데이터 업데이트
  window.currentData = data;

  // 테이블 및 정보 다시 렌더링
  const dataTableContainer = document.getElementById('dataTableContainer');
  const dataInfoGrid = document.getElementById('dataInfoGrid');
  
  if (dataTableContainer) {
    renderDataTable(data, columns, dataTableContainer);
  }
  
  if (dataInfoGrid) {
    const dataInfo = calculateDataFrameInfo(data, columns);
    renderDataFrameInfo(dataInfo, dataInfoGrid);
  }

  let message = `결측치 처리가 완료되었습니다.`;
  if (totalRemovedRows > 0) {
    message += ` (${totalRemovedRows}개 행 삭제)`;
  }
  message += ` (현재 ${data.length}행)`;
  alert(message);
  
  // 결측치 다시 확인
  handleCheckMissing();

  // 작업 기록
  recordOperation({
    type: 'missing',
    columns: selectedColumns,
    strategy,
  });
}

// 이상치 확인 (상자 그림)
async function handleCheckOutlier() {
  if (!window.currentData || !window.currentColumns) {
    alert('먼저 데이터를 업로드해주세요.');
    return;
  }

  const data = window.currentData;
  const columns = window.currentColumns;
  
  // 숫자형 열만 필터링
  const numericColumns = columns.filter(col => {
    const values = data.map(row => parseFloat(row[col])).filter(v => !isNaN(v));
    return values.length > 0;
  });

  if (numericColumns.length === 0) {
    alert('숫자형 데이터가 없어 이상치를 확인할 수 없습니다.');
    return;
  }

  const container = document.getElementById('boxPlotContainer');
  if (!container) {
    console.error('상자 그림 컨테이너를 찾을 수 없습니다.');
    return;
  }

  // 컨테이너 초기화
  container.innerHTML = '';

  // 이상치가 있는 열만 필터링
  const columnsWithOutliers = [];
  numericColumns.forEach((col) => {
    const values = data.map(row => parseFloat(row[col])).filter(v => !isNaN(v)).sort((a, b) => a - b);
    if (values.length === 0) return;
    
    const q1 = values[Math.floor(values.length * 0.25)];
    const q3 = values[Math.floor(values.length * 0.75)];
    const iqr = q3 - q1;
    const outliers = values.filter(v => v < q1 - 1.5 * iqr || v > q3 + 1.5 * iqr);
    
    if (outliers.length > 0) {
      columnsWithOutliers.push({
        col: col,
        values: values,
        q1: q1,
        q3: q3,
        iqr: iqr,
        outliers: outliers
      });
    }
  });

  if (columnsWithOutliers.length === 0) {
    container.innerHTML = '<p class="no-outliers-message">이상치가 있는 속성이 없습니다.</p>';
    return;
  }

  // 각 열의 통계 계산 및 개별 상자 그림 생성
  columnsWithOutliers.forEach((colData, idx) => {
    const { col, values, q1, q3, iqr, outliers } = colData;
    
    const median = values[Math.floor(values.length * 0.5)];
    const min = Math.max(values[0], q1 - 1.5 * iqr);
    const max = Math.min(values[values.length - 1], q3 + 1.5 * iqr);

    const boxPlotData = {
      label: col,
      min: min,
      q1: q1,
      median: median,
      q3: q3,
      max: max,
      outliers: outliers,
      allValues: values
    };

    // 각 속성별 상자 그림 컨테이너 생성
    const chartWrapper = document.createElement('div');
    chartWrapper.className = 'box-plot-wrapper';
    
    const chartTitle = document.createElement('h6');
    chartTitle.className = 'box-plot-title';
    chartTitle.textContent = col;
    chartWrapper.appendChild(chartTitle);

    const chartContainer = document.createElement('div');
    chartContainer.className = 'chart-container';
    
    const canvas = document.createElement('canvas');
    canvas.className = 'box-plot-canvas';
    canvas.id = `boxPlotCanvas_${idx}`;
    chartContainer.appendChild(canvas);
    chartWrapper.appendChild(chartContainer);

    container.appendChild(chartWrapper);

    // 상자 그림 그리기 (약간의 지연을 두어 DOM이 완전히 렌더링된 후 실행)
    setTimeout(() => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // Canvas 크기 설정
      canvas.width = 500; // 고정 너비
      canvas.height = 400;
      canvas.style.width = '500px';
      canvas.style.height = '400px';

      drawSingleBoxPlot(ctx, canvas, boxPlotData);
    }, 100);
  });

  // 이상치 정보 표시
  const outlierDataSection = document.getElementById('outlierDataSection');
  const outlierDataInfo = document.getElementById('outlierDataInfo');
  const resolveOutlierBtn = document.getElementById('resolveOutlierBtn');

  if (outlierDataSection && outlierDataInfo) {
    const outlierInfo = {};
    const columnsWithOutliers = [];
    
    numericColumns.forEach(col => {
      const values = data.map(row => parseFloat(row[col])).filter(v => !isNaN(v)).sort((a, b) => a - b);
      const q1 = values[Math.floor(values.length * 0.25)];
      const q3 = values[Math.floor(values.length * 0.75)];
      const iqr = q3 - q1;
      const outliers = values.filter(v => v < q1 - 1.5 * iqr || v > q3 + 1.5 * iqr);
      
      if (outliers.length > 0) {
        outlierInfo[col] = {
          count: outliers.length,
          percentage: ((outliers.length / values.length) * 100).toFixed(2),
          values: outliers
        };
        columnsWithOutliers.push(col);
      }
    });

    if (columnsWithOutliers.length === 0) {
      outlierDataInfo.innerHTML = '<p class="success-message">✓ 이상치가 없습니다.</p>';
    } else {
      let html = '<div class="outlier-table"><table><thead><tr><th><input type="checkbox" id="selectAllOutlier" title="전체 선택"></th><th class="column-name-header">열 이름</th><th>이상치 개수 (IQR 방법)</th><th>이상치 비율</th></tr></thead><tbody>';
      
      columnsWithOutliers.forEach(col => {
        html += `<tr>
          <td><input type="checkbox" class="outlier-column-checkbox" data-column="${escapeHtml(col)}" checked></td>
          <td class="column-name-cell">${escapeHtml(col)}</td>
          <td>${outlierInfo[col].count}개</td>
          <td>${outlierInfo[col].percentage}%</td>
        </tr>`;
      });
      
      html += '</tbody></table></div>';
      outlierDataInfo.innerHTML = html;

      // 전체 선택 체크박스 이벤트
      const selectAllCheckbox = document.getElementById('selectAllOutlier');
      const columnCheckboxes = document.querySelectorAll('.outlier-column-checkbox');
      
      if (selectAllCheckbox) {
        selectAllCheckbox.addEventListener('change', (e) => {
          columnCheckboxes.forEach(cb => {
            cb.checked = e.target.checked;
          });
        });
      }

      // 개별 체크박스 이벤트
      columnCheckboxes.forEach(cb => {
        cb.addEventListener('change', () => {
          // 전체 선택 체크박스 상태 업데이트
          if (selectAllCheckbox) {
            const allChecked = Array.from(columnCheckboxes).every(c => c.checked);
            const someChecked = Array.from(columnCheckboxes).some(c => c.checked);
            selectAllCheckbox.checked = allChecked;
            selectAllCheckbox.indeterminate = someChecked && !allChecked;
          }
        });
      });
    }
    
    outlierDataSection.style.display = 'block';
    window.outlierInfo = outlierInfo;
  }

  if (resolveOutlierBtn) {
    resolveOutlierBtn.disabled = false;
  }
}

// 이상치 해결 적용
function handleApplyOutlier() {
  if (!window.currentData || !window.currentColumns || !window.outlierInfo) {
    alert('먼저 이상치를 확인해주세요.');
    return;
  }

  const selectedColumns = Array.from(document.querySelectorAll('.outlier-column-checkbox:checked'))
    .map(cb => cb.getAttribute('data-column'));

  if (selectedColumns.length === 0) {
    alert('이상치를 해결할 열을 선택해주세요.');
    return;
  }

  const action = document.querySelector('input[name="outlierAction"]:checked')?.value;
  const detection = document.querySelector('input[name="outlierDetection"]:checked')?.value;
  
  if (!action || !detection) {
    alert('이상치 해결 방법과 감지 방법을 선택해주세요.');
    return;
  }

  let data = JSON.parse(JSON.stringify(window.currentData)); // 깊은 복사
  const columns = window.currentColumns;
  const outlierInfo = window.outlierInfo;

  let removedCount = 0;
  let removedRows = 0;

  // 각 선택한 열에 대해 이상치 감지
  const outlierRows = new Set(); // 행 삭제를 위한 Set
  const outlierCells = {}; // 값 삭제를 위한 Map

  selectedColumns.forEach(col => {
    if (!outlierInfo[col]) return;

    const values = data.map(row => parseFloat(row[col])).filter(v => !isNaN(v)).sort((a, b) => a - b);
    if (values.length === 0) return;
    
    let thresholdMin, thresholdMax;

    switch (detection) {
      case 'iqr':
        const q1 = values[Math.floor(values.length * 0.25)];
        const q3 = values[Math.floor(values.length * 0.75)];
        const iqr = q3 - q1;
        thresholdMin = q1 - 1.5 * iqr;
        thresholdMax = q3 + 1.5 * iqr;
        break;
      case 'zscore':
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const std = Math.sqrt(values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length);
        thresholdMin = mean - 3 * std;
        thresholdMax = mean + 3 * std;
        break;
      case 'percentile':
        thresholdMin = values[Math.floor(values.length * 0.01)];
        thresholdMax = values[Math.floor(values.length * 0.99)];
        break;
    }

    // 이상치 찾기
    data.forEach((row, rowIdx) => {
      const val = parseFloat(row[col]);
      if (isNaN(val)) return;
      
      const isOutlier = val < thresholdMin || val > thresholdMax;
      if (isOutlier) {
        removedCount++;
        if (action === 'dropRow') {
          outlierRows.add(rowIdx);
        } else if (action === 'dropValue') {
          if (!outlierCells[rowIdx]) {
            outlierCells[rowIdx] = [];
          }
          outlierCells[rowIdx].push(col);
        }
      }
    });
  });

  // 행 삭제 또는 값 삭제 적용
  if (action === 'dropRow') {
    const beforeCount = data.length;
    data = data.filter((row, idx) => !outlierRows.has(idx));
    removedRows = beforeCount - data.length;
  } else if (action === 'dropValue') {
    data = data.map((row, rowIdx) => {
      if (outlierCells[rowIdx]) {
        const newRow = { ...row };
        outlierCells[rowIdx].forEach(col => {
          newRow[col] = '';
        });
        return newRow;
      }
      return row;
    });
  }

  // 데이터 업데이트
  window.currentData = data;

  // 테이블 및 정보 다시 렌더링
  const dataTableContainer = document.getElementById('dataTableContainer');
  const dataInfoGrid = document.getElementById('dataInfoGrid');
  
  if (dataTableContainer) {
    renderDataTable(data, columns, dataTableContainer);
  }
  
  if (dataInfoGrid) {
    const dataInfo = calculateDataFrameInfo(data, columns);
    renderDataFrameInfo(dataInfo, dataInfoGrid);
  }

  let message = `이상치 처리가 완료되었습니다.`;
  if (action === 'dropRow') {
    message += ` (${removedCount}개 이상치, ${removedRows}개 행 삭제)`;
  } else {
    message += ` (${removedCount}개 이상치 값 삭제)`;
  }
  message += ` (현재 ${data.length}행)`;
  alert(message);
  
  // 이상치 다시 확인
  handleCheckOutlier();

  // 작업 기록
  recordOperation({
    type: 'outlier',
    columns: selectedColumns,
    action,
    detection,
  });
}

// 정규화
function handleNormalize() {
  if (!window.currentData || !window.currentColumns) {
    alert('먼저 데이터를 업로드해주세요.');
    return;
  }

  const data = window.currentData;
  const columns = window.currentColumns;
  
  // 숫자형 열만 필터링
  const numericColumns = columns.filter(col => {
    const values = data.map(row => parseFloat(row[col])).filter(v => !isNaN(v));
    return values.length > 0;
  });

  if (numericColumns.length === 0) {
    alert('숫자형 데이터가 없어 정규화할 수 없습니다.');
    return;
  }

  const normalizeSection = document.getElementById('normalizeSection');
  const normalizeColumnList = document.getElementById('normalizeColumnList');

  if (normalizeSection && normalizeColumnList) {
    let html = '<div class="normalize-checkboxes">';
    numericColumns.forEach(col => {
      html += `
        <label class="normalize-checkbox-label">
          <input type="checkbox" class="normalize-column-checkbox" data-column="${escapeHtml(col)}" checked>
          <span>${escapeHtml(col)}</span>
        </label>
      `;
    });
    html += '</div>';

    normalizeColumnList.innerHTML = html;
    normalizeSection.style.display = 'block';
  }
}

// 정규화 적용
function handleApplyNormalize() {
  if (!window.currentData || !window.currentColumns) {
    alert('먼저 데이터를 업로드해주세요.');
    return;
  }

  const selectedColumns = Array.from(document.querySelectorAll('.normalize-column-checkbox:checked'))
    .map(cb => cb.getAttribute('data-column'));

  if (selectedColumns.length === 0) {
    alert('정규화할 열을 선택해주세요.');
    return;
  }

  const method = document.querySelector('input[name="normalizeMethod"]:checked')?.value;
  if (!method) {
    alert('정규화 방법을 선택해주세요.');
    return;
  }

  let data = JSON.parse(JSON.stringify(window.currentData)); // 깊은 복사
  const columns = window.currentColumns;

  selectedColumns.forEach(col => {
    const values = data.map(row => parseFloat(row[col])).filter(v => !isNaN(v));
    if (values.length === 0) return;

    let normalizedValues = [];

    if (method === 'minmax') {
      // Min-Max 정규화
      const min = Math.min(...values);
      const max = Math.max(...values);
      const range = max - min;

      if (range === 0) {
        // 모든 값이 같으면 0으로 설정
        normalizedValues = values.map(() => 0);
      } else {
        normalizedValues = values.map(v => (v - min) / range);
      }
    } else if (method === 'zscore') {
      // Z-score 정규화
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const std = Math.sqrt(values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length);

      if (std === 0) {
        // 표준편차가 0이면 모든 값을 0으로 설정
        normalizedValues = values.map(() => 0);
      } else {
        normalizedValues = values.map(v => (v - mean) / std);
      }
    }

    // 정규화된 값으로 데이터 업데이트
    let valueIndex = 0;
    data = data.map(row => {
      const val = parseFloat(row[col]);
      if (!isNaN(val)) {
        row[col] = normalizedValues[valueIndex].toFixed(6);
        valueIndex++;
      }
      return row;
    });
  });

  // 데이터 업데이트
  window.currentData = data;

  // 테이블 및 정보 다시 렌더링
  const dataTableContainer = document.getElementById('dataTableContainer');
  const dataInfoGrid = document.getElementById('dataInfoGrid');
  
  if (dataTableContainer) {
    renderDataTable(data, columns, dataTableContainer);
  }
  
  if (dataInfoGrid) {
    const dataInfo = calculateDataFrameInfo(data, columns);
    renderDataFrameInfo(dataInfo, dataInfoGrid);
  }

  alert(`정규화가 완료되었습니다. (${selectedColumns.length}개 속성 정규화)`);

  // 작업 기록
  recordOperation({
    type: 'normalize',
    columns: selectedColumns,
    method,
  });
}

// 그래프 추가
let chartCounter = 0;
const charts = {}; // Chart.js 인스턴스 저장

function handleAddChart() {
  if (!window.currentData || !window.currentColumns) {
    alert('먼저 데이터를 업로드해주세요.');
    return;
  }

  chartCounter++;
  const chartId = `chart_${chartCounter}`;
  const chartsContainer = document.getElementById('chartsContainer');
  
  if (!chartsContainer) return;

  // 그래프 컨테이너 생성
  const chartWrapper = document.createElement('div');
  chartWrapper.className = 'chart-wrapper';
  chartWrapper.id = `chartWrapper_${chartCounter}`;
  
  chartWrapper.innerHTML = `
    <div class="chart-header">
      <h5 class="chart-title">그래프 ${chartCounter}</h5>
      <button class="chart-delete-btn" data-chart-id="${chartId}">삭제</button>
    </div>
    <div class="chart-config">
      <div class="config-row">
        <label class="config-label">그래프 유형</label>
        <select class="chart-type-select" data-chart-id="${chartId}">
          <option value="line">선그래프</option>
          <option value="bar">막대그래프</option>
          <option value="pie">원그래프</option>
          <option value="scatter">산점도</option>
          <option value="histogram">히스토그램</option>
        </select>
      </div>
      <div class="config-row">
        <label class="config-label">X축 (또는 범주)</label>
        <select class="chart-x-select" data-chart-id="${chartId}">
          <option value="">선택하세요</option>
          ${window.currentColumns.map(col => `
            <option value="${escapeHtml(col)}">${escapeHtml(col)}</option>
          `).join('')}
        </select>
      </div>
      <div class="config-row">
        <label class="config-label">Y축 (또는 값)</label>
        <select class="chart-y-select" data-chart-id="${chartId}">
          <option value="">선택하세요</option>
          ${window.currentColumns.map(col => `
            <option value="${escapeHtml(col)}">${escapeHtml(col)}</option>
          `).join('')}
        </select>
      </div>
      <div class="config-row" id="chart-color-row_${chartCounter}" style="display: none;">
        <label class="config-label">색상</label>
        <input type="color" class="chart-color-input" data-chart-id="${chartId}" value="#667eea">
      </div>
      <button class="chart-generate-btn" data-chart-id="${chartId}">그래프 생성</button>
    </div>
    <div class="chart-canvas-container">
      <canvas id="${chartId}"></canvas>
    </div>
  `;

  // 그래프 추가하기 버튼을 찾아서 제거
  const addChartBtn = document.getElementById('addChartBtn');
  const addChartBtnContainer = addChartBtn ? addChartBtn.closest('.visualization-actions') : null;
  
  // 새 그래프 추가
  chartsContainer.appendChild(chartWrapper);
  
  // 버튼을 마지막으로 이동 (이미 있으면 제거 후 다시 추가)
  if (addChartBtnContainer) {
    if (chartsContainer.contains(addChartBtnContainer)) {
      chartsContainer.removeChild(addChartBtnContainer);
    }
    chartsContainer.appendChild(addChartBtnContainer);
  }

  // 이벤트 리스너 설정
  const deleteBtn = chartWrapper.querySelector('.chart-delete-btn');
  const generateBtn = chartWrapper.querySelector('.chart-generate-btn');
  const typeSelect = chartWrapper.querySelector('.chart-type-select');
  const xSelect = chartWrapper.querySelector('.chart-x-select');
  const ySelect = chartWrapper.querySelector('.chart-y-select');
  const colorInput = chartWrapper.querySelector('.chart-color-input');

  deleteBtn.addEventListener('click', () => {
    const id = deleteBtn.getAttribute('data-chart-id');
    handleDeleteChart(id);
  });

  generateBtn.addEventListener('click', () => {
    const id = generateBtn.getAttribute('data-chart-id');
    handleGenerateChart(id);
  });

  typeSelect.addEventListener('change', () => {
    const chartType = typeSelect.value;
    const colorRow = document.getElementById(`chart-color-row_${chartCounter}`);
    if (colorRow) {
      // 원그래프와 히스토그램은 색상 선택 표시
      if (chartType === 'pie' || chartType === 'histogram') {
        colorRow.style.display = 'flex';
      } else {
        colorRow.style.display = 'none';
      }
    }
  });

  // 메모리에 그래프 설정 기본값 저장
  if (!Array.isArray(window.chartConfigs)) {
    window.chartConfigs = [];
  }
  window.chartConfigs.push({
    id: chartId,
    type: 'line',
    xColumn: '',
    yColumn: '',
    color: '#667eea',
  });
}

// 저장된 설정으로 그래프 UI 복원
function restoreChartsFromMemory() {
  if (!Array.isArray(window.chartConfigs) || window.chartConfigs.length === 0) return;

  const chartsContainer = document.getElementById('chartsContainer');
  const addChartBtn = document.getElementById('addChartBtn');
  const addChartBtnContainer = addChartBtn ? addChartBtn.closest('.visualization-actions') : null;

  if (!chartsContainer) return;

  // 기존 차트 DOM 정리
  const existingWrappers = chartsContainer.querySelectorAll('.chart-wrapper');
  existingWrappers.forEach((el) => el.remove());

  window.chartConfigs.forEach((cfg, index) => {
    chartCounter = index + 1;
    const chartId = cfg.id || `chart_${chartCounter}`;
    cfg.id = chartId;

    const chartWrapper = document.createElement('div');
    chartWrapper.className = 'chart-wrapper';
    chartWrapper.id = `chartWrapper_${chartCounter}`;

    chartWrapper.innerHTML = `
      <div class="chart-header">
        <h5 class="chart-title">그래프 ${chartCounter}</h5>
        <button class="chart-delete-btn" data-chart-id="${chartId}">삭제</button>
      </div>
      <div class="chart-config">
        <div class="config-row">
          <label class="config-label">그래프 유형</label>
          <select class="chart-type-select" data-chart-id="${chartId}">
            <option value="line"${cfg.type === 'line' ? ' selected' : ''}>선그래프</option>
            <option value="bar"${cfg.type === 'bar' ? ' selected' : ''}>막대그래프</option>
            <option value="pie"${cfg.type === 'pie' ? ' selected' : ''}>원그래프</option>
            <option value="scatter"${cfg.type === 'scatter' ? ' selected' : ''}>산점도</option>
            <option value="histogram"${cfg.type === 'histogram' ? ' selected' : ''}>히스토그램</option>
          </select>
        </div>
        <div class="config-row">
          <label class="config-label">X축 (또는 범주)</label>
          <select class="chart-x-select" data-chart-id="${chartId}">
            <option value="">선택하세요</option>
            ${window.currentColumns
              .map(
                (col) => `
              <option value="${escapeHtml(col)}"${
                cfg.xColumn === col ? ' selected' : ''
              }>${escapeHtml(col)}</option>
            `,
              )
              .join('')}
          </select>
        </div>
        <div class="config-row">
          <label class="config-label">Y축 (또는 값)</label>
          <select class="chart-y-select" data-chart-id="${chartId}">
            <option value="">선택하세요</option>
            ${window.currentColumns
              .map(
                (col) => `
              <option value="${escapeHtml(col)}"${
                cfg.yColumn === col ? ' selected' : ''
              }>${escapeHtml(col)}</option>
            `,
              )
              .join('')}
          </select>
        </div>
        <div class="config-row" id="chart-color-row_${chartCounter}" style="${
          cfg.type === 'pie' || cfg.type === 'histogram' ? 'display: flex;' : 'display: none;'
        }">
          <label class="config-label">색상</label>
          <input type="color" class="chart-color-input" data-chart-id="${chartId}" value="${
            cfg.color || '#667eea'
          }">
        </div>
        <button class="chart-generate-btn" data-chart-id="${chartId}">그래프 생성</button>
      </div>
      <div class="chart-canvas-container">
        <canvas id="${chartId}"></canvas>
      </div>
    `;

    chartsContainer.appendChild(chartWrapper);

    const deleteBtn = chartWrapper.querySelector('.chart-delete-btn');
    const generateBtn = chartWrapper.querySelector('.chart-generate-btn');
    const typeSelect = chartWrapper.querySelector('.chart-type-select');

    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => {
        const id = deleteBtn.getAttribute('data-chart-id');
        handleDeleteChart(id);
      });
    }

    if (generateBtn) {
      generateBtn.addEventListener('click', () => {
        const id = generateBtn.getAttribute('data-chart-id');
        handleGenerateChart(id);
      });
    }

    if (typeSelect) {
      typeSelect.addEventListener('change', () => {
        const chartType = typeSelect.value;
        const colorRow = document.getElementById(`chart-color-row_${chartCounter}`);
        if (colorRow) {
          if (chartType === 'pie' || chartType === 'histogram') {
            colorRow.style.display = 'flex';
          } else {
            colorRow.style.display = 'none';
          }
        }
      });
    }

    if (window.currentData && window.currentColumns && cfg.xColumn && cfg.yColumn) {
      handleGenerateChart(chartId);
    }
  });

  if (addChartBtnContainer && !chartsContainer.contains(addChartBtnContainer)) {
    chartsContainer.appendChild(addChartBtnContainer);
  }
}

// 그래프 삭제
function handleDeleteChart(chartId) {
  // Chart.js 인스턴스 제거
  if (charts[chartId]) {
    charts[chartId].destroy();
    delete charts[chartId];
  }

  // DOM에서 제거
  const wrapper = document.getElementById(`chartWrapper_${chartId.split('_')[1]}`);
  if (wrapper) {
    wrapper.remove();
  }

  // 메모리에서 설정 제거
  if (Array.isArray(window.chartConfigs)) {
    window.chartConfigs = window.chartConfigs.filter((cfg) => cfg.id !== chartId);
  }

  // 그래프 추가하기 버튼이 마지막에 있는지 확인하고, 없으면 다시 추가
  const chartsContainer = document.getElementById('chartsContainer');
  const addChartBtn = document.getElementById('addChartBtn');
  if (chartsContainer && addChartBtn) {
    const addChartBtnContainer = addChartBtn.closest('.visualization-actions');
    if (addChartBtnContainer) {
      // 버튼이 컨테이너에 없으면 다시 추가
      if (!chartsContainer.contains(addChartBtnContainer)) {
        chartsContainer.appendChild(addChartBtnContainer);
      } else {
        // 버튼이 있으면 마지막으로 이동
        chartsContainer.removeChild(addChartBtnContainer);
        chartsContainer.appendChild(addChartBtnContainer);
      }
    }
  }
  
  updateSaveButtonColor();
}

// 그래프 생성
function handleGenerateChart(chartId) {
  if (!window.currentData || !window.currentColumns) {
    alert('먼저 데이터를 업로드해주세요.');
    return;
  }

  // chartId에서 번호 추출 (chart_1 -> 1)
  const chartNum = chartId.split('_')[1];
  const wrapper = document.getElementById(`chartWrapper_${chartNum}`);
  if (!wrapper) return;

  const typeSelect = wrapper.querySelector('.chart-type-select');
  const xSelect = wrapper.querySelector('.chart-x-select');
  const ySelect = wrapper.querySelector('.chart-y-select');
  const colorInput = wrapper.querySelector('.chart-color-input');

  const chartType = typeSelect.value;
  const xColumn = xSelect.value;
  const yColumn = ySelect.value;
  const color = colorInput ? colorInput.value : '#667eea';

  if (!xColumn || !yColumn) {
    alert('X축과 Y축을 모두 선택해주세요.');
    return;
  }

  const canvas = document.getElementById(chartId);
  if (!canvas) return;

  // 기존 차트 제거
  if (charts[chartId]) {
    charts[chartId].destroy();
  }

  const data = window.currentData;
  let chartData, chartConfig;

  switch (chartType) {
    case 'line':
      chartData = {
        labels: data.map(row => row[xColumn]),
        datasets: [{
          label: yColumn,
          data: data.map(row => parseFloat(row[yColumn])).filter(v => !isNaN(v)),
          borderColor: color,
          backgroundColor: color + '20',
          tension: 0.4
        }]
      };
      chartConfig = {
        type: 'line',
        data: chartData,
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              display: true
            }
          },
          scales: {
            y: {
              beginAtZero: false
            }
          }
        }
      };
      break;

    case 'bar':
      chartData = {
        labels: data.map(row => row[xColumn]),
        datasets: [{
          label: yColumn,
          data: data.map(row => parseFloat(row[yColumn])).filter(v => !isNaN(v)),
          backgroundColor: color + '80',
          borderColor: color,
          borderWidth: 1
        }]
      };
      chartConfig = {
        type: 'bar',
        data: chartData,
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              display: true
            }
          },
          scales: {
            y: {
              beginAtZero: true
            }
          }
        }
      };
      break;

    case 'pie':
      // 원그래프는 X축을 범주로, Y축을 값으로 사용
      const pieData = {};
      data.forEach(row => {
        const category = row[xColumn];
        const value = parseFloat(row[yColumn]);
        if (!isNaN(value)) {
          pieData[category] = (pieData[category] || 0) + value;
        }
      });

      const pieColors = generateColors(Object.keys(pieData).length);
      chartData = {
        labels: Object.keys(pieData),
        datasets: [{
          data: Object.values(pieData),
          backgroundColor: pieColors
        }]
      };
      chartConfig = {
        type: 'pie',
        data: chartData,
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              position: 'right'
            }
          }
        }
      };
      break;

    case 'scatter':
      const scatterData = data.map(row => ({
        x: parseFloat(row[xColumn]),
        y: parseFloat(row[yColumn])
      })).filter(point => !isNaN(point.x) && !isNaN(point.y));

      chartData = {
        datasets: [{
          label: `${xColumn} vs ${yColumn}`,
          data: scatterData,
          backgroundColor: color + '80',
          borderColor: color
        }]
      };
      chartConfig = {
        type: 'scatter',
        data: chartData,
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              display: true
            }
          },
          scales: {
            x: {
              title: {
                display: true,
                text: xColumn
              }
            },
            y: {
              title: {
                display: true,
                text: yColumn
              }
            }
          }
        }
      };
      break;

    case 'histogram':
      // 히스토그램은 Y축 값의 분포를 표시
      const histValues = data.map(row => parseFloat(row[yColumn])).filter(v => !isNaN(v));
      const bins = calculateHistogramBins(histValues, 10);
      
      chartData = {
        labels: bins.labels,
        datasets: [{
          label: yColumn,
          data: bins.counts,
          backgroundColor: color + '80',
          borderColor: color,
          borderWidth: 1
        }]
      };
      chartConfig = {
        type: 'bar',
        data: chartData,
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              display: true
            }
          },
          scales: {
            y: {
              beginAtZero: true
            }
          }
        }
      };
      break;
  }

  // Chart.js import 및 생성
  import('chart.js/auto').then(({ Chart }) => {
    charts[chartId] = new Chart(canvas, chartConfig);
  }).catch(err => {
    console.error('Chart.js 로드 실패:', err);
    alert('그래프를 생성하는 중 오류가 발생했습니다.');
  });

  // 메모리에 현재 그래프 설정 저장
  if (!Array.isArray(window.chartConfigs)) {
    window.chartConfigs = [];
  }
  const existing = window.chartConfigs.find((c) => c.id === chartId);
  const configToStore = {
    id: chartId,
    type: chartType,
    xColumn,
    yColumn,
    color,
  };
  if (existing) {
    Object.assign(existing, configToStore);
  } else {
    window.chartConfigs.push(configToStore);
  }
  
  // 그래프 추가하기 버튼이 마지막에 있는지 확인하고, 없으면 다시 추가
  const chartsContainer = document.getElementById('chartsContainer');
  const addChartBtn = document.getElementById('addChartBtn');
  if (chartsContainer && addChartBtn) {
    const addChartBtnContainer = addChartBtn.closest('.visualization-actions');
    if (addChartBtnContainer && !chartsContainer.contains(addChartBtnContainer)) {
      chartsContainer.appendChild(addChartBtnContainer);
    } else if (addChartBtnContainer && chartsContainer.contains(addChartBtnContainer)) {
      // 이미 있으면 마지막으로 이동
      chartsContainer.removeChild(addChartBtnContainer);
      chartsContainer.appendChild(addChartBtnContainer);
    }
  }
  
  updateSaveButtonColor();
}

// 히스토그램 빈 계산
function calculateHistogramBins(values, binCount) {
  if (values.length === 0) return { labels: [], counts: [] };

  const min = Math.min(...values);
  const max = Math.max(...values);
  const binWidth = (max - min) / binCount;

  const bins = Array(binCount).fill(0);
  const labels = [];

  for (let i = 0; i < binCount; i++) {
    const binStart = min + i * binWidth;
    const binEnd = min + (i + 1) * binWidth;
    labels.push(`${binStart.toFixed(2)} ~ ${binEnd.toFixed(2)}`);
    
    values.forEach(val => {
      if (val >= binStart && (i === binCount - 1 ? val <= binEnd : val < binEnd)) {
        bins[i]++;
      }
    });
  }

  return { labels, counts: bins };
}

// 원그래프용 색상 생성
function generateColors(count) {
  const colors = [
    '#667eea', '#764ba2', '#f093fb', '#4facfe', '#00f2fe',
    '#43e97b', '#fa709a', '#fee140', '#30cfd0', '#330867',
    '#a8edea', '#fed6e3', '#ffecd2', '#fcb69f', '#ff9a9e'
  ];
  
  const result = [];
  for (let i = 0; i < count; i++) {
    result.push(colors[i % colors.length]);
  }
  return result;
}

// 속성 선택 리스트 초기화
function initializeFeatureSelection(columns) {
  const featureSelectionList = document.getElementById('featureSelectionList');
  if (!featureSelectionList || !columns) return;

  // 저장된 선택 상태가 있으면 복원, 없으면 처음 5개 선택
  const savedFeatures = window.selectedFeatures || [];
  const defaultSelected = savedFeatures.length > 0 ? savedFeatures : columns.slice(0, 5);

  let html = '<div class="feature-checkboxes">';
  columns.forEach((col) => {
    const isChecked = defaultSelected.includes(col);
    html += `
      <label class="feature-checkbox-label">
        <input type="checkbox" class="feature-checkbox" data-column="${escapeHtml(col)}" ${isChecked ? 'checked' : ''}>
        <span>${escapeHtml(col)}</span>
      </label>
    `;
  });
  html += '</div>';

  featureSelectionList.innerHTML = html;

  // 선택 상태 업데이트
  updateSelectedFeatures();

  // 체크박스 변경 이벤트 리스너 추가
  const checkboxes = featureSelectionList.querySelectorAll('.feature-checkbox');
  checkboxes.forEach(checkbox => {
    checkbox.addEventListener('change', () => {
      updateSelectedFeatures();
      updateSaveButtonColor();
    });
  });
}

// 선택된 속성 업데이트
function updateSelectedFeatures() {
  const selectedColumns = Array.from(document.querySelectorAll('.feature-checkbox:checked'))
    .map(cb => cb.getAttribute('data-column'));
  window.selectedFeatures = selectedColumns;
}

// Pairplot 생성
function handleGeneratePairplot() {
  if (!window.currentData || !window.currentColumns) {
    alert('먼저 데이터를 업로드해주세요.');
    return;
  }

  const selectedColumns = Array.from(document.querySelectorAll('.feature-checkbox:checked'))
    .map(cb => cb.getAttribute('data-column'));

  if (selectedColumns.length < 2) {
    alert('최소 2개 이상의 속성을 선택해주세요.');
    return;
  }

  const pairplotContainer = document.getElementById('pairplotContainer');
  if (!pairplotContainer) return;

  // 기존 pairplot 제거
  pairplotContainer.innerHTML = '';
  pairplotContainer.style.display = 'block';

  const data = window.currentData;
  const n = selectedColumns.length;
  const cellSize = 150; // 각 셀의 크기
  const padding = 20;
  const labelWidth = 80; // Y축 레이블을 위한 공간
  const labelHeight = 30; // X축 레이블을 위한 공간
  const plotSize = n * cellSize + (n + 1) * padding;
  const totalWidth = labelWidth + plotSize;
  const totalHeight = plotSize + labelHeight;

  // 전체 컨테이너 생성
  const wrapper = document.createElement('div');
  wrapper.className = 'pairplot-wrapper';
  wrapper.style.width = `${totalWidth}px`;
  wrapper.style.height = `${totalHeight}px`;
  wrapper.style.position = 'relative';

  // 각 셀에 대한 산점도 생성
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const cell = document.createElement('div');
      cell.className = 'pairplot-cell';
      cell.style.position = 'absolute';
      cell.style.left = `${labelWidth + j * cellSize + (j + 1) * padding}px`;
      cell.style.top = `${i * cellSize + (i + 1) * padding}px`;
      cell.style.width = `${cellSize}px`;
      cell.style.height = `${cellSize}px`;

      const canvas = document.createElement('canvas');
      canvas.width = cellSize;
      canvas.height = cellSize;
      cell.appendChild(canvas);

      // 대각선: 히스토그램
      if (i === j) {
        drawHistogram(canvas, data, selectedColumns[i]);
      } else {
        // 비대각선: 산점도
        drawScatterPlot(canvas, data, selectedColumns[j], selectedColumns[i]);
      }

      // X축 레이블 (첫 번째 행에만)
      if (i === 0) {
        const xLabel = document.createElement('div');
        xLabel.className = 'pairplot-label pairplot-x-label';
        xLabel.textContent = selectedColumns[j];
        xLabel.style.position = 'absolute';
        xLabel.style.left = `${labelWidth + j * cellSize + (j + 1) * padding}px`;
        xLabel.style.top = `${plotSize + padding}px`;
        xLabel.style.width = `${cellSize}px`;
        xLabel.style.textAlign = 'center';
        xLabel.style.fontSize = '12px';
        xLabel.style.color = '#1d1d1f';
        wrapper.appendChild(xLabel);
      }

      // Y축 레이블 (첫 번째 열에만)
      if (j === 0) {
        const yLabel = document.createElement('div');
        yLabel.className = 'pairplot-label pairplot-y-label';
        yLabel.textContent = selectedColumns[i];
        yLabel.style.position = 'absolute';
        yLabel.style.left = '0';
        yLabel.style.top = `${i * cellSize + (i + 1) * padding}px`;
        yLabel.style.width = `${labelWidth}px`;
        yLabel.style.height = `${cellSize}px`;
        yLabel.style.display = 'flex';
        yLabel.style.alignItems = 'center';
        yLabel.style.justifyContent = 'center';
        yLabel.style.fontSize = '12px';
        yLabel.style.color = '#1d1d1f';
        yLabel.style.transform = 'none';
        yLabel.style.textAlign = 'right';
        yLabel.style.paddingRight = '10px';
        wrapper.appendChild(yLabel);
      }

      wrapper.appendChild(cell);
    }
  }

  pairplotContainer.appendChild(wrapper);

  // 상태 저장
  if (!window.featureExtractionState) {
    window.featureExtractionState = {};
  }
  window.featureExtractionState.pairplotGenerated = true;
  updateSaveButtonColor();
}

// 히스토그램 그리기 (대각선용)
function drawHistogram(canvas, data, column) {
  const ctx = canvas.getContext('2d');
  const values = data.map(row => parseFloat(row[column])).filter(v => !isNaN(v));
  
  if (values.length === 0) return;

  const bins = calculateHistogramBins(values, 10);
  const maxCount = Math.max(...bins.counts);
  const width = canvas.width;
  const height = canvas.height;
  const padding = 10;
  const plotWidth = width - 2 * padding;
  const plotHeight = height - 2 * padding;
  const barWidth = plotWidth / bins.counts.length;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#667eea';
  
  bins.counts.forEach((count, i) => {
    const barHeight = (count / maxCount) * plotHeight;
    const x = padding + i * barWidth;
    const y = height - padding - barHeight;
    ctx.fillRect(x, y, barWidth - 1, barHeight);
  });
}

// 산점도 그리기
function drawScatterPlot(canvas, data, xColumn, yColumn) {
  const ctx = canvas.getContext('2d');
  const xValues = data.map(row => parseFloat(row[xColumn])).filter(v => !isNaN(v));
  const yValues = data.map(row => parseFloat(row[yColumn])).filter(v => !isNaN(v));
  
  if (xValues.length === 0 || yValues.length === 0) return;

  // x와 y의 인덱스가 같은 데이터만 사용
  const points = [];
  data.forEach(row => {
    const x = parseFloat(row[xColumn]);
    const y = parseFloat(row[yColumn]);
    if (!isNaN(x) && !isNaN(y)) {
      points.push({ x, y });
    }
  });

  if (points.length === 0) return;

  const xMin = Math.min(...points.map(p => p.x));
  const xMax = Math.max(...points.map(p => p.x));
  const yMin = Math.min(...points.map(p => p.y));
  const yMax = Math.max(...points.map(p => p.y));
  
  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;

  const width = canvas.width;
  const height = canvas.height;
  const padding = 10;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#667eea';
  ctx.strokeStyle = '#667eea';

  points.forEach(point => {
    const x = padding + ((point.x - xMin) / xRange) * (width - 2 * padding);
    const y = height - padding - ((point.y - yMin) / yRange) * (height - 2 * padding);
    ctx.beginPath();
    ctx.arc(x, y, 2, 0, 2 * Math.PI);
    ctx.fill();
  });
}

// 히트맵 생성
function handleGenerateHeatmap() {
  if (!window.currentData || !window.currentColumns) {
    alert('먼저 데이터를 업로드해주세요.');
    return;
  }

  const selectedColumns = Array.from(document.querySelectorAll('.feature-checkbox:checked'))
    .map(cb => cb.getAttribute('data-column'));

  if (selectedColumns.length < 2) {
    alert('최소 2개 이상의 속성을 선택해주세요.');
    return;
  }

  const heatmapContainer = document.getElementById('heatmapContainer');
  if (!heatmapContainer) return;

  // 기존 히트맵 제거
  heatmapContainer.innerHTML = '';
  heatmapContainer.style.display = 'block';

  const data = window.currentData;
  const n = selectedColumns.length;
  const cellSize = 50;
  const labelWidth = 120;
  const labelHeight = 80; // X축 레이블을 위한 공간 증가
  const totalWidth = labelWidth + n * cellSize;
  const totalHeight = labelHeight + n * cellSize;

  // 상관계수 계산
  const correlationMatrix = [];
  for (let i = 0; i < n; i++) {
    correlationMatrix[i] = [];
    for (let j = 0; j < n; j++) {
      const col1 = selectedColumns[i];
      const col2 = selectedColumns[j];
      const values1 = data.map(row => parseFloat(row[col1])).filter(v => !isNaN(v));
      const values2 = data.map(row => parseFloat(row[col2])).filter(v => !isNaN(v));
      
      // 같은 인덱스의 값들만 사용
      const pairs = [];
      data.forEach(row => {
        const v1 = parseFloat(row[col1]);
        const v2 = parseFloat(row[col2]);
        if (!isNaN(v1) && !isNaN(v2)) {
          pairs.push({ x: v1, y: v2 });
        }
      });

      if (pairs.length < 2) {
        correlationMatrix[i][j] = 0;
      } else {
        correlationMatrix[i][j] = calculateCorrelation(pairs);
      }
    }
  }

  // 전체 컨테이너 생성
  const wrapper = document.createElement('div');
  wrapper.className = 'heatmap-wrapper';
  wrapper.style.width = `${totalWidth}px`;
  wrapper.style.height = `${totalHeight}px`;
  wrapper.style.position = 'relative';

  const canvas = document.createElement('canvas');
  canvas.width = totalWidth;
  canvas.height = totalHeight;
  wrapper.appendChild(canvas);

  const ctx = canvas.getContext('2d');

  // 히트맵 그리기
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const corr = correlationMatrix[i][j];
      const x = labelWidth + j * cellSize;
      const y = labelHeight + i * cellSize;

      // 색상 계산 (-1 ~ 1을 색상으로 변환)
      const color = getCorrelationColor(corr);
      ctx.fillStyle = color;
      ctx.fillRect(x, y, cellSize, cellSize);

      // 상관계수 텍스트
      ctx.fillStyle = Math.abs(corr) > 0.5 ? '#ffffff' : '#000000';
      ctx.font = '12px Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(corr.toFixed(2), x + cellSize / 2, y + cellSize / 2);
    }

    // Y축 레이블 (왼쪽, HTML로 표시)
    const yLabel = document.createElement('div');
    yLabel.className = 'heatmap-y-label';
    yLabel.textContent = selectedColumns[i];
    yLabel.style.position = 'absolute';
    yLabel.style.left = '0';
    yLabel.style.top = `${labelHeight + i * cellSize}px`;
    yLabel.style.width = `${labelWidth - 10}px`;
    yLabel.style.height = `${cellSize}px`;
    yLabel.style.display = 'flex';
    yLabel.style.alignItems = 'center';
    yLabel.style.justifyContent = 'flex-end';
    yLabel.style.fontSize = '12px';
    yLabel.style.color = '#000000';
    yLabel.style.paddingRight = '10px';
    wrapper.appendChild(yLabel);
  }

  // X축 레이블 (아래쪽, HTML로 표시, 회전 없이)
  for (let j = 0; j < n; j++) {
    const xLabel = document.createElement('div');
    xLabel.className = 'heatmap-x-label';
    xLabel.textContent = selectedColumns[j];
    xLabel.style.position = 'absolute';
    xLabel.style.left = `${labelWidth + j * cellSize}px`;
    xLabel.style.top = '0';
    xLabel.style.width = `${cellSize}px`;
    xLabel.style.height = `${labelHeight - 10}px`;
    xLabel.style.display = 'flex';
    xLabel.style.alignItems = 'flex-end';
    xLabel.style.justifyContent = 'center';
    xLabel.style.fontSize = '12px';
    xLabel.style.color = '#000000';
    xLabel.style.paddingBottom = '5px';
    xLabel.style.textAlign = 'center';
    xLabel.style.wordBreak = 'break-word';
    xLabel.style.overflow = 'hidden';
    wrapper.appendChild(xLabel);
  }

  heatmapContainer.appendChild(wrapper);

  // 상태 저장
  if (!window.featureExtractionState) {
    window.featureExtractionState = {};
  }
  window.featureExtractionState.heatmapGenerated = true;
  updateSaveButtonColor();
}

// 상관계수 계산
function calculateCorrelation(pairs) {
  if (pairs.length < 2) return 0;

  const n = pairs.length;
  const sumX = pairs.reduce((sum, p) => sum + p.x, 0);
  const sumY = pairs.reduce((sum, p) => sum + p.y, 0);
  const sumXY = pairs.reduce((sum, p) => sum + p.x * p.y, 0);
  const sumX2 = pairs.reduce((sum, p) => sum + p.x * p.x, 0);
  const sumY2 = pairs.reduce((sum, p) => sum + p.y * p.y, 0);

  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

  if (denominator === 0) return 0;
  return numerator / denominator;
}

// 상관계수에 따른 색상 계산
function getCorrelationColor(corr) {
  // -1 (파란색) ~ 0 (흰색) ~ 1 (빨간색)
  if (corr >= 0) {
    // 0 ~ 1: 흰색에서 빨간색으로
    const r = Math.floor(255);
    const g = Math.floor(255 * (1 - corr));
    const b = Math.floor(255 * (1 - corr));
    return `rgb(${r}, ${g}, ${b})`;
  } else {
    // -1 ~ 0: 파란색에서 흰색으로
    const r = Math.floor(255 * (1 + corr));
    const g = Math.floor(255 * (1 + corr));
    const b = Math.floor(255);
    return `rgb(${r}, ${g}, ${b})`;
  }
}

// 인증 상태 확인 및 프로젝트 로드
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    // 로그인되지 않은 사용자는 로그인 페이지로 리다이렉트
    window.location.href = 'index.html';
  } else {
    currentUser = user;
    
    // URL에서 projectId 가져오기
    const projectId = getProjectIdFromURL();
    
    if (!projectId) {
      alert('프로젝트 ID가 없습니다.');
      window.location.href = 'projectList.html';
      return;
    }
    
    currentProjectId = projectId;
    
    try {
      // 프로젝트 데이터 불러오기
      const projectData = await loadProject(projectId);
      
      // 프로젝트 소유자 확인
      if (projectData.userId !== user.uid) {
        alert('이 프로젝트에 접근할 권한이 없습니다.');
        window.location.href = 'projectList.html';
        return;
      }
      
      // 에디터 페이지 렌더링
      renderEditorPage(projectData);
      // 사용자 크레딧 불러오기
      await fetchUserCredits();
      
    } catch (error) {
      console.error('에러:', error);
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
            <button onclick="window.location.href='projectList.html'">프로젝트 목록으로</button>
          </div>
        `;
      }
    }
  }
});

