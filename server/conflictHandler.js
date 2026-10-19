function sanitizeCell(cell, revealMines = false) {
  const sanitized = {
    x: cell.x,
    y: cell.y,
    state: cell.state,
    version: cell.version
  };

  if (cell.state === 'revealed' || revealMines) {
    sanitized.isMine = cell.isMine;
    sanitized.adjacentMines = cell.adjacentMines;
  }

  return sanitized;
}

function validateAction(grid, x, y, action, expectedVersion) {
  if (!grid || !Array.isArray(grid)) {
    return { valid: false, reason: 'INVALID_GRID' };
  }

  if (typeof x !== 'number' || typeof y !== 'number') {
    return { valid: false, reason: 'INVALID_COORDINATES' };
  }

  if (y < 0 || y >= grid.length || x < 0 || x >= grid[0].length) {
    return { valid: false, reason: 'OUT_OF_BOUNDS' };
  }

  if (action !== 'reveal' && action !== 'flag') {
    return { valid: false, reason: 'INVALID_ACTION' };
  }

  const cell = grid[y][x];

  if (cell.state !== 'hidden') {
    return {
      valid: false,
      reason: 'ALREADY_RESOLVED',
      actualCell: sanitizeCell(cell)
    };
  }

  if (typeof expectedVersion !== 'number' || cell.version !== expectedVersion) {
    return {
      valid: false,
      reason: 'VERSION_MISMATCH',
      actualCell: sanitizeCell(cell)
    };
  }

  return { valid: true, cell };
}

class ActionQueue {
  constructor() {
    this.chain = Promise.resolve();
  }

  enqueue(task) {
    const result = this.chain.then(() => task());
    this.chain = result.catch(() => {});
    return result;
  }
}

module.exports = {
  sanitizeCell,
  validateAction,
  ActionQueue
};
