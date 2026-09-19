// ═══════════════════════════════════════════════════════════════════════════
// Mushak's Modak Dash — main.js
// Phaser 3.90.0  •  Vite  •  ES Modules  •  Mobile-First Endless Runner
// ═══════════════════════════════════════════════════════════════════════════

import Phaser from 'phaser';

// ── Orientation Lock (Mobile) ────────────────────────────────────────────
try {
  screen.orientation?.lock?.('landscape').catch(() => {});
} catch { /* unsupported on desktop browsers */ }

// ── Constants ────────────────────────────────────────────────────────────
const GAME_WIDTH = 1066;
const GAME_HEIGHT = 600;
const FLOOR_Y = 500;
const PLAYER_X = 140;

// Calibrated asset scale factors
const PLAYER_SCALE = 0.07;          // Raw AI PNGs are ~1024×1024
const POT_SCALE = 0.30;             // Calibrated obstacle size (~80px tall)
const MODAK_SCALE = 0.30;           // Calibrated collectible sweet (~50px)
const SPARK_SCALE_START = 0.035;    // Crisp ~35px sparkle particles

const BASE_SCROLL_VELOCITY = -350;
const SPEED_STEP = -50;
const SPEED_STEP_INTERVAL = 15_000; // ms
const DOUBLE_POT_SPEED_THRESHOLD = -400; // Double horizontal hurdles appear after reaching -400px/s (after 15s)
const STACKED_POT_SPEED_THRESHOLD = -450; // Hard difficulty: 2 pots stacked into a pillar appear after -450px/s (after 30s)
const OBSTACLE_POOL_SIZE = 16;
const COLLECTIBLE_POOL_SIZE = 22;
const MODAK_POINTS = 75;
const PLAYER_STORAGE_KEY = 'mushak-modak-dash.player.v1';

// Emotional-state thresholds
const FOCUSED_SPEED_THRESHOLD = -500;
const HAPPY_FLASH_DURATION = 400;   // ms

// Vite env vars (replaced at build time)
const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';
const CLIENT_SCORE_SALT = import.meta.env.VITE_SCORE_SALT ?? 'mushak-modak-dash-client-salt';

// ── Emotional States ─────────────────────────────────────────────────────
const EmotionalState = {
  IDLE: 'idle',
  RUN: 'run',
  HAPPY: 'happy',
  PANIC: 'panic',
  FOCUSED: 'focused',
  DIZZY: 'dizzy',
};

// Map each state to the texture key to use.
// FOCUSED reuses 'mushak-run' with a cool blue focus aura tint.
const STATE_TEXTURE_MAP = {
  [EmotionalState.IDLE]: 'mushak-idle',
  [EmotionalState.RUN]: 'mushak-run',
  [EmotionalState.HAPPY]: 'mushak-joyful',
  [EmotionalState.PANIC]: 'mushak-panic',
  [EmotionalState.FOCUSED]: 'mushak-run',
  [EmotionalState.DIZZY]: 'mushak-dizzy',
};

// ── DOM References ───────────────────────────────────────────────────────
const dom = {
  loaderOverlay: document.getElementById('loader-overlay'),
  loaderText: document.getElementById('loader-text'),
  loaderBarFill: document.getElementById('loader-bar-fill'),
  profileModal: document.getElementById('profile-modal'),
  registerView: document.getElementById('profile-register-view'),
  welcomeView: document.getElementById('profile-welcome-view'),
  displayName: document.getElementById('display-name'),
  campus: document.getElementById('campus'),
  playerPin: document.getElementById('player-pin'),
  profileError: document.getElementById('profile-error'),
  welcomeName: document.getElementById('welcome-name'),
  welcomeHighScore: document.getElementById('welcome-high-score'),
  welcomeHighScoreVal: document.getElementById('welcome-high-score-val'),
  welcomeSubtitle: document.getElementById('welcome-subtitle'),
  welcomePlayBtn: document.getElementById('welcome-play-btn'),
  welcomeLeaderboardBtn: document.getElementById('welcome-leaderboard-btn'),
  welcomeEditBtn: document.getElementById('welcome-edit-btn'),
  gameOverModal: document.getElementById('game-over-modal'),
  finalScore: document.getElementById('final-score'),
  finalDuration: document.getElementById('final-duration'),
  submitScore: document.getElementById('submit-score'),
  restartGame: document.getElementById('restart-game'),
  gameoverLeaderboardBtn: document.getElementById('gameover-leaderboard-btn'),
  submissionStatus: document.getElementById('submission-status'),
  mainMenuButtons: document.getElementById('main-menu-buttons'),
  menuLeaderboardBtn: document.getElementById('menu-leaderboard-btn'),
  leaderboardPanel: document.getElementById('leaderboard-panel'),
  leaderboardBody: document.getElementById('leaderboard-body'),
  leaderboardCloseBtn: document.getElementById('leaderboard-close-btn'),
  personalRankFooter: document.getElementById('personal-rank-footer'),
  prRank: document.getElementById('pr-rank'),
  prName: document.getElementById('pr-name'),
  prCampus: document.getElementById('pr-campus'),
  prScore: document.getElementById('pr-score'),
  soundToggleBtn: document.getElementById('sound-toggle-btn'),
};

// ═════════════════════════════════════════════════════════════════════════
//  SUPABASE HELPERS (raw fetch — no SDK needed)
// ═════════════════════════════════════════════════════════════════════════

function supabaseHeaders() {
  return {
    'Content-Type': 'application/json',
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  };
}

/**
 * Fetch the returning player's highest recorded score.
 * Filters the leaderboard by display name.
 */
async function fetchHighScore(displayName) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !displayName) return null;
  try {
    const url =
      `${SUPABASE_URL}/rest/v1/leaderboard` +
      `?select=Score` +
      `&Player=eq.${encodeURIComponent(displayName)}` +
      `&order=Score.desc&limit=1`;
    const res = await fetch(url, { headers: supabaseHeaders(), cache: 'no-store' });
    if (!res.ok) return null;
    const rows = await res.json();
    return rows?.[0]?.Score ?? null;
  } catch {
    return null;
  }
}

/**
 * Authenticate a player via 4-digit PIN.
 * Returns { success, returned_uuid, error_msg }
 */
async function authenticatePlayer(displayName, campus, pin, currentUuid) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return { success: true, returned_uuid: currentUuid, error_msg: '' };
  }
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/authenticate_player`, {
      method: 'POST',
      headers: supabaseHeaders(),
      body: JSON.stringify({
        p_name: displayName,
        p_campus: campus,
        p_pin: pin,
        p_client_uuid: currentUuid
      })
    });
    if (!res.ok) return { success: true, returned_uuid: currentUuid, error_msg: '' };
    const data = await res.json();
    return Array.isArray(data) ? data[0] : data;
  } catch {
    return { success: true, returned_uuid: currentUuid, error_msg: '' };
  }
}

/**
 * Fetch top-10 global leaderboard.
 * Columns: Player, Campus, Score
 */
async function fetchLeaderboard() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return [];
  try {
    const url =
      `${SUPABASE_URL}/rest/v1/leaderboard` +
      `?select=UUID,Player,Campus,Score` +
      `&order=Score.desc&limit=50`;
    const res = await fetch(url, { headers: supabaseHeaders(), cache: 'no-store' });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error('fetchLeaderboard failed:', err);
    return [];
  }
}

export async function fetchPlayerRank(uuid) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return 0;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_player_rank`, {
      method: 'POST',
      headers: supabaseHeaders(),
      body: JSON.stringify({ p_uuid: uuid }),
    });
    if (!res.ok) return 0;
    return await res.json();
  } catch (err) {
    console.error('fetchPlayerRank failed:', err);
    return 0;
  }
}

export async function fetchPlayerHighScore(uuid) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return 0;
  try {
    const url = `${SUPABASE_URL}/rest/v1/leaderboard?UUID=eq.${uuid}&select=Score&limit=1`;
    const res = await fetch(url, { headers: supabaseHeaders(), cache: 'no-store' });
    if (!res.ok) return 0;
    const data = await res.json();
    return data[0]?.Score ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Fetch top-3 for the live in-game mini-leaderboard.
 */
async function fetchTop3() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return [];
  try {
    const url =
      `${SUPABASE_URL}/rest/v1/leaderboard` +
      `?select=Player,Campus,Score` +
      `&order=Score.desc&limit=3`;
    const res = await fetch(url, { headers: supabaseHeaders(), cache: 'no-store' });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error('fetchTop3 failed:', err);
    return [];
  }
}

/**
 * Submit a signed score payload via Supabase RPC.
 */
async function submitSecureScore(payload) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Supabase not configured. Score saved locally.');
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/submit_secure_score`, {
    method: 'POST',
    headers: supabaseHeaders(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Leaderboard request failed (${res.status}).`);
  const accepted = await res.json();
  if (accepted !== true) throw new Error('The leaderboard rejected this score.');
  return true;
}

// ═════════════════════════════════════════════════════════════════════════
//  LEADERBOARD DOM RENDERER
// ═════════════════════════════════════════════════════════════════════════

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function renderLeaderboard(data, myRank, myScore) {
  if (!data || data.length === 0) {
    dom.leaderboardBody.innerHTML =
      '<div class="lb-empty">No scores yet. Be the first to dash! 🐭</div>';
    return;
  }

  const rankClass = (i) => (i < 3 ? ` rank-${i + 1}` : '');
  const rankIcon = (i) => ['🥇', '🥈', '🥉'][i] ?? `${i + 1}`;

  let html =
    `<table class="lb-table">` +
    `<thead><tr><th></th><th>Player</th><th>Campus</th>` +
    `<th style="text-align:right">Score</th></tr></thead><tbody>`;

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const isMe = row.UUID === playerProfile.uuid;
    const trClass = isMe ? 'lb-row lb-personal-row' : 'lb-row';
    html +=
      `<tr class="${trClass}">` +
      `<td class="rank${rankClass(i)}">${rankIcon(i)}</td>` +
      `<td class="player-name">${escapeHtml(row.Player ?? '???')}</td>` +
      `<td class="campus">${escapeHtml(row.Campus ?? '—')}</td>` +
      `<td class="score">${(row.Score ?? 0).toLocaleString()}</td>` +
      `</tr>`;
  }
  html += '</tbody></table>';
  dom.leaderboardBody.innerHTML = html;
}

async function openLeaderboard() {
  dom.leaderboardPanel.hidden = false;
  dom.leaderboardBody.className = 'lb-loading';
  dom.leaderboardBody.innerHTML = 'Loading scores...';

  const [data, myRank, myScore] = await Promise.all([
    fetchLeaderboard(),
    fetchPlayerRank(playerProfile.uuid),
    fetchPlayerHighScore(playerProfile.uuid)
  ]);

  if (myRank > 50) {
    dom.prRank.textContent = myRank;
    dom.prName.textContent = playerProfile.displayName;
    dom.prCampus.textContent = playerProfile.campus;
    dom.prScore.textContent = myScore.toLocaleString();
    dom.personalRankFooter.style.display = 'block';
  } else {
    dom.personalRankFooter.style.display = 'none';
  }

  renderLeaderboard(data, myRank, myScore);
}

function closeLeaderboard() {
  dom.leaderboardPanel.hidden = true;
}

// ═════════════════════════════════════════════════════════════════════════
//  PLAYER IDENTITY & AUTH
// ═════════════════════════════════════════════════════════════════════════

function createUuidV4() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function loadOrCreatePlayer() {
  try {
    const stored = JSON.parse(localStorage.getItem(PLAYER_STORAGE_KEY) ?? 'null');
    if (stored && typeof stored.uuid === 'string') {
      return {
        uuid: stored.uuid,
        displayName: typeof stored.displayName === 'string' ? stored.displayName : '',
        campus: typeof stored.campus === 'string' ? stored.campus : '',
      };
    }
  } catch {
    /* corrupt storage — generate fresh identity */
  }
  const newPlayer = { uuid: createUuidV4(), displayName: '', campus: '' };
  savePlayer(newPlayer);
  return newPlayer;
}

function savePlayer(player) {
  try {
    localStorage.setItem(PLAYER_STORAGE_KEY, JSON.stringify(player));
  } catch {
    /* private-mode limitation — session still works */
  }
}

function hasRunnerCard() {
  return Boolean(playerProfile.displayName.trim() && playerProfile.campus.trim());
}

let playerProfile = loadOrCreatePlayer();
let activeScene = null;

// ═════════════════════════════════════════════════════════════════════════
//  SHA-256 ANTI-CHEAT
// ═════════════════════════════════════════════════════════════════════════

async function sha256(value) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function createScorePayload(run) {
  const sessionTime = Math.max(0, Math.floor(run.durationMs / 1000));
  const signable = `${playerProfile.uuid}${run.score}${sessionTime}${CLIENT_SCORE_SALT}`;
  const clientHash = await sha256(signable);
  return {
    p_uuid: playerProfile.uuid,
    p_name: playerProfile.displayName,
    p_campus: playerProfile.campus,
    p_score: run.score,
    p_time: sessionTime,
    p_client_hash: clientHash,
  };
}

// ═════════════════════════════════════════════════════════════════════════
//  DOM UI LOGIC
// ═════════════════════════════════════════════════════════════════════════

function showProfileModal() {
  if (hasRunnerCard()) {
    // ── Returning player: welcome-back view ──
    dom.registerView.hidden = true;
    dom.welcomeView.hidden = false;
    dom.welcomeName.textContent = playerProfile.displayName;
    dom.welcomeHighScore.hidden = true;
    dom.welcomeSubtitle.textContent = 'Ready for another dash?';

    // Fetch their personal best in the background
    fetchHighScore(playerProfile.displayName).then((score) => {
      if (score !== null && score !== undefined) {
        dom.welcomeHighScoreVal.textContent = `Best: ${Number(score).toLocaleString()}`;
        dom.welcomeHighScore.hidden = false;
      }
    });
  } else {
    // ── New player: registration view ──
    dom.registerView.hidden = false;
    dom.welcomeView.hidden = true;
    dom.profileError.textContent = '';
    dom.displayName.value = playerProfile.displayName;
    dom.campus.value = playerProfile.campus;
  }
  dom.profileModal.hidden = false;
}

function closeProfileModal() {
  dom.profileModal.hidden = true;
}

function hideGameOverModal() {
  dom.gameOverModal.hidden = true;
  dom.submissionStatus.textContent = '';
}

function showMainMenuButtons(visible) {
  dom.mainMenuButtons.hidden = !visible;
}

// ═════════════════════════════════════════════════════════════════════════
//  DOM EVENT LISTENERS
// ═════════════════════════════════════════════════════════════════════════

// Registration form submit
dom.profileModal.addEventListener('submit', async (e) => {
  e.preventDefault();
  const displayName = dom.displayName.value.trim();
  const campus = dom.campus.value;
  const pin = dom.playerPin.value.trim();

  if (!displayName) {
    dom.profileError.textContent = 'Please choose a username.';
    return;
  }
  if (!campus) {
    dom.profileError.textContent = 'Please select your NIAT campus.';
    return;
  }
  if (!pin || pin.length !== 4 || !/^\d{4}$/.test(pin)) {
    dom.profileError.textContent = 'Please enter a valid 4-digit PIN.';
    return;
  }

  // Authenticate with server
  dom.profileError.textContent = 'Checking username and PIN…';
  dom.profileError.className = 'status';
  const authResult = await authenticatePlayer(displayName, campus, pin, playerProfile.uuid);
  
  if (!authResult || !authResult.success) {
    dom.profileError.textContent = authResult?.error_msg || `"${displayName}" is already taken.`;
    dom.profileError.className = 'status error';
    return;
  }
  dom.profileError.textContent = '';

  playerProfile = { 
    ...playerProfile, 
    uuid: authResult.returned_uuid, 
    displayName, 
    campus 
  };
  savePlayer(playerProfile);
  closeProfileModal();
  activeScene?.startRun();
});

// Welcome-back buttons
dom.welcomePlayBtn.addEventListener('click', () => {
  closeProfileModal();
  activeScene?.startRun();
});
dom.welcomeLeaderboardBtn.addEventListener('click', () => openLeaderboard());
dom.welcomeEditBtn.addEventListener('click', () => {
  // Generate a brand new ID so they are treated as a completely different player
  playerProfile = {
    uuid: crypto.randomUUID(),
    displayName: '',
    campus: '',
  };
  localStorage.removeItem('mushak-modak-dash.profile.v1');
  
  dom.registerView.hidden = false;
  dom.welcomeView.hidden = true;
  dom.profileError.textContent = '';
  dom.displayName.value = '';
  dom.campus.value = '';
  requestAnimationFrame(() => dom.displayName.focus());
});

// Score submission
dom.submitScore.addEventListener('click', async () => {
  if (!activeScene?.lastRun) return;
  dom.submitScore.disabled = true;
  dom.submissionStatus.textContent = 'Preparing signed score…';
  dom.submissionStatus.className = 'status';

  try {
    const payload = await createScorePayload(activeScene.lastRun);
    try { localStorage.setItem('mushak-modak-dash.pending-score.v1', JSON.stringify(payload)); } catch {}
    await submitSecureScore(payload);
    try { localStorage.removeItem('mushak-modak-dash.pending-score.v1'); } catch {}
    dom.submissionStatus.textContent = '✅ Score submitted to the leaderboard!';
    dom.submissionStatus.className = 'status success';
    // Refresh mini-leaderboard immediately so the player sees their new ranking
    activeScene?.refreshMiniLeaderboard();
  } catch (err) {
    dom.submissionStatus.textContent =
      err instanceof Error ? err.message : 'Could not submit. Try again.';
    dom.submissionStatus.className = 'status error';
    dom.submitScore.disabled = false;
  }
});

// Game-over buttons
dom.restartGame.addEventListener('click', () => activeScene?.restartRun());
dom.gameoverLeaderboardBtn.addEventListener('click', () => openLeaderboard());

// Main-menu / leaderboard buttons
dom.menuLeaderboardBtn.addEventListener('click', () => openLeaderboard());
dom.leaderboardCloseBtn.addEventListener('click', () => closeLeaderboard());

// Sound toggle
dom.soundToggleBtn.addEventListener('click', () => {
  if (!activeScene) return;
  const isMuted = activeScene.game.sound.mute;
  activeScene.game.sound.mute = !isMuted;
  dom.soundToggleBtn.textContent = !isMuted ? '🔇' : '🔊';
});

// ═════════════════════════════════════════════════════════════════════════
//  PHASER SCENE
// ═════════════════════════════════════════════════════════════════════════

class ModakDashScene extends Phaser.Scene {
  constructor() {
    super('ModakDashScene');
  }

  // ── PRELOAD ──────────────────────────────────────────────────────────
  preload() {
    // Drive the DOM micro-loader progress bar
    this.load.on('progress', (progress) => {
      const pct = Math.round(progress * 100);
      dom.loaderText.textContent = `Frying Modaks... ${pct}%`;
      dom.loaderBarFill.style.width = `${pct}%`;
      dom.loaderOverlay.setAttribute('aria-valuenow', String(pct));
    });

    this.load.once('complete', () => {
      dom.loaderOverlay.classList.add('hidden');
    });

    // Player emotional-state textures
    this.load.image('mushak-idle', '/mushak-idle.png');
    this.load.image('mushak-run', '/mushak-run.png');
    this.load.image('mushak-joyful', '/mushak-joyful.png');
    this.load.image('mushak-dizzy', '/mushak-dizzy.png');
    this.load.image('mushak-panic', '/mushak-panic.png');

    // Environment
    this.load.image('bg', '/background.png');
    this.load.image('ground', '/ground.png');

    // Entities
    this.load.image('pot', '/pot.png');
    this.load.image('modak', '/modak.png');
    this.load.image('spark', '/spark.png');

    // Audio
    this.load.audio('sfx-jump', '/jump.mp3');
    this.load.audio('sfx-collect', '/collect.mp3');
    this.load.audio('sfx-crash', '/crash.mp3');
  }

  // ── CREATE ───────────────────────────────────────────────────────────
  create() {
    activeScene = this;
    this.runState = 'ready';
    this.lastInputAt = -Infinity;
    this.lastRun = null;
    this.emotionalState = null;  // null so initial setEmotionalState always fires
    this.happyTimer = 0;
    this.jumpBufferTime = 0;

    this.createParallax();
    this.createWorld();
    this.createPools();
    this.createHud();
    this.createMiniLeaderboard();
    this.createParticles();
    this.setupColliders();
    this.setupInput();
    this.showStartGate();

    // Fetch initial top-3 leaderboard
    this.refreshMiniLeaderboard();

    // Poll every 30s for live updates
    this.leaderboardPollTimer = this.time.addEvent({
      delay: 30_000,
      callback: () => this.refreshMiniLeaderboard(),
      loop: true,
    });

    // Show auth modal after loader finishes
    this.time.delayedCall(600, () => {
      showProfileModal();
    });
  }

  // ── PARALLAX & TREADMILL LAYERS ──────────────────────────────────────
  createParallax() {
    // 1. Background — fit exactly to 600px canvas height to eliminate vertical repetition
    const bgImg = this.textures.get('bg').getSourceImage();
    const bgScale = GAME_HEIGHT / bgImg.height;

    this.bgLayer = this.add
      .tileSprite(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 'bg')
      .setDepth(0)
      .setScrollFactor(0)
      .setTint(0xbbbbbb);
    this.bgLayer.tileScaleX = bgScale;
    this.bgLayer.tileScaleY = bgScale;
    this.bgScale = bgScale;

    // 2. Ground treadmill — position the decorated stone footpath right at FLOOR_Y
    const groundImg = this.textures.get('ground').getSourceImage();
    const groundHeight = GAME_HEIGHT - FLOOR_Y; // 100px

    // In ground.png, the stone pattern spans the middle ~35% of the texture.
    // Scale so the stone strip matches the 100px ground height.
    const groundScale = groundHeight / (groundImg.height * 0.35);

    this.groundLayer = this.add
      .tileSprite(
        GAME_WIDTH / 2,
        FLOOR_Y + groundHeight / 2,
        GAME_WIDTH,
        groundHeight,
        'ground',
      )
      .setDepth(1)
      .setScrollFactor(0);

    this.groundLayer.tileScaleX = groundScale;
    this.groundLayer.tileScaleY = groundScale;
    this.groundScale = groundScale;

    // Center the stone pattern vertically within the 100px strip
    this.groundLayer.tilePositionY = (groundImg.height * 0.5) - (groundHeight / (2 * groundScale));
  }

  // ── WORLD (floor + player) ───────────────────────────────────────────
  createWorld() {
    // Invisible static floor collider
    this.floor = this.add.rectangle(
      GAME_WIDTH / 2,
      FLOOR_Y + 14,
      GAME_WIDTH,
      28,
      0x000000,
      0,
    );
    this.physics.add.existing(this.floor, true);

    // Player sprite
    this.player = this.physics.add
      .sprite(PLAYER_X, FLOOR_Y - 90, 'mushak-idle')
      .setScale(this.getPlayerScale('mushak-idle'))
      .setDepth(5);

    this.applyPlayerBodySize();
    this.player.setCollideWorldBounds(true);
    this.player.body.setMaxVelocity(0, 950);
  }

  /**
   * Helper to normalize scale across all mushak PNG textures (run, idle, joyful, panic, dizzy)
   * so they all share the exact same on-screen visual size and hitbox.
   */
  getPlayerScale(textureKey = this.player?.texture?.key || 'mushak-run') {
    if (this.textures && this.textures.exists(textureKey)) {
      const src = this.textures.get(textureKey).getSourceImage();
      // Reference resolution is mushak-run (2816px) at PLAYER_SCALE
      return PLAYER_SCALE * (2816 / src.width);
    }
    return PLAYER_SCALE;
  }

  /**
   * Helper to calibrate player physics body so feet touch FLOOR_Y accurately.
   */
  applyPlayerBodySize() {
    const body = this.player.body;
    // 40% width, 76% height with calibrated offset preserved exactly
    const bW = Math.floor(this.player.width * 0.40);
    const bH = Math.floor(this.player.height * 0.76);
    body.setSize(bW, bH);
    body.setOffset(
      Math.floor((this.player.width - bW) / 1.5),
      Math.floor(this.player.height - bH - 20),
    );
  }

  resetPotHitbox(pot) {
    // Shrunk slightly for 'Coyote Time' / edge forgiveness
    const pW = Math.floor(pot.width * 0.30);
    const pH = Math.floor(pot.height * 0.50);
    pot.body.setSize(pW, pH);
    pot.body.setOffset(
      Math.floor((pot.width - pW) / 2),
      Math.floor(pot.height - pH - 30),
    );
  }

  // ── OBJECT POOLS ─────────────────────────────────────────────────────
  createPools() {
    // 1. Obstacle pool (pots) — calibrated to ~80px obstacle height
    this.obstaclePool = this.physics.add.group();
    for (let i = 0; i < OBSTACLE_POOL_SIZE; i++) {
      const pot = this.obstaclePool
        .create(-400, -400, 'pot')
        .setScale(POT_SCALE)
        .setDepth(4);

      // Bottom-center origin so pot rests flush on FLOOR_Y
      pot.setOrigin(0.5, 1);

      // Tight, forgiving hitbox around clay pot
      this.resetPotHitbox(pot);

      pot.body.setAllowGravity(false);
      pot.setImmovable(true);
      this.deactivatePooledObject(this.obstaclePool, pot);
    }

    // 2. Collectible pool (modaks) — calibrated to ~50px sweet
    this.collectiblePool = this.physics.add.group();
    for (let i = 0; i < COLLECTIBLE_POOL_SIZE; i++) {
      const modak = this.collectiblePool
        .create(-400, -400, 'modak')
        .setScale(MODAK_SCALE)
        .setDepth(3);

      // Bottom-center origin so it rests flush on FLOOR_Y like pots
      modak.setOrigin(0.5, 1);

      // Add golden aura/shine behind the modak
      if (modak.preFX) {
        modak.preFX.addGlow(0xffcc00, 4, 0, false, 0.1, 24);
      }

      // Calibrate hitbox tightly to visible golden modak bounds (216×207 unscaled)
      const mW = 216;
      const mH = 207;
      modak.body.setSize(mW, mH, true);
      modak.body.setAllowGravity(false);
      this.deactivatePooledObject(this.collectiblePool, modak);
    }
  }

  // ── HUD ──────────────────────────────────────────────────────────────
  createHud() {
    const fontFamily = "'Outfit', Arial, sans-serif";

    this.scoreText = this.add
      .text(GAME_WIDTH / 2, 20, 'SCORE: 000000', {
        fontFamily,
        fontSize: '28px',
        fontStyle: 'bold',
        color: '#fff9de',
        stroke: '#54213e',
        strokeThickness: 6,
      })
      .setOrigin(0.5, 0)
      .setDepth(20);

    this.speedText = this.add
      .text(GAME_WIDTH - 20, 24, 'Dash speed ×1.0', {
        fontFamily,
        fontSize: '15px',
        fontStyle: 'bold',
        color: '#fff4c8',
        stroke: '#54213e',
        strokeThickness: 4,
      })
      .setOrigin(1, 0)
      .setDepth(20);

    this.startPrompt = this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 30, 'TAP TO START', {
        fontFamily,
        fontSize: '40px',
        fontStyle: 'bold',
        color: '#fff6c7',
        stroke: '#54213e',
        strokeThickness: 8,
      })
      .setOrigin(0.5)
      .setDepth(20);

    this.startHint = this.add
      .text(
        GAME_WIDTH / 2,
        GAME_HEIGHT / 2 + 20,
        'Tap / Space / ↑ to jump  •  Again mid-air for double jump',
        {
          fontFamily,
          fontSize: '14px',
          color: '#fff4db',
          stroke: '#54213e',
          strokeThickness: 3,
        },
      )
      .setOrigin(0.5)
      .setDepth(20);
  }

  // ── MINI LEADERBOARD (Live Top 3) ─────────────────────────────────────
  createMiniLeaderboard() {
    const fontFamily = "'Outfit', Arial, sans-serif";
    const medals = ['🥇', '🥈', '🥉'];

    // Semi-transparent background panel
    this.lbPanel = this.add.graphics().setDepth(19);
    this.lbPanel.fillStyle(0x351827, 0.55);
    this.lbPanel.fillRoundedRect(10, 12, 220, 75, 8);

    this.lbNameTexts = [];
    this.lbScoreTexts = [];
    this.lbCampusTexts = [];

    const textStyle = {
      fontFamily,
      fontSize: '12px',
      fontStyle: 'bold',
      color: '#ffffff',
      stroke: '#1a0a12',
      strokeThickness: 3,
    };

    for (let i = 0; i < 3; i++) {
      const y = 18 + i * 22;
      const nameTxt = this.add.text(18, y, `${medals[i]} ---`, textStyle).setDepth(20);
      const scoreTxt = this.add.text(105, y, '', textStyle).setDepth(20);
      const campusTxt = this.add.text(140, y, '', textStyle).setDepth(20);

      this.lbNameTexts.push(nameTxt);
      this.lbScoreTexts.push(scoreTxt);
      this.lbCampusTexts.push(campusTxt);
    }
  }

  async refreshMiniLeaderboard() {
    try {
      const top3 = await fetchTop3();
      const medals = ['🥇', '🥈', '🥉'];
      for (let i = 0; i < 3; i++) {
        if (top3[i]) {
          const name = top3[i].Player?.length > 10
            ? top3[i].Player.substring(0, 10) + '…'
            : (top3[i].Player ?? '???');
          const score = (top3[i].Score ?? 0).toLocaleString();
          let campus = top3[i].Campus || '';
          if (campus.length > 14) campus = campus.substring(0, 14) + '…';

          this.lbNameTexts[i].setText(`${medals[i]} ${name}`);
          this.lbScoreTexts[i].setText(score);
          this.lbCampusTexts[i].setText(campus);
        } else {
          this.lbNameTexts[i].setText(`${medals[i]} ---`);
          this.lbScoreTexts[i].setText('');
          this.lbCampusTexts[i].setText('');
        }
      }
    } catch {
      // Silently ignore fetch errors
    }
  }

  // ── PARTICLES ────────────────────────────────────────────────────────
  createParticles() {
    // Crisp golden sparkle VFX on modak collection
    this.sparkEmitter = this.add
      .particles(0, 0, 'spark', {
        speed: { min: 80, max: 180 },
        angle: { min: 200, max: 340 },
        scale: { start: SPARK_SCALE_START, end: 0 },
        alpha: { start: 1, end: 0 },
        lifespan: 360,
        gravityY: 260,
        quantity: 8,
        emitting: false,
      })
      .setDepth(8);
  }

  // ── COLLIDERS ────────────────────────────────────────────────────────
  setupColliders() {
    this.physics.add.collider(this.player, this.floor);

    this.physics.add.collider(
      this.player,
      this.obstaclePool,
      this.handleObstacleHit,
      (player, obstacle) => player.body.enable && obstacle.body.enable,
      this,
    );

    this.physics.add.overlap(
      this.player,
      this.collectiblePool,
      this.collectModak,
      undefined,
      this,
    );
  }

  // ── INPUT (Universal: Mobile Touch + Keyboard) ───────────────────────
  setupInput() {
    this.input.on('pointerdown', () => this.executeJump());

    if (this.input.keyboard) {
      this.input.keyboard.on('keydown-SPACE', () => this.executeJump());
      this.input.keyboard.on('keydown-UP', () => this.executeJump());
    }
  }

  executeJump() {
    // Ignore key presses while filling DOM input fields
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
      return;
    }

    const now = this.time.now;
    if (now - this.lastInputAt < 110) return;
    this.lastInputAt = now;

    if (this.runState === 'ready') {
      if (hasRunnerCard()) {
        this.startRun();
      } else {
        this.runState = 'profile';
        showProfileModal();
      }
      return;
    }

    if (this.runState !== 'playing') return;

    const grounded = this.player.body.blocked.down || this.player.body.onFloor();

    if (grounded) {
      // Primary jump
      this.player.setVelocityY(-700);
      this.canDoubleJump = true;
      this.safePlaySound('sfx-jump');
    } else if (this.canDoubleJump) {
      // Double jump — panic face
      this.player.setVelocityY(-550);
      this.canDoubleJump = false;
      this.setEmotionalState(EmotionalState.PANIC);
      this.safePlaySound('sfx-jump', 0.7);
    } else {
      // Jump buffering: player clicked just before landing.
      // Save this input to execute the exact millisecond they touch the ground!
      this.jumpBufferTime = this.time.now;
    }
  }

  // ── START GATE ───────────────────────────────────────────────────────
  showStartGate() {
    this.startPrompt.setVisible(true);
    this.startHint.setVisible(true);
    this.scoreText.setText('SCORE: 000000');
    this.speedText.setText('Dash speed ×1.0');
    this.setEmotionalState(EmotionalState.IDLE);
    showMainMenuButtons(true);
  }

  // ── RUN LIFECYCLE ────────────────────────────────────────────────────
  startRun() {
    closeProfileModal();
    hideGameOverModal();
    showMainMenuButtons(false);

    this.runState = 'playing';
    this.canDoubleJump = false;
    this.runStartedAt = this.time.now;
    this.durationMs = 0;
    this.distanceTravelled = 0;
    this.collectionScore = 0;
    this.currentScore = 0;
    this.scrollVelocity = BASE_SCROLL_VELOCITY;
    this.nextObstacleAt = Phaser.Math.Between(850, 1250);
    this.nextCollectibleAt = Phaser.Math.Between(650, 1000);
    this.happyTimer = 0;

    this.startPrompt.setVisible(false);
    this.startHint.setVisible(false);

    this.physics.world.resume();

    this.player.enableBody(true, PLAYER_X, FLOOR_Y - 90, true, true);
    this.player.clearTint().setAngle(0).setVelocity(0, 0);
    this.player.setScale(this.getPlayerScale());
    this.player.body.setAllowGravity(true);
    this.applyPlayerBodySize();

    this.emotionalState = null;
    this.setEmotionalState(EmotionalState.RUN);

    this.lastInputAt = this.time.now;
    this.updateHud();
  }

  restartRun() {
    this.flushPools();
    this.lastRun = null;
    this.startRun();
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  EMOTIONAL STATE MACHINE
  // ═══════════════════════════════════════════════════════════════════════

  setEmotionalState(state) {
    if (this.emotionalState === state) return;
    this.emotionalState = state;

    const textureKey = STATE_TEXTURE_MAP[state];
    if (textureKey && this.textures.exists(textureKey)) {
      this.player.setTexture(textureKey);

      // Re-apply calibrated scale + body size after every texture swap
      this.player.setScale(this.getPlayerScale(textureKey));
      this.applyPlayerBodySize();
    }

    if (state === EmotionalState.FOCUSED) {
      this.player.setTint(0x88bbff);
    } else if (state !== EmotionalState.DIZZY) {
      this.player.clearTint();
    }
  }

  updateEmotionalState(delta) {
    if (this.runState !== 'playing') return;

    const grounded = this.player.body.blocked.down || this.player.body.onFloor();

    if (this.happyTimer > 0) {
      this.happyTimer -= delta;
      if (this.happyTimer <= 0) {
        this.happyTimer = 0;
        if (this.scrollVelocity < FOCUSED_SPEED_THRESHOLD) {
          this.setEmotionalState(EmotionalState.FOCUSED);
        } else {
          this.setEmotionalState(EmotionalState.RUN);
        }
      }
      return;
    }

    if (this.emotionalState === EmotionalState.PANIC && grounded) {
      if (this.scrollVelocity < FOCUSED_SPEED_THRESHOLD) {
        this.setEmotionalState(EmotionalState.FOCUSED);
      } else {
        this.setEmotionalState(EmotionalState.RUN);
      }
      return;
    }

    if (
      this.emotionalState === EmotionalState.RUN &&
      this.scrollVelocity < FOCUSED_SPEED_THRESHOLD
    ) {
      this.setEmotionalState(EmotionalState.FOCUSED);
    }
  }

  triggerHappyFlash() {
    this.happyTimer = HAPPY_FLASH_DURATION;
    this.setEmotionalState(EmotionalState.HAPPY);
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  UPDATE LOOP
  // ═══════════════════════════════════════════════════════════════════════

  update(_time, delta) {
    // Ambient slow scroll on menu screen
    if (this.bgLayer) {
      this.bgLayer.tilePositionX += 0.3;
    }

    if (this.runState !== 'playing') return;

    const dt = Math.min(delta, 50);
    this.durationMs += dt;
    this.distanceTravelled += Math.abs(this.scrollVelocity) * (dt / 1000);

    // Speed escalation based on BOTH time survived and score accumulated!
    // Every 15 seconds adds 1 speed step. Every 200 points adds 1 speed step.
    const timeSteps = Math.floor(this.durationMs / SPEED_STEP_INTERVAL);
    const scoreSteps = Math.floor(this.currentScore / 200);
    this.scrollVelocity = BASE_SCROLL_VELOCITY + ((timeSteps + scoreSteps) * SPEED_STEP);

    // Spawn obstacles
    if (this.durationMs >= this.nextObstacleAt) {
      const obstacleType = this.spawnObstacle();
      const speedFactor = Math.abs(this.scrollVelocity / BASE_SCROLL_VELOCITY);
      let gap = Math.max(
        750, // Hard limit minimum gap so it's never physically impossible to recover
        Math.floor(Phaser.Math.Between(1200, 2600) / speedFactor),
      );
      if (obstacleType === 'double') {
        // Generous spacing after double horizontal hurdle so player lands and recovers cleanly
        gap += Math.round(Math.abs(this.scrollVelocity) * 0.65);
      } else if (obstacleType === 'stacked') {
        // Generous runway after clearing a tall 2-pot pillar
        gap += Math.round(Math.abs(this.scrollVelocity) * 0.70);
      }
      this.nextObstacleAt += gap;

      // Cooldown: prevent timed collectibles from spawning on top of obstacle-attached modaks
      this.nextCollectibleAt = Math.max(this.nextCollectibleAt, this.durationMs + 600);
    }

    // Spawn collectibles (wider random variation)
    if (this.durationMs >= this.nextCollectibleAt) {
      this.spawnCollectible();
      this.nextCollectibleAt += Phaser.Math.Between(500, 1800);
    }

    if (this.player.body.blocked.down || this.player.body.onFloor()) {
      this.canDoubleJump = true;
      
      // Execute buffered jump if they clicked within the last 150ms!
      if (this.jumpBufferTime > 0 && this.time.now - this.jumpBufferTime < 150) {
        this.jumpBufferTime = 0;
        this.player.setVelocityY(-700);
        this.safePlaySound('sfx-jump');
      }
    }

    // Parallax scrolling
    const pxMoved = Math.abs(this.scrollVelocity) * (dt / 1000);
    this.bgLayer.tilePositionX += (pxMoved * 0.15) / this.bgScale;
    this.groundLayer.tilePositionX += pxMoved / this.groundScale;

    // Recycle off-screen pooled objects
    this.recycleAndScroll(this.obstaclePool, -150);
    this.recycleAndScroll(this.collectiblePool, -120);

    this.updateEmotionalState(dt);
    this.updateHud();
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  SPAWNING
  // ═══════════════════════════════════════════════════════════════════════

  getDoublePotChance() {
    if (this.scrollVelocity > DOUBLE_POT_SPEED_THRESHOLD) return 0;
    // At -400: ~40% chance. Scales up to 75% as speed escalates
    const speedRatio = (Math.abs(this.scrollVelocity) - 400) / 200;
    return Phaser.Math.Clamp(0.40 + speedRatio * 0.35, 0.40, 0.75);
  }

  spawnObstacle() {
    const canStacked = this.scrollVelocity <= STACKED_POT_SPEED_THRESHOLD;
    const canDouble = this.scrollVelocity <= DOUBLE_POT_SPEED_THRESHOLD;

    // 1. High difficulty check: Stacked 2-pot pillar (unlocked at -450px/s)
    if (canStacked && Math.random() < 0.35) {
      const success = this.spawnStackedObstacle();
      if (success) return 'stacked';
    }

    // 2. Medium difficulty check: Double horizontal pots (unlocked at -400px/s)
    if (canDouble && Math.random() < this.getDoublePotChance()) {
      const success = this.spawnDoubleObstacle();
      if (success) return 'double';
    }

    // 3. Standard obstacle: Single pot
    this.spawnSingleObstacle();
    return 'single';
  }

  // Check if an X coordinate is too close to any active pot
  isNearPotX(x, distance = 220) {
    let near = false;
    this.obstaclePool.children.iterate((pot) => {
      if (!pot?.active) return;
      if (Math.abs(x - pot.x) < distance) {
        near = true;
      }
    });
    return near;
  }

  // Strict collision check: guarantees no modak-to-modak overlap AND no modak-to-pot overlap
  canSpawnModakAt(x, y) {
    // 1. Minimum distance from ANY existing active modak (prevents modak overlap)
    let modakConflict = false;
    this.collectiblePool.children.iterate((m) => {
      if (!m?.active) return;
      // Horizontal-only guard: prevents same-X vertical stacking
      if (Math.abs(x - m.x) < 100) {
        modakConflict = true;
        return;
      }
      // Euclidean guard: prevents close diagonal/same-height overlap
      const dist = Phaser.Math.Distance.Between(x, y, m.x, m.y);
      if (dist < 130) {
        modakConflict = true;
      }
    });
    if (modakConflict) return false;

    // 2. Strict separation from all active pots:
    let potConflict = false;
    this.obstaclePool.children.iterate((pot) => {
      if (!pot?.active) return;
      const dx = Math.abs(x - pot.x);
      if (dx < 220) {
        // Ground modaks (y > 310) are strictly forbidden within 220px of ANY pot
        if (y > 310) {
          potConflict = true;
        }
        // Aerial modaks must be well separated above the pot
        if (y > pot.y - 120) {
          potConflict = true;
        }
      }
    });
    if (potConflict) return false;

    return true;
  }

  spawnSingleModak(x, y) {
    if (!this.canSpawnModakAt(x, y)) return null;
    const modak = this.collectiblePool.getFirstDead(false);
    if (!modak) return null;
    this.activatePooledObject(modak, x, y);

    // Vibrant shining golden tint
    modak.setTint(0xffcc00);

    // Safe visual-only pulse — decoupled from physics AABB hitbox
    this.tweens.killTweensOf(modak);
    modak.setAngle(0);
    modak.setScale(MODAK_SCALE);

    this.tweens.add({
      targets: modak,
      scale: MODAK_SCALE * 1.15,
      duration: 600,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut'
    });

    modak.setVelocityX(this.scrollVelocity);
    return modak;
  }

  spawnSingleObstacle() {
    const pot = this.obstaclePool.getFirstDead(false);
    if (!pot) return false;

    // With origin (0.5, 1), Y = FLOOR_Y places the pot directly on the ground
    this.resetPotHitbox(pot);
    const spawnX = GAME_WIDTH + 100;
    this.activatePooledObject(pot, spawnX, FLOOR_Y);
    pot.setTint(0xffcccc); // Darker reddish-grey silhouette
    pot.setVelocityX(this.scrollVelocity);

    // 50% chance: spawn 1 modak AHEAD of the pot (200px lead) so it's visually separated
    if (Math.random() < 0.50) {
      this.spawnSingleModak(spawnX + 200, 320);
    }

    return true;
  }

  spawnDoubleObstacle() {
    const deadPots = this.obstaclePool.getMatching('active', false);
    if (deadPots.length < 2) return false;

    const pot1 = deadPots[0];
    const pot2 = deadPots[1];

    const spawnX = GAME_WIDTH + 100;
    // Calibrated spacing: precisely ~0.50s apart so a well-timed double jump peak clears pot 2
    const spacing = Math.round(Math.abs(this.scrollVelocity) * 0.50);

    this.resetPotHitbox(pot1);
    this.activatePooledObject(pot1, spawnX, FLOOR_Y);
    pot1.setTint(0xffcccc); // Darker reddish-grey silhouette
    pot1.setVelocityX(this.scrollVelocity);

    this.resetPotHitbox(pot2);
    this.activatePooledObject(pot2, spawnX + spacing, FLOOR_Y);
    pot2.setTint(0xffcccc); // Darker reddish-grey silhouette
    pot2.setVelocityX(this.scrollVelocity);

    // 1 modak AHEAD of the double hurdle at jump apex (leads the first pot)
    this.spawnSingleModak(spawnX + Math.round(spacing / 2), 300);

    return true;
  }

  spawnStackedObstacle() {
    const deadPots = this.obstaclePool.getMatching('active', false);
    if (deadPots.length < 2) return false;

    const potBottom = deadPots[0];
    const potTop = deadPots[1];

    const spawnX = GAME_WIDTH + 100;
    // In pot.png, visible pot artwork height is 218px.
    // At POT_SCALE (0.30), visible height = 218 * 0.30 = 65.4px (~65px).
    const stackDeltaY = Math.round(218 * POT_SCALE);

    // 1. Bottom pot rests on the floor
    this.resetPotHitbox(potBottom);
    this.activatePooledObject(potBottom, spawnX, FLOOR_Y);
    potBottom.setTint(0xffcccc); // Darker reddish-grey silhouette
    potBottom.setVelocityX(this.scrollVelocity);

    // 2. Top pot sits directly on bottom pot's rim with 0 visual gap
    this.activatePooledObject(potTop, spawnX, FLOOR_Y - stackDeltaY);
    potTop.setTint(0xffcccc); // Darker reddish-grey silhouette
    potTop.setVelocityX(this.scrollVelocity);

    // 3. Calibrate top pot hitbox so it meets bottom pot hitbox with 0 gap
    const pW = Math.floor(potTop.width * 0.40);
    const pH = Math.floor(potTop.height * 0.60);
    potTop.body.setSize(pW, pH);
    potTop.body.setOffset(Math.floor((potTop.width - pW) / 2), 104);

    // 1 modak cleanly UP ahead of the tall pillar
    this.spawnSingleModak(spawnX + 200, 280);

    return true;
  }

  spawnCollectible() {
    const spawnX = GAME_WIDTH + 100;

    // Ground modaks must NEVER spawn near active pots (require 300px clear runway)
    // AND must avoid spawning exactly when an obstacle is about to spawn (400ms buffer)
    if (this.isNearPotX(spawnX, 300) || (this.nextObstacleAt - this.durationMs < 400)) {
      this.nextCollectibleAt = this.durationMs + 350;
      return;
    }

    // On open runway: either cleanly on the ground or gentle hop height
    const onGround = Math.random() < 0.60;
    // With origin(0.5, 1), Y = FLOOR_Y places it perfectly flush with the ground
    const spawnY = onGround ? FLOOR_Y : 400;

    this.spawnSingleModak(spawnX, spawnY);
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  POOL HELPERS
  // ═══════════════════════════════════════════════════════════════════════

  activatePooledObject(sprite, x, y) {
    sprite.enableBody(true, x, y, true, true);
    sprite.body.setAllowGravity(false);
    sprite.setImmovable(true);
  }

  deactivatePooledObject(pool, sprite) {
    pool.killAndHide(sprite);
    sprite.body.stop();
    sprite.body.enable = false;
    sprite.setPosition(-400, -400);
    // Clean up visual effects for proper pool recycling
    sprite.clearTint();
    sprite.setAngle(0);
    this.tweens.killTweensOf(sprite);
    if (pool === this.obstaclePool) {
      this.resetPotHitbox(sprite);
    }
  }

  recycleAndScroll(pool, leftEdge) {
    pool.children.iterate((sprite) => {
      if (!sprite?.active) return;
      sprite.setVelocityX(this.scrollVelocity);
      if (sprite.x < leftEdge) {
        this.deactivatePooledObject(pool, sprite);
      }
    });
  }

  flushPools() {
    this.obstaclePool.children.iterate((s) => {
      if (s) this.deactivatePooledObject(this.obstaclePool, s);
    });
    this.collectiblePool.children.iterate((s) => {
      if (s) this.deactivatePooledObject(this.collectiblePool, s);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  COLLISION CALLBACKS
  // ═══════════════════════════════════════════════════════════════════════

  collectModak(_player, modak) {
    if (this.runState !== 'playing' || !modak.active) return;

    const { x, y } = modak;
    this.deactivatePooledObject(this.collectiblePool, modak);
    this.collectionScore += MODAK_POINTS;
    this.triggerHappyFlash();

    // Burst sparkle VFX
    this.sparkEmitter.explode(8, x, y);
    this.safePlaySound('sfx-collect');
    this.updateHud();
  }

  /**
   * Mushak trips — cultural respect: no violence, sits down dizzily.
   */
  handleObstacleHit() {
    if (this.runState !== 'playing') return;
    this.runState = 'game-over';

    // Disable body immediately to prevent duplicate collision triggers
    this.player.body.enable = false;

    this.lastRun = { score: this.currentScore, durationMs: this.durationMs };

    this.setEmotionalState(EmotionalState.DIZZY);
    this.player.setVelocity(0, 0).setAngle(18);

    this.safePlaySound('sfx-crash');
    this.flushPools();
    this.physics.world.pause();

    // Show game-over overlay
    dom.finalScore.textContent = this.currentScore.toLocaleString();
    dom.finalDuration.textContent = `${(this.durationMs / 1000).toFixed(1)} seconds`;
    dom.submissionStatus.textContent = '';
    dom.submissionStatus.className = 'status';
    dom.submitScore.disabled = false;
    dom.gameOverModal.hidden = false;
  }

  // ── HUD ──────────────────────────────────────────────────────────────
  updateHud() {
    const distanceScore = Math.floor(this.distanceTravelled / 180);
    this.currentScore = distanceScore + this.collectionScore;
    this.scoreText.setText(
      `SCORE: ${String(this.currentScore).padStart(6, '0')}`,
    );
    const multiplier = Math.abs(
      this.scrollVelocity / BASE_SCROLL_VELOCITY,
    ).toFixed(1);
    this.speedText.setText(`Dash speed ×${multiplier}`);
  }

  // ── AUDIO ────────────────────────────────────────────────────────────
  safePlaySound(key, volume = 1) {
    try {
      if (this.sound && this.cache.audio.exists(key)) {
        this.sound.play(key, { volume });
      }
    } catch {
      // Audio may fail before user gesture
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  GAME BOOT
// ═════════════════════════════════════════════════════════════════════════

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game-container',
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  backgroundColor: '#351827',
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  render: {
    antialias: true,
    pixelArt: false,
    powerPreference: 'high-performance',
  },
  physics: {
    default: 'arcade',
    arcade: {
      gravity: { y: 1500 },
      debug: false,
    },
  },
  scene: [ModakDashScene],
  audio: {
    disableWebAudio: false,
  },
});

// ═════════════════════════════════════════════════════════════════════════
//  UI SCALING (Sync HTML Overlay with Game Canvas)
// ═════════════════════════════════════════════════════════════════════════
function syncOverlayScale() {
  const overlay = document.getElementById('overlay-layer');
  if (!overlay) return;
  const scaleX = window.innerWidth / GAME_WIDTH;
  const scaleY = window.innerHeight / GAME_HEIGHT;
  const scale = Math.min(scaleX, scaleY);
  overlay.style.transform = `translate(-50%, -50%) scale(${scale})`;
}
window.addEventListener('resize', syncOverlayScale);
syncOverlayScale();
