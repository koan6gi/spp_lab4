const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const db = require('./db');
const { GameManager } = require('./gameManager');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  let requestPath = req.url.split('?')[0];
  if (requestPath === '/' || requestPath === '') {
    requestPath = '/index.html';
  }

  const safePath = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

const wss = new WebSocketServer({ server });
const gameManager = new GameManager();

function broadcast(payload) {
  const message = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

function sendTo(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

gameManager.on('round_ended', (data) => {
  broadcast({
    type: 'ROUND_ENDED',
    status: data.status,
    fullGrid: data.fullGrid,
    top3: data.top3,
    nextRoundIn: data.nextRoundIn
  });
});

gameManager.on('round_started', (data) => {
  broadcast({
    type: 'ROUND_STARTED',
    roundTimeLeft: data.roundTimeLeft
  });
  broadcast(gameManager.getSnapshot());
});

wss.on('connection', (ws) => {
  ws.token = null;

  ws.on('message', async (rawMessage) => {
    let message;
    try {
      message = JSON.parse(rawMessage.toString());
    } catch {
      return;
    }

    if (!message || typeof message.type !== 'string') {
      return;
    }

    switch (message.type) {
      case 'INIT_USER': {
        const rawNickname = message.nickname;
        if (typeof rawNickname !== 'string') {
          sendTo(ws, { type: 'INIT_ERROR', message: 'Nickname must be a string.' });
          return;
        }

        const nickname = rawNickname.trim();
        if (nickname.length < 2 || nickname.length > 20) {
          sendTo(ws, { type: 'INIT_ERROR', message: 'Nickname must be between 2 and 20 characters.' });
          return;
        }

        const validNameRegex = /^[a-zA-Z0-9_\- ]+$/;
        if (!validNameRegex.test(nickname)) {
          sendTo(ws, { type: 'INIT_ERROR', message: 'Nickname can only contain letters, numbers, spaces, underscores, and dashes.' });
          return;
        }

        const existingPlayer = db.getPlayerByNickname(nickname);
        if (existingPlayer) {
          sendTo(ws, { type: 'INIT_ERROR', message: 'Nickname is already taken. Please choose another.' });
          return;
        }

        const token = crypto.randomUUID();
        const player = db.createPlayer(nickname, token);
        ws.token = token;

        gameManager.registerPlayer(token, player.nickname, ws);

        sendTo(ws, {
          type: 'INIT_SUCCESS',
          token: player.token,
          nickname: player.nickname
        });

        sendTo(ws, gameManager.getSnapshot());
        broadcast({
          type: 'SCORE_UPDATE',
          currentLeaderboard: gameManager.getLeaderboard()
        });
        break;
      }

      case 'RECONNECT': {
        const token = message.token;
        if (typeof token !== 'string') {
          sendTo(ws, { type: 'INIT_ERROR', message: 'Invalid token format.' });
          return;
        }

        const player = db.getPlayerByToken(token);
        if (!player) {
          sendTo(ws, { type: 'INIT_ERROR', message: 'Session expired or player not found.' });
          return;
        }

        ws.token = token;
        gameManager.registerPlayer(token, player.nickname, ws);

        sendTo(ws, {
          type: 'INIT_SUCCESS',
          token: player.token,
          nickname: player.nickname
        });

        sendTo(ws, gameManager.getSnapshot());
        broadcast({
          type: 'SCORE_UPDATE',
          currentLeaderboard: gameManager.getLeaderboard()
        });
        break;
      }

      case 'CELL_ACTION': {
        if (!ws.token) {
          return;
        }

        const { x, y, action, expectedVersion } = message;
        const result = await gameManager.handleCellAction(ws.token, x, y, action, expectedVersion);

        if (result.rejected) {
          sendTo(ws, {
            type: 'ACTION_REJECTED',
            x,
            y,
            actualCell: result.actualCell
          });
          return;
        }

        if (result.accepted && !result.roundEnded) {
          if (result.revealedCells) {
            for (const cell of result.revealedCells) {
              broadcast({
                type: 'CELL_UPDATE',
                cell
              });
            }
          } else if (result.flaggedCell) {
            broadcast({
              type: 'CELL_UPDATE',
              cell: result.flaggedCell
            });
          }

          broadcast({
            type: 'SCORE_UPDATE',
            currentLeaderboard: gameManager.getLeaderboard()
          });
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (ws.token) {
      const player = gameManager.players.get(ws.token);
      // Only set AFK if this closed socket is still the active one for the player
      if (player && player.ws === ws) {
        gameManager.setPlayerAfk(ws.token, true);
        broadcast({
          type: 'SCORE_UPDATE',
          currentLeaderboard: gameManager.getLeaderboard()
        });
      }
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});
