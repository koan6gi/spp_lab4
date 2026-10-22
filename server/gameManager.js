const EventEmitter = require('events');
const db = require('./db');
const { sanitizeCell, validateAction, ActionQueue } = require('./conflictHandler');

const GRID_WIDTH = 24;
const GRID_HEIGHT = 24;
const TOTAL_MINES = 70;
const ROUND_DURATION_SECONDS = 600; // 10 minutes
const PAUSE_DURATION_SECONDS = 10;   // 10 seconds

class GameManager extends EventEmitter {
  constructor() {
    super();
    this.actionQueue = new ActionQueue();
    this.players = new Map(); // token -> { token, nickname, score, isAfk, ws }
    this.grid = [];
    this.minesGenerated = false;
    this.roundStatus = 'PLAYING'; // 'PLAYING' | 'VICTORY' | 'DEFEAT' | 'TIMEOUT'
    this.roundTimeLeft = ROUND_DURATION_SECONDS;
    this.pauseTimeLeft = 0;
    this.timerInterval = null;
    this.pauseInterval = null;
    this.revealedSafeCount = 0;
    this.flaggedMinesCount = 0;

    this.initGrid();
    this.startRoundTimer();
  }

  initGrid() {
    this.grid = [];
    this.minesGenerated = false;
    this.revealedSafeCount = 0;
    this.flaggedMinesCount = 0;

    for (let y = 0; y < GRID_HEIGHT; y++) {
      const row = [];
      for (let x = 0; x < GRID_WIDTH; x++) {
        row.push({
          x,
          y,
          isMine: false,
          adjacentMines: 0,
          state: 'hidden',
          version: 0
        });
      }
      this.grid.push(row);
    }
  }

  startRoundTimer() {
    if (this.timerInterval) clearInterval(this.timerInterval);
    if (this.pauseInterval) clearInterval(this.pauseInterval);

    this.roundTimeLeft = ROUND_DURATION_SECONDS;
    this.roundStatus = 'PLAYING';

    this.timerInterval = setInterval(() => {
      if (this.roundStatus !== 'PLAYING') return;

      this.roundTimeLeft--;
      if (this.roundTimeLeft <= 0) {
        this.roundTimeLeft = 0;
        this.endRound('TIMEOUT');
      }
    }, 1000);
  }

  generateMines(firstX, firstY, firstAction) {
    const safeCoords = new Set();

    if (firstAction === 'reveal') {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = firstX + dx;
          const ny = firstY + dy;
          if (nx >= 0 && nx < GRID_WIDTH && ny >= 0 && ny < GRID_HEIGHT) {
            safeCoords.add(`${nx},${ny}`);
          }
        }
      }
    }

    const candidateCoords = [];
    for (let y = 0; y < GRID_HEIGHT; y++) {
      for (let x = 0; x < GRID_WIDTH; x++) {
        if (!safeCoords.has(`${x},${y}`)) {
          candidateCoords.push({ x, y });
        }
      }
    }

    // Shuffle candidate coordinates
    for (let i = candidateCoords.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidateCoords[i], candidateCoords[j]] = [candidateCoords[j], candidateCoords[i]];
    }

    let minesPlaced = 0;

    // If first action was a flag, guarantee the flagged cell is a mine
    if (firstAction === 'flag') {
      this.grid[firstY][firstX].isMine = true;
      minesPlaced++;
    }

    for (const coord of candidateCoords) {
      if (minesPlaced >= TOTAL_MINES) break;
      if (firstAction === 'flag' && coord.x === firstX && coord.y === firstY) continue;
      this.grid[coord.y][coord.x].isMine = true;
      minesPlaced++;
    }

    // Calculate adjacent mines
    for (let y = 0; y < GRID_HEIGHT; y++) {
      for (let x = 0; x < GRID_WIDTH; x++) {
        if (this.grid[y][x].isMine) continue;
        let count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && nx < GRID_WIDTH && ny >= 0 && ny < GRID_HEIGHT) {
              if (this.grid[ny][nx].isMine) count++;
            }
          }
        }
        this.grid[y][x].adjacentMines = count;
      }
    }

    this.minesGenerated = true;
  }

  registerPlayer(token, nickname, ws) {
    let player = this.players.get(token);
    if (!player) {
      player = {
        token,
        nickname,
        score: 0,
        isAfk: false,
        ws
      };
      this.players.set(token, player);
    } else {
      player.nickname = nickname;
      player.ws = ws;
      player.isAfk = false;
    }
    return player;
  }

  setPlayerAfk(token, isAfk) {
    const player = this.players.get(token);
    if (player) {
      player.isAfk = isAfk;
      if (isAfk) {
        player.ws = null;
      }
    }
  }

  getLeaderboard() {
    const list = Array.from(this.players.values()).map(p => ({
      nickname: p.nickname,
      score: p.score,
      isAfk: p.isAfk
    }));
    list.sort((a, b) => b.score - a.score);
    return list;
  }

  getTop3() {
    return this.getLeaderboard().slice(0, 3).map(p => ({
      nickname: p.nickname,
      score: p.score
    }));
  }

  getSanitizedGrid(revealAll = false) {
    return this.grid.map(row => row.map(cell => sanitizeCell(cell, revealAll)));
  }

  getSnapshot() {
    const isRoundEnded = this.roundStatus !== 'PLAYING';
    return {
      type: 'GAME_SNAPSHOT',
      grid: this.getSanitizedGrid(isRoundEnded),
      roundTimeLeft: isRoundEnded ? this.pauseTimeLeft : this.roundTimeLeft,
      roundStatus: this.roundStatus,
      currentLeaderboard: this.getLeaderboard(),
      pastTop3: db.getPastRoundTop3()
    };
  }

  handleCellAction(token, x, y, action, expectedVersion) {
    return this.actionQueue.enqueue(() => {
      const player = this.players.get(token);
      if (!player) {
        return { rejected: true, reason: 'PLAYER_NOT_FOUND' };
      }

      if (this.roundStatus !== 'PLAYING') {
        return {
          rejected: true,
          reason: 'ROUND_NOT_ACTIVE',
          actualCell: (y >= 0 && y < GRID_HEIGHT && x >= 0 && x < GRID_WIDTH)
            ? sanitizeCell(this.grid[y][x], true)
            : null
        };
      }

      const validation = validateAction(this.grid, x, y, action, expectedVersion);
      if (!validation.valid) {
        return {
          rejected: true,
          reason: validation.reason,
          actualCell: validation.actualCell
        };
      }

      const cell = validation.cell;

      // Safe First Click generation
      if (!this.minesGenerated) {
        this.generateMines(x, y, action);
      }

      cell.version++;

      // Action is accepted, reset AFK status for this active player
      player.isAfk = false;

      if (action === 'reveal') {
        if (cell.isMine) {
          cell.state = 'revealed';
          this.endRound('DEFEAT');
          return { accepted: true, roundEnded: true };
        }

        const revealedCells = [];
        const queue = [cell];
        cell.state = 'revealed';
        revealedCells.push(cell);

        while (queue.length > 0) {
          const current = queue.shift();
          if (current.adjacentMines === 0) {
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const nx = current.x + dx;
                const ny = current.y + dy;
                if (nx >= 0 && nx < GRID_WIDTH && ny >= 0 && ny < GRID_HEIGHT) {
                  const neighbor = this.grid[ny][nx];
                  if (neighbor.state === 'hidden') {
                    neighbor.state = 'revealed';
                    neighbor.version++;
                    revealedCells.push(neighbor);
                    if (neighbor.adjacentMines === 0) {
                      queue.push(neighbor);
                    }
                  }
                }
              }
            }
          }
        }

        player.score += 1;
        this.revealedSafeCount += revealedCells.length;

        const totalSafeCells = GRID_WIDTH * GRID_HEIGHT - TOTAL_MINES;
        if (this.revealedSafeCount >= totalSafeCells) {
          this.endRound('VICTORY');
          return { accepted: true, roundEnded: true };
        }

        return {
          accepted: true,
          revealedCells: revealedCells.map(c => sanitizeCell(c))
        };
      }

      if (action === 'flag') {
        cell.state = 'flagged';

        if (!cell.isMine) {
          this.endRound('DEFEAT');
          return { accepted: true, roundEnded: true };
        }

        player.score += 2;
        this.flaggedMinesCount++;

        if (this.flaggedMinesCount >= TOTAL_MINES) {
          this.endRound('VICTORY');
          return { accepted: true, roundEnded: true };
        }

        return {
          accepted: true,
          flaggedCell: sanitizeCell(cell)
        };
      }

      return { rejected: true, reason: 'UNKNOWN_ACTION' };
    });
  }

  endRound(status) {
    if (this.roundStatus !== 'PLAYING') return;

    this.roundStatus = status;
    if (this.timerInterval) clearInterval(this.timerInterval);

    const top3 = this.getTop3();

    for (const player of this.players.values()) {
      if (player.score > 0) {
        db.addPlayerScore(player.token, player.score);
      }
    }

    db.saveRound(status, top3);

    this.pauseTimeLeft = PAUSE_DURATION_SECONDS;

    this.emit('round_ended', {
      status,
      fullGrid: this.getSanitizedGrid(true),
      top3,
      nextRoundIn: this.pauseTimeLeft
    });

    if (this.pauseInterval) clearInterval(this.pauseInterval);
    this.pauseInterval = setInterval(() => {
      this.pauseTimeLeft--;
      if (this.pauseTimeLeft <= 0) {
        clearInterval(this.pauseInterval);
        this.startNewRound();
      }
    }, 1000);
  }

  startNewRound() {
    this.initGrid();

    for (const player of this.players.values()) {
      player.score = 0;
    }

    this.startRoundTimer();

    this.emit('round_started', {
      roundTimeLeft: this.roundTimeLeft
    });
  }
}

module.exports = {
  GameManager,
  GRID_WIDTH,
  GRID_HEIGHT,
  TOTAL_MINES,
  ROUND_DURATION_SECONDS,
  PAUSE_DURATION_SECONDS
};
