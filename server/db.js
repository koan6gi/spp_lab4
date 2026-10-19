const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'game.db');
const dbDir = path.dirname(dbPath);

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nickname TEXT UNIQUE NOT NULL,
    token TEXT UNIQUE NOT NULL,
    total_score INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS rounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL CHECK(status IN ('VICTORY', 'DEFEAT', 'TIMEOUT')),
    ended_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    top_players TEXT NOT NULL
  );
`);

const insertPlayerStmt = db.prepare('INSERT INTO players (nickname, token) VALUES (?, ?)');
const selectPlayerByTokenStmt = db.prepare('SELECT id, nickname, token, total_score, created_at FROM players WHERE token = ?');
const selectPlayerByNicknameStmt = db.prepare('SELECT id, nickname, token, total_score, created_at FROM players WHERE nickname = ?');
const addPlayerScoreStmt = db.prepare('UPDATE players SET total_score = total_score + ? WHERE token = ?');
const insertRoundStmt = db.prepare('INSERT INTO rounds (status, top_players) VALUES (?, ?)');
const selectLatestRoundStmt = db.prepare('SELECT top_players FROM rounds ORDER BY id DESC LIMIT 1');

function createPlayer(nickname, token) {
  insertPlayerStmt.run(nickname, token);
  return selectPlayerByTokenStmt.get(token);
}

function getPlayerByToken(token) {
  return selectPlayerByTokenStmt.get(token);
}

function getPlayerByNickname(nickname) {
  return selectPlayerByNicknameStmt.get(nickname);
}

function addPlayerScore(token, points) {
  if (points <= 0) return;
  addPlayerScoreStmt.run(points, token);
}

function saveRound(status, topPlayers) {
  const json = JSON.stringify(topPlayers);
  insertRoundStmt.run(status, json);
}

function getPastRoundTop3() {
  const row = selectLatestRoundStmt.get();
  if (!row || !row.top_players) {
    return [];
  }
  try {
    const parsed = JSON.parse(row.top_players);
    return Array.isArray(parsed) ? parsed.slice(0, 3) : [];
  } catch {
    return [];
  }
}

module.exports = {
  db,
  createPlayer,
  getPlayerByToken,
  getPlayerByNickname,
  addPlayerScore,
  saveRound,
  getPastRoundTop3
};
