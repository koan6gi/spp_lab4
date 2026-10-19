const GRID_WIDTH = 24;
const GRID_HEIGHT = 24;
const STORAGE_TOKEN_KEY = 'mmo_minesweeper_token';
const STORAGE_NICK_KEY = 'mmo_minesweeper_nickname';

let socket = null;
let reconnectTimer = null;
let localTimerInterval = null;
let roundEndTimerInterval = null;

let localGrid = [];
let localTimeLeft = 600;
let currentRoundStatus = 'PLAYING';
let currentTouchMode = 'reveal'; // 'reveal' | 'flag'
let myToken = localStorage.getItem(STORAGE_TOKEN_KEY);
let myNickname = localStorage.getItem(STORAGE_NICK_KEY);

const boardEl = document.getElementById('board');
const timerValueEl = document.getElementById('timerValue');
const playerNameEl = document.getElementById('playerName');
const playerScoreEl = document.getElementById('playerScore');
const leaderboardListEl = document.getElementById('leaderboardList');
const pastChampionsListEl = document.getElementById('pastChampionsList');

const digModeBtn = document.getElementById('digModeBtn');
const flagModeBtn = document.getElementById('flagModeBtn');

const nicknameModal = document.getElementById('nicknameModal');
const nicknameForm = document.getElementById('nicknameForm');
const nicknameInput = document.getElementById('nicknameInput');
const nicknameError = document.getElementById('nicknameError');

const roundEndModal = document.getElementById('roundEndModal');
const roundEndIcon = document.getElementById('roundEndIcon');
const roundEndTitle = document.getElementById('roundEndTitle');
const roundEndSubtitle = document.getElementById('roundEndSubtitle');
const roundEndTop3List = document.getElementById('roundEndTop3List');
const roundEndCountdown = document.getElementById('roundEndCountdown');

const reconnectOverlay = document.getElementById('reconnectOverlay');

function initLocalGrid() {
  localGrid = [];
  boardEl.innerHTML = '';

  for (let y = 0; y < GRID_HEIGHT; y++) {
    const row = [];
    for (let x = 0; x < GRID_WIDTH; x++) {
      const cellData = {
        x,
        y,
        state: 'hidden',
        version: 0,
        adjacentMines: 0,
        isMine: false
      };
      row.push(cellData);

      const cellEl = document.createElement('div');
      cellEl.className = 'cell hidden';
      cellEl.dataset.x = String(x);
      cellEl.dataset.y = String(y);

      boardEl.appendChild(cellEl);
    }
    localGrid.push(row);
  }
}

function getCellElement(x, y) {
  const index = y * GRID_WIDTH + x;
  return boardEl.children[index];
}

function updateCellDOM(cell) {
  const el = getCellElement(cell.x, cell.y);
  if (!el) return;

  el.className = 'cell';
  el.removeAttribute('data-mines');

  if (cell.state === 'hidden') {
    el.classList.add('hidden');
    el.textContent = '';
  } else if (cell.state === 'flagged') {
    el.classList.add('flagged');
    el.textContent = '🚩';
  } else if (cell.state === 'revealed') {
    el.classList.add('revealed');
    if (cell.isMine) {
      el.classList.add('mine');
      el.textContent = '💣';
    } else if (typeof cell.adjacentMines === 'number' && cell.adjacentMines > 0) {
      el.dataset.mines = String(cell.adjacentMines);
      el.textContent = String(cell.adjacentMines);
    } else {
      el.textContent = '';
    }
  }
}

function applyCellUpdate(cellData) {
  if (!cellData || cellData.y < 0 || cellData.y >= GRID_HEIGHT || cellData.x < 0 || cellData.x >= GRID_WIDTH) {
    return;
  }

  const existing = localGrid[cellData.y][cellData.x];
  existing.state = cellData.state;
  existing.version = cellData.version;

  if (typeof cellData.adjacentMines === 'number') {
    existing.adjacentMines = cellData.adjacentMines;
  }
  if (typeof cellData.isMine === 'boolean') {
    existing.isMine = cellData.isMine;
  }

  updateCellDOM(existing);
}

function formatTime(seconds) {
  const clamped = Math.max(0, Math.floor(seconds));
  const m = Math.floor(clamped / 60);
  const s = clamped % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function startLocalTimer(initialSeconds) {
  if (localTimerInterval) clearInterval(localTimerInterval);
  localTimeLeft = initialSeconds;
  timerValueEl.textContent = formatTime(localTimeLeft);

  localTimerInterval = setInterval(() => {
    if (currentRoundStatus !== 'PLAYING') return;
    localTimeLeft = Math.max(0, localTimeLeft - 1);
    timerValueEl.textContent = formatTime(localTimeLeft);
  }, 1000);
}

function renderLeaderboard(list) {
  leaderboardListEl.innerHTML = '';
  if (!list || list.length === 0) {
    leaderboardListEl.innerHTML = '<div class="empty-state">Waiting for players...</div>';
    return;
  }

  list.forEach((player, index) => {
    const item = document.createElement('div');
    item.className = 'leader-item';
    if (player.nickname === myNickname) {
      item.classList.add('current-user');
      playerScoreEl.textContent = `${player.score} pts`;
    }

    const afkBadge = player.isAfk ? '<span class="leader-afk">(AFK)</span>' : '';

    item.innerHTML = `
      <div class="leader-left">
        <span class="leader-rank">#${index + 1}</span>
        <span class="leader-name">${escapeHTML(player.nickname)}${afkBadge}</span>
      </div>
      <span class="leader-score">${player.score} pts</span>
    `;
    leaderboardListEl.appendChild(item);
  });
}

function renderPastChampions(top3) {
  pastChampionsListEl.innerHTML = '';
  if (!top3 || top3.length === 0) {
    pastChampionsListEl.innerHTML = '<div class="empty-state">No previous rounds yet</div>';
    return;
  }

  top3.forEach((p, index) => {
    const medals = ['🥇', '🥈', '🥉'];
    const item = document.createElement('div');
    item.className = 'leader-item';
    item.innerHTML = `
      <div class="leader-left">
        <span class="leader-rank">${medals[index] || `#${index + 1}`}</span>
        <span class="leader-name">${escapeHTML(p.nickname)}</span>
      </div>
      <span class="leader-score">${p.score} pts</span>
    `;
    pastChampionsListEl.appendChild(item);
  });
}

function showRoundEndModal(status, top3, countdownSeconds) {
  currentRoundStatus = status;
  roundEndModal.classList.remove('hidden');

  if (status === 'VICTORY') {
    roundEndIcon.textContent = '🎉';
    roundEndTitle.textContent = 'Round Victory!';
    roundEndSubtitle.textContent = 'All mines cleared or safe cells uncovered!';
  } else if (status === 'DEFEAT') {
    roundEndIcon.textContent = '💥';
    roundEndTitle.textContent = 'Round Defeat!';
    roundEndSubtitle.textContent = 'A mine was triggered or a flag was placed on a safe cell!';
  } else {
    roundEndIcon.textContent = '⏰';
    roundEndTitle.textContent = 'Time Expired!';
    roundEndSubtitle.textContent = 'The 10-minute round timer has run out!';
  }

  roundEndTop3List.innerHTML = '';
  if (!top3 || top3.length === 0) {
    roundEndTop3List.innerHTML = '<div class="empty-state">No scores recorded this round</div>';
  } else {
    top3.forEach((p, idx) => {
      const medals = ['🥇', '🥈', '🥉'];
      const div = document.createElement('div');
      div.className = 'leader-item';
      div.innerHTML = `
        <div class="leader-left">
          <span class="leader-rank">${medals[idx] || `#${idx + 1}`}</span>
          <span class="leader-name">${escapeHTML(p.nickname)}</span>
        </div>
        <span class="leader-score">${p.score} pts</span>
      `;
      roundEndTop3List.appendChild(div);
    });
  }

  let remaining = countdownSeconds || 10;
  roundEndCountdown.textContent = `${remaining}s`;

  if (roundEndTimerInterval) clearInterval(roundEndTimerInterval);
  roundEndTimerInterval = setInterval(() => {
    remaining = Math.max(0, remaining - 1);
    roundEndCountdown.textContent = `${remaining}s`;
    if (remaining <= 0) {
      clearInterval(roundEndTimerInterval);
    }
  }, 1000);
}

function hideRoundEndModal() {
  roundEndModal.classList.add('hidden');
  if (roundEndTimerInterval) clearInterval(roundEndTimerInterval);
}

function escapeHTML(str) {
  const p = document.createElement('p');
  p.textContent = str || '';
  return p.innerHTML;
}

function sendCellAction(x, y, action) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (currentRoundStatus !== 'PLAYING') return;

  const cell = localGrid[y]?.[x];
  if (!cell || cell.state !== 'hidden') return;

  socket.send(JSON.stringify({
    type: 'CELL_ACTION',
    x,
    y,
    action,
    expectedVersion: cell.version
  }));
}

function connectWebSocket() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  socket = new WebSocket(wsUrl);

  socket.addEventListener('open', () => {
    reconnectOverlay.classList.add('hidden');

    if (myToken) {
      socket.send(JSON.stringify({
        type: 'RECONNECT',
        token: myToken
      }));
    } else {
      nicknameModal.classList.remove('hidden');
    }
  });

  socket.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'INIT_SUCCESS': {
        myToken = msg.token;
        myNickname = msg.nickname;
        localStorage.setItem(STORAGE_TOKEN_KEY, myToken);
        localStorage.setItem(STORAGE_NICK_KEY, myNickname);
        playerNameEl.textContent = myNickname;
        nicknameModal.classList.add('hidden');
        nicknameError.textContent = '';
        break;
      }

      case 'INIT_ERROR': {
        if (!nicknameModal.classList.contains('hidden')) {
          nicknameError.textContent = msg.message;
        } else {
          localStorage.removeItem(STORAGE_TOKEN_KEY);
          localStorage.removeItem(STORAGE_NICK_KEY);
          myToken = null;
          myNickname = null;
          nicknameModal.classList.remove('hidden');
          nicknameError.textContent = msg.message;
        }
        break;
      }

      case 'GAME_SNAPSHOT': {
        reconnectOverlay.classList.add('hidden');
        currentRoundStatus = msg.roundStatus;

        if (Array.isArray(msg.grid)) {
          for (let y = 0; y < msg.grid.length; y++) {
            for (let x = 0; x < msg.grid[y].length; x++) {
              applyCellUpdate(msg.grid[y][x]);
            }
          }
        }

        renderLeaderboard(msg.currentLeaderboard);
        renderPastChampions(msg.pastTop3);

        if (currentRoundStatus === 'PLAYING') {
          hideRoundEndModal();
          startLocalTimer(msg.roundTimeLeft);
        } else {
          showRoundEndModal(msg.roundStatus, msg.currentLeaderboard?.slice(0, 3), msg.roundTimeLeft);
        }
        break;
      }

      case 'CELL_UPDATE': {
        if (msg.cell) {
          applyCellUpdate(msg.cell);
        }
        if (Array.isArray(msg.cells)) {
          for (const c of msg.cells) {
            applyCellUpdate(c);
          }
        }
        break;
      }

      case 'ACTION_REJECTED': {
        if (msg.actualCell) {
          applyCellUpdate(msg.actualCell);
        }
        break;
      }

      case 'ROUND_ENDED': {
        currentRoundStatus = msg.status;
        if (Array.isArray(msg.fullGrid)) {
          for (let y = 0; y < msg.fullGrid.length; y++) {
            for (let x = 0; x < msg.fullGrid[y].length; x++) {
              applyCellUpdate(msg.fullGrid[y][x]);
            }
          }
        }
        renderPastChampions(msg.top3);
        showRoundEndModal(msg.status, msg.top3, msg.nextRoundIn);
        break;
      }

      case 'ROUND_STARTED': {
        currentRoundStatus = 'PLAYING';
        hideRoundEndModal();
        initLocalGrid();
        startLocalTimer(msg.roundTimeLeft);
        playerScoreEl.textContent = '0 pts';
        break;
      }

      case 'SCORE_UPDATE': {
        renderLeaderboard(msg.currentLeaderboard);
        break;
      }
    }
  });

  socket.addEventListener('close', () => {
    reconnectOverlay.classList.remove('hidden');
    reconnectTimer = setTimeout(connectWebSocket, 2000);
  });

  socket.addEventListener('error', () => {
    socket.close();
  });
}

function setupEventListeners() {
  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartTime = 0;
  let touchTarget = null;
  let lastTapTime = 0;

  boardEl.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      const touch = e.touches[0];
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
      touchStartTime = Date.now();
      touchTarget = e.target.closest('.cell');
    } else {
      touchTarget = null;
    }
  }, { passive: true });

  boardEl.addEventListener('touchend', (e) => {
    if (!touchTarget) return;

    const duration = Date.now() - touchStartTime;
    if (duration > 500) {
      touchTarget = null;
      return;
    }

    if (e.changedTouches.length > 0) {
      const touch = e.changedTouches[0];
      const dx = Math.abs(touch.clientX - touchStartX);
      const dy = Math.abs(touch.clientY - touchStartY);

      if (dx < 25 && dy < 25) {
        const cellEl = touchTarget;
        const x = parseInt(cellEl.dataset.x, 10);
        const y = parseInt(cellEl.dataset.y, 10);

        if (!isNaN(x) && !isNaN(y)) {
          lastTapTime = Date.now();
          sendCellAction(x, y, currentTouchMode);
        }
      }
    }
    touchTarget = null;
  });

  boardEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const cellEl = e.target.closest('.cell');
    if (!cellEl) return;
    const x = parseInt(cellEl.dataset.x, 10);
    const y = parseInt(cellEl.dataset.y, 10);
    sendCellAction(x, y, 'flag');
  });

  boardEl.addEventListener('click', (e) => {
    if (Date.now() - lastTapTime < 400) {
      return;
    }

    const cellEl = e.target.closest('.cell');
    if (!cellEl) return;
    const x = parseInt(cellEl.dataset.x, 10);
    const y = parseInt(cellEl.dataset.y, 10);

    const action = currentTouchMode || 'reveal';
    sendCellAction(x, y, action);
  });

  digModeBtn.addEventListener('click', () => {
    currentTouchMode = 'reveal';
    digModeBtn.classList.add('active');
    flagModeBtn.classList.remove('active');
  });

  flagModeBtn.addEventListener('click', () => {
    currentTouchMode = 'flag';
    flagModeBtn.classList.add('active');
    digModeBtn.classList.remove('active');
  });

  nicknameForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const nickname = nicknameInput.value.trim();
    if (!nickname) return;

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      nicknameError.textContent = 'Connecting to server, please wait...';
      return;
    }

    nicknameError.textContent = '';
    nicknameInput.blur();
    socket.send(JSON.stringify({
      type: 'INIT_USER',
      nickname
    }));
  });
}

if (myNickname) {
  playerNameEl.textContent = myNickname;
}

initLocalGrid();
setupEventListeners();
connectWebSocket();
