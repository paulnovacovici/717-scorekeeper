const test = require("node:test");
const assert = require("node:assert/strict");
const {
  openDatabase,
  getDashboard,
  getGroup,
  createGroup,
  startGame,
  setRoundBid,
  setRoundHit,
  setFirstCaller,
  completeRound,
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
  game = setRoundBid(db, game.id, ellie.id, 2);
  game = setRoundHit(db, game.id, ellie.id, true);
  game = setRoundBid(db, game.id, paul.id, 0);
  game = completeRound(db, game.id);

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
    game = setRoundBid(db, game.id, ellie.id, 0);
    game = setRoundHit(db, game.id, ellie.id, true);
    game = setRoundBid(db, game.id, paul.id, 0);
    game = completeRound(db, game.id);
  }

  assert.equal(game.status, "complete");
  assert.equal(game.winner_name, "Ellie");
  assert.deepEqual(game.totals.map((total) => total.score), [130, 0]);
  assert.deepEqual(callers, ["Ellie", "Paul", "Ellie", "Paul", "Ellie", "Paul", "Ellie", "Paul", "Ellie", "Paul", "Ellie", "Paul", "Ellie"]);
  assert.equal(game.round_history.length, 13);
  const records = getGroup(db, group.id).players.map(({ wins, losses }) => ({ wins, losses }));
  assert.deepEqual(records, [{ wins: 1, losses: 0 }, { wins: 0, losses: 1 }]);
});

test("validates bids and resets hit status when a bid changes", () => {
  const db = openDatabase(":memory:");
  let game = startGame(db, getDashboard(db).groups[0].id);
  const [ellie] = game.players;
  assert.throws(() => setRoundHit(db, game.id, ellie.id, true), /bid first/);
  assert.throws(() => setRoundBid(db, game.id, ellie.id, 8), /between 0 and 7/);
  assert.throws(() => completeRound(db, game.id), /Choose a bid/);
  game = setRoundBid(db, game.id, ellie.id, 2);
  game = setRoundHit(db, game.id, ellie.id, true);
  assert.equal(game.round.bids[0].hit, true);
  game = setRoundBid(db, game.id, ellie.id, 3);
  assert.equal(game.round.bids[0].hit, false);
});

test("creates seven-card tiebreakers after round thirteen until there is a leader", () => {
  const db = openDatabase(":memory:");
  let game = startGame(db, getDashboard(db).groups[0].id);
  const [ellie, paul] = game.players;
  for (let round = 1; round <= 13; round += 1) {
    game = setRoundBid(db, game.id, ellie.id, 0);
    game = setRoundBid(db, game.id, paul.id, 0);
    game = completeRound(db, game.id);
  }
  assert.equal(game.status, "active");
  assert.deepEqual(
    { number: game.round.round_number, cards: game.round.card_count, direction: game.round.direction },
    { number: 14, cards: 7, direction: "tiebreaker" }
  );
  game = setRoundBid(db, game.id, ellie.id, 1);
  game = setRoundHit(db, game.id, ellie.id, true);
  game = setRoundBid(db, game.id, paul.id, 0);
  game = completeRound(db, game.id);
  assert.equal(game.status, "complete");
  assert.equal(game.winner_name, "Ellie");
});

test("reuses and deletes active games", () => {
  const db = openDatabase(":memory:");
  const group = createGroup(db, "Three friends", ["A", "B", "C"]);
  const game = startGame(db, group.id);
  assert.equal(startGame(db, group.id).id, game.id);
  deleteGame(db, game.id);
  assert.equal(getGroup(db, group.id).games.length, 0);
});
