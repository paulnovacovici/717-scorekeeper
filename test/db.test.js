const test = require("node:test");
const assert = require("node:assert/strict");
const {
  openDatabase,
  getDashboard,
  getGroup,
  createGroup,
  startGame,
  setFirstCaller,
  reorderGamePlayers,
  completeRound,
  undoRound,
  deleteGame
} = require("../src/db");

test("seeds a reusable Ellie and Paul group", () => {
  const db = openDatabase(":memory:");
  const dashboard = getDashboard(db);
  assert.equal(dashboard.groups.length, 1);
  assert.equal(dashboard.groups[0].name, "Ellie + Paul");
  assert.deepEqual(dashboard.groups[0].players.map((player) => player.name), ["Ellie", "Paul"]);
});

test("starts at seven going down and tracks bids, hits, and caller rotation", () => {
  const db = openDatabase(":memory:");
  let game = startGame(db, getDashboard(db).groups[0].id);
  const [ellie, paul] = game.players;
  assert.deepEqual(
    { number: game.round.round_number, cards: game.round.card_count, direction: game.round.direction, caller: game.round.first_caller_name },
    { number: 1, cards: 7, direction: "down", caller: "Ellie" }
  );

  game = setFirstCaller(db, game.id, paul.id);
  assert.equal(game.round.first_caller_name, "Paul");
  game = completeRound(db, game.id, [
    { playerId: ellie.id, bid: 2, hit: true },
    { playerId: paul.id, bid: 0, hit: false }
  ]);

  assert.deepEqual(game.totals.map((total) => total.score), [14, 0]);
  assert.deepEqual(
    { number: game.round.round_number, cards: game.round.card_count, direction: game.round.direction, caller: game.round.first_caller_name },
    { number: 2, cards: 6, direction: "down", caller: "Ellie" }
  );
  assert.equal(game.round_history[0].bids.find((bid) => bid.name === "Ellie").hit, true);
});

test("plays the full 7 down to 1 and up to 7 sequence and records the winner", () => {
  const db = openDatabase(":memory:");
  const group = getDashboard(db).groups[0];
  let game = startGame(db, group.id);
  const [ellie, paul] = game.players;
  const expectedCards = [7, 6, 5, 4, 3, 2, 1, 2, 3, 4, 5, 6, 7];
  const callers = [];

  for (let index = 0; index < expectedCards.length; index += 1) {
    assert.equal(game.round.card_count, expectedCards[index]);
    assert.equal(game.round.direction, index < 7 ? "down" : "up");
    callers.push(game.round.first_caller_name);
    game = completeRound(db, game.id, [
      { playerId: ellie.id, bid: 0, hit: true },
      { playerId: paul.id, bid: 0, hit: false }
    ]);
  }

  assert.equal(game.status, "complete");
  assert.equal(game.winner_name, "Ellie");
  assert.deepEqual(game.totals.map((total) => total.score), [130, 0]);
  assert.deepEqual(callers, ["Ellie", "Paul", "Ellie", "Paul", "Ellie", "Paul", "Ellie", "Paul", "Ellie", "Paul", "Ellie", "Paul", "Ellie"]);
  assert.equal(game.round_history.length, 13);
  const records = getGroup(db, group.id).players.map(({ wins, losses }) => ({ wins, losses }));
  assert.deepEqual(records, [{ wins: 1, losses: 0 }, { wins: 0, losses: 1 }]);
});

test("reorders active game play order without changing group membership order", () => {
  const db = openDatabase(":memory:");
  const group = createGroup(db, "Three friends", ["A", "B", "C"]);
  let game = startGame(db, group.id);
  const [a, b, c] = game.players;

  game = reorderGamePlayers(db, game.id, [c.id, a.id, b.id]);

  assert.deepEqual(game.players.map((player) => player.name), ["C", "A", "B"]);
  assert.equal(game.round.first_caller_name, "C");
  assert.deepEqual(getGroup(db, group.id).players.map((player) => player.name), ["A", "B", "C"]);

  game = completeRound(db, game.id, [
    { playerId: a.id, bid: 0, hit: false },
    { playerId: b.id, bid: 0, hit: false },
    { playerId: c.id, bid: 0, hit: false }
  ]);

  assert.equal(game.round.first_caller_name, "A");
});

test("accepts and persists a complete round bid draft atomically", () => {
  const db = openDatabase(":memory:");
  let game = startGame(db, getDashboard(db).groups[0].id);
  const [ellie, paul] = game.players;
  game = completeRound(db, game.id, [
    { playerId: ellie.id, bid: 2, hit: true },
    { playerId: paul.id, bid: 1, hit: false }
  ]);

  assert.deepEqual(game.totals.map((total) => total.score), [14, 0]);
  assert.deepEqual(game.round_history[0].bids.map(({ bid, hit }) => ({ bid, hit })), [
    { bid: 2, hit: true },
    { bid: 1, hit: false }
  ]);
});

test("treats a retry for an already completed round as idempotent", () => {
  const db = openDatabase(":memory:");
  let game = startGame(db, getDashboard(db).groups[0].id);
  const roundId = game.round.id;
  const [ellie, paul] = game.players;
  const bids = [
    { playerId: ellie.id, bid: 2, hit: true },
    { playerId: paul.id, bid: 1, hit: false }
  ];

  game = completeRound(db, game.id, bids, roundId);
  game = completeRound(db, game.id, bids, roundId);

  assert.equal(game.round.round_number, 2);
  assert.equal(game.round_history.length, 1);
  assert.deepEqual(game.totals.map((total) => total.score), [14, 0]);
});

test("rejects a stale round completion that does not match the latest completed round", () => {
  const db = openDatabase(":memory:");
  let game = startGame(db, getDashboard(db).groups[0].id);
  const firstRoundId = game.round.id;
  const [ellie, paul] = game.players;
  game = completeRound(db, game.id, [
    { playerId: ellie.id, bid: 2, hit: true },
    { playerId: paul.id, bid: 1, hit: false }
  ], firstRoundId);
  game = completeRound(db, game.id, [
    { playerId: ellie.id, bid: 1, hit: true },
    { playerId: paul.id, bid: 1, hit: false }
  ], game.round.id);

  assert.throws(() => completeRound(db, game.id, [
    { playerId: ellie.id, bid: 2, hit: true },
    { playerId: paul.id, bid: 1, hit: false }
  ], firstRoundId), /no longer active/);
  assert.deepEqual(game.totals.map((total) => total.score), [25, 0]);
});

test("undoes the latest completed round and reopens its bid draft", () => {
  const db = openDatabase(":memory:");
  let game = startGame(db, getDashboard(db).groups[0].id);
  const [ellie, paul] = game.players;
  game = completeRound(db, game.id, [
    { playerId: ellie.id, bid: 2, hit: true },
    { playerId: paul.id, bid: 1, hit: false }
  ]);

  assert.deepEqual(game.totals.map((total) => total.score), [14, 0]);
  assert.equal(game.round.round_number, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM score_events").get().count, 1);

  game = undoRound(db, game.id);

  assert.equal(game.status, "active");
  assert.equal(game.round.round_number, 1);
  assert.deepEqual(game.totals.map((total) => total.score), [0, 0]);
  assert.deepEqual(game.round.bids.map(({ bid, hit }) => ({ bid, hit })), [
    { bid: 2, hit: true },
    { bid: 1, hit: false }
  ]);
  assert.equal(game.round_history.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM score_events").get().count, 0);
});

test("rejects incomplete or invalid round bid drafts without persisting them", () => {
  const db = openDatabase(":memory:");
  const game = startGame(db, getDashboard(db).groups[0].id);
  const [ellie, paul] = game.players;

  assert.throws(() => completeRound(db, game.id, [
    { playerId: ellie.id, bid: 2, hit: true }
  ]), /one bid for every player/);
  assert.throws(() => completeRound(db, game.id, [
    { playerId: ellie.id, bid: 8, hit: true },
    { playerId: paul.id, bid: 1, hit: false }
  ]), /between 0 and 7/);
  assert.throws(() => completeRound(db, game.id, [
    { playerId: ellie.id, bid: null, hit: true },
    { playerId: paul.id, bid: 1, hit: false }
  ]), /between 0 and 7/);
  assert.equal(game.round.bids.every((bid) => bid.bid === null), true);
});

test("creates seven-card tiebreakers after round thirteen until there is a leader", () => {
  const db = openDatabase(":memory:");
  let game = startGame(db, getDashboard(db).groups[0].id);
  const [ellie, paul] = game.players;
  for (let round = 1; round <= 13; round += 1) {
    game = completeRound(db, game.id, [
      { playerId: ellie.id, bid: 0, hit: false },
      { playerId: paul.id, bid: 0, hit: false }
    ]);
  }
  assert.equal(game.status, "active");
  assert.deepEqual(
    { number: game.round.round_number, cards: game.round.card_count, direction: game.round.direction },
    { number: 14, cards: 7, direction: "tiebreaker" }
  );
  game = completeRound(db, game.id, [
    { playerId: ellie.id, bid: 1, hit: true },
    { playerId: paul.id, bid: 0, hit: false }
  ]);
  assert.equal(game.status, "complete");
  assert.equal(game.winner_name, "Ellie");
});

test("undoes a completed final round and reactivates the game", () => {
  const db = openDatabase(":memory:");
  const group = getDashboard(db).groups[0];
  let game = startGame(db, group.id);
  const [ellie, paul] = game.players;
  for (let round = 1; round <= 13; round += 1) {
    game = completeRound(db, game.id, [
      { playerId: ellie.id, bid: 0, hit: true },
      { playerId: paul.id, bid: 0, hit: false }
    ]);
  }
  assert.equal(game.status, "complete");
  assert.deepEqual(getGroup(db, group.id).players.map(({ wins, losses }) => ({ wins, losses })), [{ wins: 1, losses: 0 }, { wins: 0, losses: 1 }]);

  game = undoRound(db, game.id);

  assert.equal(game.status, "active");
  assert.equal(game.winner_id, null);
  assert.equal(game.round.round_number, 13);
  assert.deepEqual(game.totals.map((total) => total.score), [120, 0]);
  assert.equal(game.round_history.length, 12);
  assert.deepEqual(getGroup(db, group.id).players.map(({ wins, losses }) => ({ wins, losses })), [{ wins: 0, losses: 0 }, { wins: 0, losses: 0 }]);
});

test("treats a retry for the completed final round as idempotent", () => {
  const db = openDatabase(":memory:");
  let game = startGame(db, getDashboard(db).groups[0].id);
  const [ellie, paul] = game.players;
  let finalRoundId;
  let finalBids;
  for (let round = 1; round <= 13; round += 1) {
    finalRoundId = game.round.id;
    finalBids = [
      { playerId: ellie.id, bid: 0, hit: true },
      { playerId: paul.id, bid: 0, hit: false }
    ];
    game = completeRound(db, game.id, finalBids, finalRoundId);
  }

  game = completeRound(db, game.id, finalBids, finalRoundId);

  assert.equal(game.status, "complete");
  assert.equal(game.round, null);
  assert.equal(game.round_history.length, 13);
  assert.deepEqual(game.totals.map((total) => total.score), [130, 0]);
});

test("reuses and deletes active games", () => {
  const db = openDatabase(":memory:");
  const group = createGroup(db, "Three friends", ["A", "B", "C"]);
  const game = startGame(db, group.id);
  assert.equal(startGame(db, group.id).id, game.id);
  deleteGame(db, game.id);
  assert.equal(getGroup(db, group.id).games.length, 0);
});
