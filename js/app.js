// js-yaml loaded via local file before this script

const TIMER_DURATION = 60;
const CIRCUMFERENCE = 2 * Math.PI * 28; // r=28 matches SVG

// ── State ──────────────────────────────────────────────────────────────────
let categories = [];
let currentCategory = null;
let deck = [];
let deckIndex = 0;
let correctCount = 0;
let passCount = 0;
let results = [];
let timerInterval = null;
let timeLeft = TIMER_DURATION;
let gameActive = false;
let tiltCooldown = false;
let countdownInterval = null;

// Tilt state
let lastTilt = null;
let tiltBaseline = null; // calibrated baseline { beta, gamma }

// ── DOM refs ───────────────────────────────────────────────────────────────
const screens = {
  home:      document.getElementById('home-screen'),
  countdown: document.getElementById('countdown-screen'),
  game:      document.getElementById('game-screen'),
  results:   document.getElementById('results-screen'),
};

const el = {
  categoriesGrid: document.getElementById('categories-grid'),
  countdownNum:   document.getElementById('countdown-num'),
  countdownCat:   document.getElementById('countdown-cat'),
  gameBg:         document.getElementById('game-bg'),
  currentWord:    document.getElementById('current-word'),
  timerText:      document.getElementById('timer-text'),
  timerProgress:  document.getElementById('timer-progress'),
  correctFlash:   document.getElementById('correct-flash'),
  passFlash:      document.getElementById('pass-flash'),
  scoreCorrect:   document.getElementById('score-correct'),
  scorePass:      document.getElementById('score-pass'),
  resultCorrect:  document.getElementById('result-correct'),
  resultPass:     document.getElementById('result-pass'),
  resultsList:    document.getElementById('results-list'),
  resultCategory: document.getElementById('result-category'),
  howToModal:     document.getElementById('how-to-modal'),
  rotateOverlay:  document.getElementById('rotate-overlay'),
};

// ── Screen manager ─────────────────────────────────────────────────────────
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
  updateRotateOverlay();
}

// ── Rotate overlay ─────────────────────────────────────────────────────────
const isTouchDevice = () => navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
const isPortrait = () => window.innerHeight > window.innerWidth;

// Game screens that require landscape
const LANDSCAPE_SCREENS = ['countdown', 'game'];

function updateRotateOverlay() {
  const activeScreen = Object.keys(screens).find(k => screens[k].classList.contains('active'));
  const needsLandscape = LANDSCAPE_SCREENS.includes(activeScreen);
  const showOverlay = isTouchDevice() && needsLandscape && isPortrait();
  el.rotateOverlay.classList.toggle('visible', showOverlay);
}

window.addEventListener('resize', updateRotateOverlay);
window.addEventListener('orientationchange', () => {
  setTimeout(updateRotateOverlay, 150); // wait for dimensions to update
});

// ── Load categories ────────────────────────────────────────────────────────
async function loadCategories() {
  try {
    const indexRes = await fetch('categories/index.json');
    const files = await indexRes.json();
    categories = await Promise.all(files.map(async (file) => {
      const res = await fetch(`categories/${file}`);
      const text = await res.text();
      return jsyaml.load(text);
    }));
    renderCategories();
  } catch (err) {
    console.error('Failed to load categories:', err);
    el.categoriesGrid.innerHTML = '<p style="color:var(--muted);grid-column:1/-1;text-align:center">Failed to load categories.</p>';
  }
}

function renderCategories() {
  el.categoriesGrid.innerHTML = categories.map((cat, i) => `
    <button class="category-card" style="background:${cat.color}" onclick="selectCategory(${i})">
      <span class="emoji">${cat.emoji}</span>
      <span class="cat-name">${cat.name}</span>
      <span class="cat-count">${cat.words.length} cards</span>
    </button>
  `).join('');
}

// ── Category selection ─────────────────────────────────────────────────────
function selectCategory(index) {
  currentCategory = categories[index];
  deck = shuffle([...currentCategory.words]);
  deckIndex = 0;
  correctCount = 0;
  passCount = 0;
  results = [];
  startCountdown();
}

// ── Countdown ─────────────────────────────────────────────────────────────
function startCountdown() {
  showScreen('countdown');
  el.countdownCat.textContent = `${currentCategory.emoji} ${currentCategory.name}`;
  document.getElementById('countdown-screen').style.background =
    `linear-gradient(135deg, ${currentCategory.color}cc, ${currentCategory.color}55)`;

  // Try to lock orientation to landscape for gameplay
  lockLandscape();

  let count = 3;
  el.countdownNum.textContent = count;
  clearInterval(countdownInterval);
  countdownInterval = setInterval(() => {
    count--;
    if (count <= 0) {
      clearInterval(countdownInterval);
      startGame();
    } else {
      el.countdownNum.textContent = count;
    }
  }, 1000);
}

// ── Orientation lock ───────────────────────────────────────────────────────
function lockLandscape() {
  if (screen.orientation && screen.orientation.lock) {
    screen.orientation.lock('landscape').catch(() => {
      // Lock not supported or denied — overlay handles this
    });
  }
}

function unlockOrientation() {
  if (screen.orientation && screen.orientation.unlock) {
    screen.orientation.unlock();
  }
}

// ── Game ───────────────────────────────────────────────────────────────────
function startGame() {
  showScreen('game');
  timeLeft = TIMER_DURATION;
  gameActive = true;
  tiltBaseline = null;
  lastTilt = null;

  el.gameBg.style.background =
    `linear-gradient(160deg, ${currentCategory.color}dd 0%, ${currentCategory.color}88 100%)`;
  el.scoreCorrect.textContent = '0';
  el.scorePass.textContent = '0';

  updateTimerUI();
  showWord();
  startTimer();
  setupTilt();
}

function showWord() {
  if (deckIndex >= deck.length) {
    deck = shuffle([...currentCategory.words]);
    deckIndex = 0;
  }
  el.currentWord.textContent = deck[deckIndex];
  // Re-trigger animation
  el.currentWord.style.animation = 'none';
  void el.currentWord.offsetWidth;
  el.currentWord.style.animation = '';
}

function markCorrect() {
  if (!gameActive || tiltCooldown) return;
  triggerCooldown();
  results.push({ word: deck[deckIndex], status: 'correct' });
  correctCount++;
  el.scoreCorrect.textContent = correctCount;
  deckIndex++;
  showFlash('correct');
  showWord();
}

function markPass() {
  if (!gameActive || tiltCooldown) return;
  triggerCooldown();
  results.push({ word: deck[deckIndex], status: 'pass' });
  passCount++;
  el.scorePass.textContent = passCount;
  deckIndex++;
  showFlash('pass');
  showWord();
}

function triggerCooldown() {
  tiltCooldown = true;
  setTimeout(() => { tiltCooldown = false; }, 900);
}

function showFlash(type) {
  const flashEl = type === 'correct' ? el.correctFlash : el.passFlash;
  flashEl.classList.add('visible');
  setTimeout(() => flashEl.classList.remove('visible'), 500);
}

// ── Timer ──────────────────────────────────────────────────────────────────
function startTimer() {
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    timeLeft--;
    updateTimerUI();
    if (timeLeft <= 0) endGame();
  }, 1000);
}

function updateTimerUI() {
  el.timerText.textContent = timeLeft;
  const offset = CIRCUMFERENCE * (1 - timeLeft / TIMER_DURATION);
  el.timerProgress.style.strokeDashoffset = offset;

  if (timeLeft <= 10) {
    el.timerProgress.style.stroke = '#ff6b6b';
    el.timerText.style.color = '#ff6b6b';
  } else if (timeLeft <= 20) {
    el.timerProgress.style.stroke = '#f5a623';
    el.timerText.style.color = '#f5a623';
  } else {
    el.timerProgress.style.stroke = '#4ecca3';
    el.timerText.style.color = '';
  }
}

// ── Tilt detection ─────────────────────────────────────────────────────────
function setupTilt() {
  if (typeof DeviceOrientationEvent === 'undefined') return;

  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    // iOS 13+ — request permission (must be from a user gesture; handled at game start click)
    DeviceOrientationEvent.requestPermission()
      .then(state => { if (state === 'granted') startTiltListening(); })
      .catch(() => {});
  } else {
    startTiltListening();
  }
}

// Calibration: collect first few readings to establish baseline
let calibrationBuffer = [];
const CALIB_SAMPLES = 8;

function startTiltListening() {
  calibrationBuffer = [];
  window.addEventListener('deviceorientation', calibrateThen, { passive: true });
}

function calibrateThen(e) {
  if (e.beta === null || e.gamma === null) return;
  calibrationBuffer.push({ beta: e.beta, gamma: e.gamma });

  if (calibrationBuffer.length >= CALIB_SAMPLES) {
    // Average out the baseline
    const avgBeta  = calibrationBuffer.reduce((s, r) => s + r.beta,  0) / CALIB_SAMPLES;
    const avgGamma = calibrationBuffer.reduce((s, r) => s + r.gamma, 0) / CALIB_SAMPLES;
    tiltBaseline = { beta: avgBeta, gamma: avgGamma };

    window.removeEventListener('deviceorientation', calibrateThen);
    window.addEventListener('deviceorientation', handleTilt, { passive: true });
  }
}

function getOrientationType() {
  if (screen.orientation) return screen.orientation.type; // e.g. 'landscape-primary'
  // Fallback using deprecated window.orientation
  const wo = window.orientation;
  if (wo === 90)  return 'landscape-primary';
  if (wo === -90) return 'landscape-secondary';
  if (wo === 180) return 'portrait-secondary';
  return 'portrait-primary';
}

function handleTilt(e) {
  if (!gameActive || !tiltBaseline) return;

  const beta  = e.beta  || 0;
  const gamma = e.gamma || 0;
  const type  = getOrientationType();
  const landscape = type.includes('landscape');

  let tilt;
  if (landscape) {
    // In landscape the front-back nod maps to gamma (left-right in portrait terms)
    // landscape-secondary flips the axis
    const rawGamma = gamma - tiltBaseline.gamma;
    tilt = (type === 'landscape-secondary') ? -rawGamma : rawGamma;
  } else {
    // Portrait: front-back nod maps to beta
    tilt = beta - tiltBaseline.beta;
  }

  // Threshold: ±28° from calibrated baseline
  if (tilt < -28 && (lastTilt === null || lastTilt >= -28)) {
    markCorrect();
  } else if (tilt > 28 && (lastTilt === null || lastTilt <= 28)) {
    markPass();
  }

  lastTilt = tilt;
}

function disableTilt() {
  window.removeEventListener('deviceorientation', calibrateThen);
  window.removeEventListener('deviceorientation', handleTilt);
  calibrationBuffer = [];
  tiltBaseline = null;
  lastTilt = null;
}

// ── Keyboard controls (desktop) ────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (!gameActive) return;
  if (e.key === 'ArrowUp'   || e.key === 'ArrowRight') markCorrect();
  if (e.key === 'ArrowDown' || e.key === 'ArrowLeft')  markPass();
});

// ── Swipe controls ─────────────────────────────────────────────────────────
let touchStartY = 0;
document.addEventListener('touchstart', (e) => {
  touchStartY = e.touches[0].clientY;
}, { passive: true });

document.addEventListener('touchend', (e) => {
  if (!gameActive) return;
  const dy = touchStartY - e.changedTouches[0].clientY;
  if (Math.abs(dy) > 60) {
    dy > 0 ? markCorrect() : markPass();
  }
}, { passive: true });

// ── End game ───────────────────────────────────────────────────────────────
function endGame() {
  gameActive = false;
  clearInterval(timerInterval);
  disableTilt();
  unlockOrientation();

  // Mark current word as skipped if not yet acted on
  const currentWord = deck[deckIndex] || '';
  const lastResult = results[results.length - 1];
  if (currentWord && (!lastResult || lastResult.word !== currentWord)) {
    results.push({ word: currentWord, status: 'skipped' });
  }

  showResults();
}

// ── Results ────────────────────────────────────────────────────────────────
function showResults() {
  showScreen('results');
  el.resultCorrect.textContent = correctCount;
  el.resultPass.textContent = passCount;
  el.resultCategory.textContent = `${currentCategory.emoji} ${currentCategory.name}`;

  const emoji = correctCount >= 10 ? '🏆' : correctCount >= 5 ? '🎉' : '😅';
  document.getElementById('results-emoji').textContent = emoji;
  document.getElementById('results-title').textContent =
    correctCount >= 10 ? 'Incredible!' : correctCount >= 5 ? 'Great round!' : 'Nice try!';

  el.resultsList.innerHTML = results.map(r => `
    <div class="result-item ${r.status}">
      <div class="result-dot"></div>
      <span class="result-word">${r.word}</span>
      <span class="result-badge">${r.status === 'correct' ? '✓ Got it' : r.status === 'pass' ? '✗ Pass' : '— Skipped'}</span>
    </div>
  `).join('');
}

function playAgain() {
  deck = shuffle([...currentCategory.words]);
  deckIndex = 0;
  correctCount = 0;
  passCount = 0;
  results = [];
  startCountdown();
}

function goHome() {
  clearInterval(timerInterval);
  clearInterval(countdownInterval);
  disableTilt();
  gameActive = false;
  unlockOrientation();
  showScreen('home');
}

// ── How to play modal ──────────────────────────────────────────────────────
function showHowTo() { el.howToModal.classList.add('open'); }
function closeHowTo() { el.howToModal.classList.remove('open'); }

el.howToModal.addEventListener('click', (e) => {
  if (e.target === el.howToModal) closeHowTo();
});

// ── iOS tilt permission button ─────────────────────────────────────────────
function requestTiltPermission() {
  if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission()
      .then(state => {
        if (state === 'granted') {
          document.getElementById('tilt-btn-wrap').style.display = 'none';
        }
      }).catch(() => {});
  }
}

(function checkiOS() {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (isIOS && typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function') {
    document.getElementById('tilt-btn-wrap').style.display = 'block';
  }
})();

// ── Helpers ────────────────────────────────────────────────────────────────
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── Init ───────────────────────────────────────────────────────────────────
el.timerProgress.style.strokeDasharray = CIRCUMFERENCE;
el.timerProgress.style.strokeDashoffset = 0;
loadCategories();
