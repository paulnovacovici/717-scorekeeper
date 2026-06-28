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
    CREATE TABLE IF NOT EXISTS game_players (
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
      position INTEGER NOT NULL,
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
  db.exec(`INSERT OR IGNORE INTO game_players (game_id, player_id, position)
    SELECT g.id, gm.player_id, gm.position
    FROM games g JOIN group_members gm ON gm.group_id = g.group_id`);
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
  const players = getGamePlayers(db, game.id, game.group_id);
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
      db.prepare("INSERT INTO game_players (game_id, player_id, position) VALUES (?, ?, ?)")
        .run(gameId, player.id, player.position);
      db.prepare("INSERT INTO game_scores (game_id, player_id, score) VALUES (?, ?, 0)").run(gameId, player.id);
    });
    createRound(db, gameId, 1, players[0].id);
    return gameId;
  });
  return getGame(db, id);
}

function setFirstCaller(db, gameId, playerId) {
  const game = getGame(db, gameId);
  if (game.status !== "active") throw httpError(409, "This game is already complete.");
  const player = game.players.find((item) => item.id === Number(playerId));
  if (!player) throw httpError(400, "Choose a player from this game.");
  db.prepare("UPDATE game_rounds SET first_caller_id = ? WHERE id = ?").run(player.id, game.round.id);
  return getGame(db, gameId);
}

function reorderGamePlayers(db, gameId, playerIds) {
  const game = getGame(db, gameId);
  if (game.status !== "active") throw httpError(409, "This game is already complete.");
  if (!Array.isArray(playerIds)) throw httpError(400, "Submit the players in play order.");
  const ids = playerIds.map((id) => Number(id));
  if (ids.some((id) => !Number.isInteger(id))) throw httpError(400, "Submit the players in play order.");
  const expected = new Set(game.players.map((player) => player.id));
  const submitted = new Set(ids);
  if (ids.length !== game.players.length || submitted.size !== ids.length || ids.some((id) => !expected.has(id))) {
    throw httpError(400, "Submit each player in this game exactly once.");
  }

  runTransaction(db, () => {
    ids.forEach((playerId, position) => {
      db.prepare("UPDATE game_players SET position = ? WHERE game_id = ? AND player_id = ?")
        .run(position, game.id, playerId);
    });
    db.prepare("UPDATE game_rounds SET first_caller_id = ? WHERE id = ?").run(ids[0], game.round.id);
  });
  return getGame(db, gameId);
}

function completeRound(db, gameId, submittedBids, submittedRoundId) {
  const game = getGame(db, gameId);
  const roundId = normalizeRoundId(submittedRoundId);
  if (roundId !== null && game.round?.id !== roundId) {
    const latestRound = game.round_history[0];
    if (latestRound?.id === roundId) {
      const retryBids = validateSubmittedBids(game.players, submittedBids, latestRound.card_count);
      if (roundBidsMatch(latestRound.bids, retryBids)) return game;
    }
    throw httpError(409, "This round is no longer active.");
  }
  if (game.status !== "active") throw httpError(409, "This game is already complete.");
  const bids = validateRoundBids(game, submittedBids);

  runTransaction(db, () => {
    for (const bid of bids) {
      db.prepare(`INSERT INTO round_bids (round_id, player_id, bid, hit) VALUES (?, ?, ?, ?)
        ON CONFLICT(round_id, player_id) DO UPDATE SET bid = excluded.bid, hit = excluded.hit`)
        .run(game.round.id, bid.player_id, bid.bid, bid.hit ? 1 : 0);
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

function undoRound(db, gameId) {
  const game = getGame(db, gameId);
  const latestRound = game.round_history[0];
  if (!latestRound) throw httpError(409, "There are no completed rounds to undo.");

  runTransaction(db, () => {
    db.prepare("UPDATE games SET status = 'active', winner_id = NULL, completed_at = NULL WHERE id = ?").run(gameId);
    db.prepare("DELETE FROM game_rounds WHERE game_id = ? AND completed_at IS NULL AND round_number > ?")
      .run(gameId, latestRound.round_number);
    for (const bid of latestRound.bids) {
      if (!bid.hit) continue;
      const points = (bid.bid * bid.bid) + 10;
      db.prepare("UPDATE game_scores SET score = score - ? WHERE game_id = ? AND player_id = ?")
        .run(points, gameId, bid.player_id);
      db.prepare(`DELETE FROM score_events WHERE id = (
        SELECT id FROM score_events WHERE game_id = ? AND player_id = ? AND tricks = ? AND points = ?
        ORDER BY id DESC LIMIT 1
      )`).run(gameId, bid.player_id, bid.bid, points);
    }
    db.prepare("UPDATE game_rounds SET completed_at = NULL WHERE id = ?").run(latestRound.id);
  });
  return getGame(db, gameId);
}

function validateRoundBids(game, submittedBids) {
  return validateSubmittedBids(game.players, submittedBids, game.round.card_count);
}

function validateSubmittedBids(playersList, submittedBids, cardCount) {
  if (!Array.isArray(submittedBids)) throw httpError(400, "Submit one bid for every player.");
  const players = new Map(playersList.map((player) => [player.id, player]));
  const seen = new Set();
  const bids = submittedBids.map((submitted) => {
    const playerId = Number(submitted?.playerId);
    const player = players.get(playerId);
    if (!player || seen.has(playerId)) throw httpError(400, "Submit one bid for every player.");
    seen.add(playerId);
    const bid = submitted?.bid;
    if (!Number.isInteger(bid) || bid < 0 || bid > cardCount) {
      throw httpError(400, `Bid must be between 0 and ${cardCount}.`);
    }
    if (typeof submitted.hit !== "boolean") throw httpError(400, "Hit status must be true or false.");
    return { player_id: playerId, name: player.name, bid, hit: submitted.hit };
  });
  if (seen.size !== players.size) throw httpError(400, "Submit one bid for every player.");
  return bids;
}

function normalizeRoundId(value) {
  if (value === undefined || value === null) return null;
  const roundId = Number(value);
  if (!Number.isInteger(roundId)) throw httpError(400, "Round id must be an integer.");
  return roundId;
}

function roundBidsMatch(storedBids, submittedBids) {
  const submitted = new Map(submittedBids.map((bid) => [bid.player_id, bid]));
  return storedBids.length === submittedBids.length && storedBids.every((stored) => {
    const bid = submitted.get(stored.player_id);
    return bid && stored.bid === bid.bid && stored.hit === bid.hit;
  });
}

function deleteGame(db, gameId) {
  const result = db.prepare("DELETE FROM games WHERE id = ?").run(gameId);
  if (!result.changes) throw httpError(404, "Game not found.");
}

function getGroupPlayers(db, groupId) {
  return db.prepare(`SELECT p.id, p.name, gm.position FROM players p JOIN group_members gm ON gm.player_id = p.id
    WHERE gm.group_id = ? ORDER BY gm.position`).all(groupId);
}

function getGamePlayers(db, gameId, groupId) {
  const players = db.prepare(`SELECT p.id, p.name, gp.position
    FROM game_players gp JOIN players p ON p.id = gp.player_id
    WHERE gp.game_id = ? ORDER BY gp.position`).all(gameId);
  return players.length ? players : getGroupPlayers(db, groupId);
}

function getGameTotals(db, gameId) {
  return db.prepare(`SELECT p.id AS player_id, p.name, COALESCE(gs.score, 0) AS score
    FROM game_players gp JOIN players p ON p.id = gp.player_id
    JOIN games g ON g.id = gp.game_id
    LEFT JOIN game_scores gs ON gs.game_id = g.id AND gs.player_id = p.id
    WHERE g.id = ? ORDER BY gp.position`).all(gameId);
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

module.exports = { openDatabase, getDashboard, getGroup, getGame, createGroup, startGame, setFirstCaller, reorderGamePlayers, completeRound, undoRound, deleteGame };
