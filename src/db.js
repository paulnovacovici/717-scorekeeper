const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

function openDatabase(filename = process.env.DB_PATH || path.join(__dirname, "..", "data", "717.db")) {
  if (filename !== ":memory:") fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
  migrate(db);
  seed(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS group_members (
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
      position INTEGER NOT NULL,
      PRIMARY KEY (group_id, player_id)
    );
    CREATE TABLE IF NOT EXISTS games (
      id INTEGER PRIMARY KEY,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'complete')),
      winner_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS rounds (
      id INTEGER PRIMARY KEY,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      round_number INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(game_id, round_number)
    );
    CREATE TABLE IF NOT EXISTS round_scores (
      round_id INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
      score INTEGER NOT NULL,
      PRIMARY KEY (round_id, player_id)
    );
    CREATE TABLE IF NOT EXISTS game_scores (
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
      score INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (game_id, player_id)
    );
    CREATE TABLE IF NOT EXISTS score_events (
      id INTEGER PRIMARY KEY,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
      tricks INTEGER NOT NULL CHECK(tricks BETWEEN 0 AND 7),
      points INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS game_rounds (
      id INTEGER PRIMARY KEY,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      round_number INTEGER NOT NULL,
      card_count INTEGER NOT NULL CHECK(card_count BETWEEN 1 AND 7),
      direction TEXT NOT NULL CHECK(direction IN ('down', 'up', 'tiebreaker')),
      first_caller_id INTEGER NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      UNIQUE(game_id, round_number)
    );
    CREATE TABLE IF NOT EXISTS round_bids (
      round_id INTEGER NOT NULL REFERENCES game_rounds(id) ON DELETE CASCADE,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
      bid INTEGER NOT NULL CHECK(bid BETWEEN 0 AND 7),
      hit INTEGER NOT NULL DEFAULT 0 CHECK(hit IN (0, 1)),
      PRIMARY KEY (round_id, player_id)
    );
  `);
  const memberColumns = db.prepare("PRAGMA table_info(group_members)").all().map((column) => column.name);
  if (!memberColumns.includes("starting_wins")) {
    db.exec("ALTER TABLE group_members ADD COLUMN starting_wins INTEGER NOT NULL DEFAULT 0");
  }
  if (!memberColumns.includes("starting_losses")) {
    db.exec("ALTER TABLE group_members ADD COLUMN starting_losses INTEGER NOT NULL DEFAULT 0");
  }
  db.exec(`INSERT INTO game_rounds (game_id, round_number, card_count, direction, first_caller_id)
    SELECT g.id, 1, 7, 'down', (
      SELECT gm.player_id FROM group_members gm WHERE gm.group_id = g.group_id ORDER BY gm.position LIMIT 1
    )
    FROM games g
    WHERE g.status = 'active' AND NOT EXISTS (SELECT 1 FROM game_rounds gr WHERE gr.game_id = g.id)`);
}

function seed(db) {
  const count = db.prepare("SELECT COUNT(*) AS count FROM groups").get().count;
  if (count) return;
  createGroup(db, "Ellie + Paul", ["Ellie", "Paul"]);
}

function getDashboard(db) {
  const groups = db.prepare(`
    SELECT g.id, g.name, g.created_at,
      COUNT(DISTINCT CASE WHEN ga.status = 'complete' THEN ga.id END) AS games_played,
      COUNT(DISTINCT CASE WHEN ga.status = 'active' THEN ga.id END) AS active_games,
      MAX(ga.started_at) AS last_played
    FROM groups g LEFT JOIN games ga ON ga.group_id = g.id
    GROUP BY g.id ORDER BY COALESCE(last_played, g.created_at) DESC
  `).all().map((group) => ({ ...group, players: getGroupPlayers(db, group.id) }));
  return {
    groups,
    totals: db.prepare(`SELECT
      (SELECT COUNT(*) FROM games WHERE status = 'complete') AS games,
      (SELECT COUNT(*) FROM players) AS players,
      (SELECT COUNT(*) FROM groups) AS groups`).get()
  };
}

function getGroup(db, groupId) {
  const group = db.prepare("SELECT * FROM groups WHERE id = ?").get(groupId);
  if (!group) throw httpError(404, "Group not found.");
  const players = getGroupPlayers(db, groupId);
  const records = players.map((player) => {
    const result = db.prepare(`SELECT gm.starting_wins, gm.starting_losses,
      COUNT(CASE WHEN g.status = 'complete' THEN 1 END) AS games,
      COUNT(CASE WHEN g.winner_id = ? THEN 1 END) AS wins
      FROM group_members gm LEFT JOIN games g ON g.group_id = gm.group_id
      WHERE gm.group_id = ? AND gm.player_id = ?`).get(player.id, groupId, player.id);
    return {
      ...player,
      wins: result.starting_wins + result.wins,
      losses: result.starting_losses + result.games - result.wins
    };
  });
  const games = db.prepare(`
    SELECT g.*, p.name AS winner_name
    FROM games g LEFT JOIN players p ON p.id = g.winner_id
    WHERE g.group_id = ? ORDER BY g.started_at DESC, g.id DESC
  `).all(groupId).map((game) => ({ ...game, totals: getGameTotals(db, game.id) }));
  return { ...group, players: records, games };
}

function getGame(db, gameId) {
  const game = db.prepare(`SELECT g.*, gr.name AS group_name, p.name AS winner_name
    FROM games g JOIN groups gr ON gr.id = g.group_id
    LEFT JOIN players p ON p.id = g.winner_id WHERE g.id = ?`).get(gameId);
  if (!game) throw httpError(404, "Game not found.");
  const players = getGroupPlayers(db, game.group_id);
  return {
    ...game,
    players,
    totals: getGameTotals(db, gameId),
    round: getCurrentRound(db, gameId, players),
    round_history: getRoundHistory(db, gameId, players)
  };
}

function createGroup(db, name, playerNames) {
  const cleanName = String(name || "").trim();
  const names = [...new Set((playerNames || []).map((value) => String(value).trim()).filter(Boolean))];
  if (!cleanName) throw httpError(400, "Give this group a name.");
  if (names.length < 2) throw httpError(400, "A group needs at least two players.");
  if (names.length > 8) throw httpError(400, "A group can have at most eight players.");
  const groupId = runTransaction(db, () => {
    const groupId = Number(db.prepare("INSERT INTO groups (name) VALUES (?)").run(cleanName).lastInsertRowid);
    names.forEach((playerName, position) => {
      db.prepare("INSERT OR IGNORE INTO players (name) VALUES (?)").run(playerName);
      const player = db.prepare("SELECT id FROM players WHERE name = ? COLLATE NOCASE").get(playerName);
      db.prepare("INSERT INTO group_members (group_id, player_id, position) VALUES (?, ?, ?)").run(groupId, player.id, position);
    });
    return groupId;
  });
  return getGroup(db, groupId);
}

function startGame(db, groupId) {
  getGroup(db, groupId);
  const active = db.prepare("SELECT id FROM games WHERE group_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1").get(groupId);
  if (active) return getGame(db, active.id);
  const id = runTransaction(db, () => {
    const gameId = Number(db.prepare("INSERT INTO games (group_id) VALUES (?)").run(groupId).lastInsertRowid);
    const players = getGroupPlayers(db, groupId);
    players.forEach((player) => {
      db.prepare("INSERT INTO game_scores (game_id, player_id, score) VALUES (?, ?, 0)").run(gameId, player.id);
    });
    createRound(db, gameId, 1, players[0].id);
    return gameId;
  });
  return getGame(db, id);
}

function setRoundBid(db, gameId, playerId, bid) {
  const game = getGame(db, gameId);
  if (game.status !== "active") throw httpError(409, "This game is already complete.");
  const player = game.players.find((item) => item.id === Number(playerId));
  if (!player) throw httpError(400, "Choose a player from this game.");
  const bidValue = Number(bid);
  if (!Number.isInteger(bidValue) || bidValue < 0 || bidValue > game.round.card_count) {
    throw httpError(400, `Bid must be between 0 and ${game.round.card_count}.`);
  }
  db.prepare(`INSERT INTO round_bids (round_id, player_id, bid, hit) VALUES (?, ?, ?, 0)
    ON CONFLICT(round_id, player_id) DO UPDATE SET bid = excluded.bid, hit = 0`)
    .run(game.round.id, player.id, bidValue);
  return getGame(db, gameId);
}

function setRoundHit(db, gameId, playerId, hit) {
  const game = getGame(db, gameId);
  if (game.status !== "active") throw httpError(409, "This game is already complete.");
  const player = game.players.find((item) => item.id === Number(playerId));
  if (!player) throw httpError(400, "Choose a player from this game.");
  const bid = game.round.bids.find((item) => item.player_id === player.id);
  if (bid?.bid == null) throw httpError(400, `Choose ${player.name}'s bid first.`);
  db.prepare("UPDATE round_bids SET hit = ? WHERE round_id = ? AND player_id = ?")
    .run(hit ? 1 : 0, game.round.id, player.id);
  return getGame(db, gameId);
}

function setFirstCaller(db, gameId, playerId) {
  const game = getGame(db, gameId);
  if (game.status !== "active") throw httpError(409, "This game is already complete.");
  const player = game.players.find((item) => item.id === Number(playerId));
  if (!player) throw httpError(400, "Choose a player from this game.");
  db.prepare("UPDATE game_rounds SET first_caller_id = ? WHERE id = ?").run(player.id, game.round.id);
  return getGame(db, gameId);
}

function completeRound(db, gameId) {
  const game = getGame(db, gameId);
  if (game.status !== "active") throw httpError(409, "This game is already complete.");
  const missing = game.round.bids.filter((item) => item.bid === null);
  if (missing.length) throw httpError(400, `Choose a bid for ${missing.map((item) => item.name).join(", ")}.`);

  runTransaction(db, () => {
    for (const bid of game.round.bids) {
      if (!bid.hit) continue;
      const points = (bid.bid * bid.bid) + 10;
      db.prepare("UPDATE game_scores SET score = score + ? WHERE game_id = ? AND player_id = ?")
        .run(points, gameId, bid.player_id);
      db.prepare("INSERT INTO score_events (game_id, player_id, tricks, points) VALUES (?, ?, ?, ?)")
        .run(gameId, bid.player_id, bid.bid, points);
    }
    db.prepare("UPDATE game_rounds SET completed_at = CURRENT_TIMESTAMP WHERE id = ?").run(game.round.id);

    const totals = getGameTotals(db, gameId);
    const highest = Math.max(...totals.map((total) => total.score));
    const leaders = totals.filter((total) => total.score === highest);
    if (game.round.round_number >= 13 && leaders.length === 1) {
      db.prepare("UPDATE games SET status = 'complete', winner_id = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(leaders[0].player_id, gameId);
      return;
    }

    const callerIndex = game.players.findIndex((player) => player.id === game.round.first_caller_id);
    const nextCaller = game.players[(callerIndex + 1) % game.players.length];
    createRound(db, gameId, game.round.round_number + 1, nextCaller.id);
  });
  return getGame(db, gameId);
}

function deleteGame(db, gameId) {
  const result = db.prepare("DELETE FROM games WHERE id = ?").run(gameId);
  if (!result.changes) throw httpError(404, "Game not found.");
}

function getGroupPlayers(db, groupId) {
  return db.prepare(`SELECT p.id, p.name FROM players p JOIN group_members gm ON gm.player_id = p.id
    WHERE gm.group_id = ? ORDER BY gm.position`).all(groupId);
}

function getGameTotals(db, gameId) {
  return db.prepare(`SELECT p.id AS player_id, p.name, COALESCE(gs.score, 0) AS score
    FROM games g JOIN group_members gm ON gm.group_id = g.group_id JOIN players p ON p.id = gm.player_id
    LEFT JOIN game_scores gs ON gs.game_id = g.id AND gs.player_id = p.id
    WHERE g.id = ? ORDER BY gm.position`).all(gameId);
}

function createRound(db, gameId, roundNumber, firstCallerId) {
  const spec = getRoundSpec(roundNumber);
  return Number(db.prepare(`INSERT INTO game_rounds
    (game_id, round_number, card_count, direction, first_caller_id) VALUES (?, ?, ?, ?, ?)`)
    .run(gameId, roundNumber, spec.cardCount, spec.direction, firstCallerId).lastInsertRowid);
}

function getRoundSpec(roundNumber) {
  if (roundNumber <= 7) return { cardCount: 8 - roundNumber, direction: "down" };
  if (roundNumber <= 13) return { cardCount: roundNumber - 6, direction: "up" };
  return { cardCount: 7, direction: "tiebreaker" };
}

function getCurrentRound(db, gameId, players) {
  const round = db.prepare(`SELECT gr.*, p.name AS first_caller_name FROM game_rounds gr
    JOIN players p ON p.id = gr.first_caller_id
    WHERE gr.game_id = ? AND gr.completed_at IS NULL ORDER BY gr.round_number DESC LIMIT 1`).get(gameId);
  if (!round) return null;
  return { ...round, bids: getRoundBids(db, round.id, players) };
}

function getRoundBids(db, roundId, players) {
  const values = new Map(db.prepare("SELECT player_id, bid, hit FROM round_bids WHERE round_id = ?").all(roundId)
    .map((bid) => [bid.player_id, bid]));
  return players.map((player) => {
    const value = values.get(player.id);
    return { player_id: player.id, name: player.name, bid: value?.bid ?? null, hit: Boolean(value?.hit) };
  });
}

function getRoundHistory(db, gameId, players) {
  return db.prepare(`SELECT gr.*, p.name AS first_caller_name FROM game_rounds gr
    JOIN players p ON p.id = gr.first_caller_id
    WHERE gr.game_id = ? AND gr.completed_at IS NOT NULL ORDER BY gr.round_number DESC`).all(gameId)
    .map((round) => ({ ...round, bids: getRoundBids(db, round.id, players) }));
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function runTransaction(db, operation) {
  db.exec("BEGIN");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

module.exports = { openDatabase, getDashboard, getGroup, getGame, createGroup, startGame, setRoundBid, setRoundHit, setFirstCaller, completeRound, deleteGame };
