// js-yaml loaded via local file before this script

const TIMER_DURATION = 60;
const CIRCUMFERENCE = 2 * Math.PI * 28;
const TILT_THRESHOLD = 26; // degrees from calibrated baseline

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
let lastTiltValue = null;
let tiltBaseline = null;
let calibrationBuffer = [];
let tiltListening = false;

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
const isPortrait    = () => window.innerHeight > window.innerWidth;

const LANDSCAPE_SCREENS = ['countdown', 'game'];

function updateRotateOverlay() {
  const active = Object.keys(screens).find(k => screens[k].classList.contains('active'));
  const show = isTouchDevice() && LANDSCAPE_SCREENS.includes(active) && isPortrait();
  el.rotateOverlay.classList.toggle('visible', show);
}

window.addEventListener('resize', updateRotateOverlay);
window.addEventListener('orientationchange', () => setTimeout(updateRotateOverlay, 150));

// ── Load categories ────────────────────────────────────────────────────────
async function loadCategories() {
  try {
    const entries = await fetch('categories/index.json').then(r => r.json());
    const loaded = await Promise.all(entries.map(async entry => {
      // Support both old format (plain string) and new format ({file, group})
      const file  = typeof entry === 'string' ? entry : entry.file;
      const group = typeof entry === 'string' ? 'All' : entry.group;
      const text  = await fetch(`categories/${file}`).then(r => r.text());
      const cat   = jsyaml.load(text);
      cat._group  = group;
      return cat;
    }));
    categories = loaded;
    renderCategories();
  } catch (err) {
    console.error('Failed to load categories:', err);
    el.categoriesGrid.innerHTML =
      '<p style="color:var(--muted);grid-column:1/-1;text-align:center">Failed to load categories.</p>';
  }
}

function renderCategories() {
  // Group categories preserving insertion order
  const groupMap = new Map();
  categories.forEach((cat, i) => {
    const g = cat._group || 'All';
    if (!groupMap.has(g)) groupMap.set(g, []);
    groupMap.get(g).push({ cat, i });
  });

  let firstGroup = true;
  let html = '';
  for (const [groupName, items] of groupMap) {
    const open = firstGroup;
    html += `
      <div class="accordion ${open ? 'open' : ''}">
        <button class="accordion-header" onclick="toggleAccordion(this.parentElement)">
          <span class="accordion-title">${groupName}</span>
          <span class="accordion-count">${items.length}</span>
          <span class="accordion-chevron">▾</span>
        </button>
        <div class="accordion-body">
          <div class="categories-grid">
            ${items.map(({ cat, i }) => `
              <button class="category-card" style="background:${cat.color}"
                      onclick="selectCategory(${i})">
                <span class="emoji">${cat.emoji}</span>
                <span class="cat-name">${cat.name}</span>
                <span class="cat-count">${cat.words.length} cards</span>
              </button>
            `).join('')}
          </div>
        </div>
      </div>
    `;
    firstGroup = false;
  }
  el.categoriesGrid.innerHTML = html;
}

function toggleAccordion(accordionEl) {
  accordionEl.classList.toggle('open');
}

// ── Category selection ─────────────────────────────────────────────────────
function selectCategory(index) {
  // iOS 13+: requestPermission MUST be called directly inside a user-gesture
  // handler. Do it here — NOT 3 seconds later after the countdown.
  requestOrientationPermission();

  currentCategory = categories[index];
  deck = shuffle([...currentCategory.words]);
  deckIndex = 0;
  correctCount = 0;
  passCount = 0;
  results = [];
  startCountdown();
}

// ── Orientation permission ─────────────────────────────────────────────────
function requestOrientationPermission() {
  if (typeof DeviceOrientationEvent === 'undefined') return;
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    // iOS 13+
    DeviceOrientationEvent.requestPermission()
      .then(state => { if (state === 'granted') startCalibration(); })
      .catch(() => {});
  } else {
    // Android / non-gated browsers — start immediately
    startCalibration();
  }
}

// ── Countdown ─────────────────────────────────────────────────────────────
function startCountdown() {
  showScreen('countdown');
  el.countdownCat.textContent = `${currentCategory.emoji} ${currentCategory.name}`;
  document.getElementById('countdown-screen').style.background =
    `linear-gradient(135deg, ${currentCategory.color}cc, ${currentCategory.color}55)`;

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
    screen.orientation.lock('landscape').catch(() => {});
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
  lastTiltValue = null;

  el.gameBg.style.background =
    `linear-gradient(160deg, ${currentCategory.color}dd 0%, ${currentCategory.color}88 100%)`;
  el.scoreCorrect.textContent = '0';
  el.scorePass.textContent = '0';

  updateTimerUI();
  showWord();
  startTimer();

  // If calibration wasn't started yet (e.g. Android where permission is
  // auto-granted and startCalibration wasn't called during selectCategory)
  if (!tiltListening) startCalibration();
}

function showWord() {
  if (deckIndex >= deck.length) {
    deck = shuffle([...currentCategory.words]);
    deckIndex = 0;
  }
  el.currentWord.textContent = deck[deckIndex];
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
// AXIS SELECTION
// Landscape (phone held flat on forehead): the "nod" rotates around the
// phone's long (Y) axis → gamma changes.
//   • gamma negative delta → far end tipped down  → CORRECT
//   • gamma positive delta → far end tipped up    → PASS
//
// Portrait (phone held upright): the "nod" rotates around the X axis → beta.
//   • beta negative delta → top tips forward      → CORRECT
//   • beta positive delta → top tips backward     → PASS

function startCalibration() {
  if (tiltListening) return; // already running
  tiltListening = true;
  calibrationBuffer = [];
  window.addEventListener('deviceorientation', onCalibrate, { passive: true });

  // Safety: if 4 s pass without enough samples, lock in whatever we have
  setTimeout(() => {
    if (!tiltBaseline && calibrationBuffer.length > 0) {
      finaliseBaseline();
    }
  }, 4000);
}

function onCalibrate(e) {
  if (e.beta === null || e.gamma === null) return;
  calibrationBuffer.push({ beta: e.beta, gamma: e.gamma });
  if (calibrationBuffer.length >= 10) finaliseBaseline();
}

function finaliseBaseline() {
  const n = calibrationBuffer.length;
  if (n === 0) { tiltBaseline = { beta: 0, gamma: 0 }; }
  else {
    tiltBaseline = {
      beta:  calibrationBuffer.reduce((s, r) => s + r.beta,  0) / n,
      gamma: calibrationBuffer.reduce((s, r) => s + r.gamma, 0) / n,
    };
  }
  window.removeEventListener('deviceorientation', onCalibrate);
  window.addEventListener('deviceorientation', onTilt, { passive: true });
}

function onTilt(e) {
  if (!gameActive || !tiltBaseline) return;

  const inLandscape = window.innerWidth > window.innerHeight;
  const raw = inLandscape
    ? (e.gamma || 0) - tiltBaseline.gamma   // landscape: gamma axis
    : (e.beta  || 0) - tiltBaseline.beta;   // portrait:  beta axis

  // Edge-triggered: only fires once per crossing, resets when back to neutral
  if (raw < -TILT_THRESHOLD && (lastTiltValue === null || lastTiltValue >= -TILT_THRESHOLD)) {
    markCorrect();
  } else if (raw > TILT_THRESHOLD && (lastTiltValue === null || lastTiltValue <= TILT_THRESHOLD)) {
    markPass();
  }

  lastTiltValue = raw;
}

function disableTilt() {
  window.removeEventListener('deviceorientation', onCalibrate);
  window.removeEventListener('deviceorientation', onTilt);
  calibrationBuffer = [];
  tiltBaseline = null;
  lastTiltValue = null;
  tiltListening = false;
}

// ── Keyboard (desktop) ─────────────────────────────────────────────────────
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
  if (Math.abs(dy) > 60) dy > 0 ? markCorrect() : markPass();
}, { passive: true });

// ── Stop game (mid-game quit) ──────────────────────────────────────────────
function stopGame() {
  clearInterval(timerInterval);
  clearInterval(countdownInterval);
  disableTilt();
  gameActive = false;
  unlockOrientation();

  // Mark current word as skipped
  const word = deck[deckIndex] || '';
  const last = results[results.length - 1];
  if (word && (!last || last.word !== word)) {
    results.push({ word, status: 'skipped' });
  }

  showResults();
}

// ── End game (timer reached 0) ─────────────────────────────────────────────
function endGame() {
  gameActive = false;
  clearInterval(timerInterval);
  disableTilt();
  unlockOrientation();

  const word = deck[deckIndex] || '';
  const last = results[results.length - 1];
  if (word && (!last || last.word !== word)) {
    results.push({ word, status: 'skipped' });
  }

  showResults();
}

// ── Results ────────────────────────────────────────────────────────────────
function showResults() {
  showScreen('results');
  el.resultCorrect.textContent = correctCount;
  el.resultPass.textContent    = passCount;
  el.resultCategory.textContent = `${currentCategory.emoji} ${currentCategory.name}`;

  document.getElementById('results-emoji').textContent =
    correctCount >= 10 ? '🏆' : correctCount >= 5 ? '🎉' : '😅';
  document.getElementById('results-title').textContent =
    correctCount >= 10 ? 'Incredible!' : correctCount >= 5 ? 'Great round!' : 'Nice try!';

  el.resultsList.innerHTML = results.map(r => `
    <div class="result-item ${r.status}">
      <div class="result-dot"></div>
      <span class="result-word">${r.word}</span>
      <span class="result-badge">${
        r.status === 'correct' ? '✓ Got it' :
        r.status === 'pass'    ? '✗ Pass'   : '— Skipped'
      }</span>
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
function showHowTo()  { el.howToModal.classList.add('open'); }
function closeHowTo() { el.howToModal.classList.remove('open'); }

el.howToModal.addEventListener('click', e => {
  if (e.target === el.howToModal) closeHowTo();
});

// ── iOS tilt permission button (home screen) ───────────────────────────────
function requestTiltPermission() {
  if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission()
      .then(state => {
        if (state === 'granted')
          document.getElementById('tilt-btn-wrap').style.display = 'none';
      }).catch(() => {});
  }
}

(function checkiOS() {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (isIOS && typeof DeviceOrientationEvent?.requestPermission === 'function') {
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
el.timerProgress.style.strokeDasharray  = CIRCUMFERENCE;
el.timerProgress.style.strokeDashoffset = 0;
loadCategories();
