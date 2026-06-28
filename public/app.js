const app = document.querySelector("#app");
const dialog = document.querySelector("#group-dialog");
const groupForm = document.querySelector("#group-form");
const playerFields = document.querySelector("#player-fields");
const groupCloseButton = document.querySelector('[data-action="close-group"]');
let route = { page: "home" };
let currentGame = null;
let callerDrag = null;
let suppressNextClick = false;
const roundDrafts = new Map();
const trickPoints = [10, 11, 14, 19, 26, 35, 46, 59];

const icons = {
  arrow: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>`,
  back: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 18-6-6 6-6"/></svg>`
};

document.addEventListener("click", async (event) => {
  if (suppressNextClick) {
    event.preventDefault();
    suppressNextClick = false;
    return;
  }
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  if (action === "home") return navigate("/");
  if (action === "open-group") return openGroupDialog();
  if (action === "close-group") return closeGroupDialog();
  if (action === "add-player") return addPlayerField();
  if (action === "remove-player") return target.closest(".player-input").remove();
  if (action === "view-group") return navigate(`/groups/${target.dataset.id}`);
  if (action === "start-game") return startGame(target.dataset.id);
  if (action === "view-game") return navigate(`/games/${target.dataset.id}`);
  if (action === "set-bid") return setRoundBid(target);
  if (action === "toggle-hit") return toggleRoundHit(target);
  if (action === "set-caller") return setFirstCaller(target);
  if (action === "complete-round") return completeRound(target);
  if (action === "undo-round") return undoRound(target);
  if (action === "delete-game") return deleteGame(target.dataset.game, target.dataset.group);
});

document.addEventListener("pointerdown", startCallerOrderDrag);
document.addEventListener("pointermove", moveCallerOrderDrag);
document.addEventListener("pointerup", endCallerOrderDrag);
document.addEventListener("pointercancel", cancelCallerOrderDrag);
window.addEventListener("popstate", renderRoute);
groupForm.addEventListener("submit", createGroup);
dialog.addEventListener("click", closeGroupDialogFromBackdrop);
dialog.addEventListener("pointerdown", closeGroupDialogFromBackdrop);
groupCloseButton.addEventListener("touchend", closeGroupDialogFromTouch, { passive:false });

function navigate(path) { history.pushState({}, "", path); renderRoute(); }
async function renderRoute() {
  const parts = location.pathname.split("/").filter(Boolean);
  app.innerHTML = `<div class="loading">Shuffling the deck...</div>`;
  try {
    if (parts[0] === "groups" && parts[1]) { route = { page:"group", id:parts[1] }; return renderGroup(await api(`/api/groups/${parts[1]}`)); }
    if (parts[0] === "games" && parts[1]) { route = { page:"game", id:parts[1] }; return renderGame(await api(`/api/games/${parts[1]}`)); }
    route = { page:"home" }; renderHome(await api("/api/dashboard"));
  } catch (error) { app.innerHTML = `<div class="empty"><h3>Couldn’t load this table</h3><p>${escapeHtml(error.message)}</p><button class="button" data-action="home">Back home</button></div>`; }
}

function renderHome(data) {
  app.innerHTML = `
    <section class="hero"><div><span class="eyebrow">Cards down. Scores up.</span><h1>Keep score.<br><em>Settle the table.</em></h1><p>Your groups, games, and bragging rights in one place. Pick a crew and start playing.</p></div>
      <div class="summary"><div><strong>${data.totals.games}</strong><span>Games</span></div><div><strong>${data.totals.groups}</strong><span>Groups</span></div><div><strong>${data.totals.players}</strong><span>Players</span></div></div></section>
    <div class="section-head"><div><span class="eyebrow">Your tables</span><h2>Ready to play</h2><p>Start a new game with one click.</p></div></div>
    <section class="groups-grid">${data.groups.length ? data.groups.map(groupCard).join("") : `<div class="empty"><h3>No groups yet</h3><p>Create your first group to get a game going.</p></div>`}</section>`;
}

function groupCard(group) {
  const names = group.players.map((player) => player.name).join(", ");
  return `<article class="group-card"><div class="card-top"><div><h3>${escapeHtml(group.name)}</h3><span class="card-meta">${group.players.length} players · ${group.games_played} ${plural(group.games_played,"game")}</span></div>${group.active_games ? `<span class="active-pill">In play</span>`:""}</div>
    <div class="avatar-stack">${group.players.map((p) => `<span class="avatar">${initials(p.name)}</span>`).join("")}<span class="avatar-name">${escapeHtml(names)}</span></div>
    <div class="group-actions"><button class="button button-quiet" data-action="view-group" data-id="${group.id}">Stats</button><button class="button button-primary" data-action="start-game" data-id="${group.id}">${group.active_games ? "Resume game" : "New game"} ${icons.arrow}</button></div></article>`;
}

function renderGroup(group) {
  const completedGames=group.games.filter(game=>game.status==="complete").length;
  const activeGames=group.games.length-completedGames;
  app.innerHTML = `<section class="detail-hero"><button class="back" data-action="home">${icons.back} All groups</button><div class="detail-title"><div><span class="eyebrow">Group overview</span><h1>${escapeHtml(group.name)}</h1><p>${group.players.map((p)=>escapeHtml(p.name)).join(" · ")}</p></div><button class="button button-primary" data-action="start-game" data-id="${group.id}">+ ${group.games.some(g=>g.status==="active")?"Resume game":"New game"}</button></div></section>
    <section class="records">${group.players.map((player) => `<article class="record-card"><div class="record-name"><span class="mini-avatar">${initials(player.name)}</span>${escapeHtml(player.name)}</div><div class="record-numbers"><div><strong>${player.wins}</strong><span>Wins</span></div><div><strong>${player.losses}</strong><span>Losses</span></div></div></article>`).join("")}</section>
    <div class="section-head"><div><span class="eyebrow">The archive</span><h2>Game history</h2></div></div>
    <section class="history"><div class="history-header">${completedGames} ${plural(completedGames,"game")} completed${activeGames?` · ${activeGames} in progress`:""}</div>${group.games.length ? group.games.map((game,index)=>gameRow(game,group.games.length-index)).join("") : `<div class="empty"><h3>No games yet</h3><p>Start one to build your group history.</p></div>`}</section>`;
}

function gameRow(game, number) {
  const totals = game.status === "complete" ? rankedTotals(game.totals) : game.totals;
  return `<div class="game-row"><div class="game-main"><span class="game-number">#${number}</span><div><strong>${game.status === "active" ? `<span class="status">In progress</span>` : `${escapeHtml(game.winner_name)} won`}</strong><small>${formatDate(game.started_at)} · ${game.status === "active" ? "Tap to continue" : "Final score"}</small></div></div><div class="score-chips">${totals.map(t=>`<span class="score-chip">${escapeHtml(t.name)} <b>${t.score}</b></span>`).join("")}<button class="button button-quiet" data-action="view-game" data-id="${game.id}">${icons.arrow}</button></div></div>`;
}

function renderGame(game) {
  const active = game.status === "active";
  const displayTotals = active ? game.totals : rankedTotals(game.totals);
  currentGame = game;
  if (active) applyRoundDraft(game);
  app.innerHTML = `<section class="game-page"><button class="back" data-action="view-group" data-id="${game.group_id}">${icons.back} ${escapeHtml(game.group_name)}</button>
    <div class="game-head"><div><span class="eyebrow">${active?"Game in progress":"Final score"}</span><h1>${escapeHtml(game.group_name)}</h1><p>${formatDate(game.started_at)}</p></div><span class="live-badge">${active?"● Live":"Complete"}</span></div>
    ${active ? renderActiveRound(game) : `<section class="scoreboard">${displayTotals.map(total=>`<div class="score-total"><div class="total-player"><span class="mini-avatar">${initials(total.name)}</span>${escapeHtml(total.name)}${game.winner_id===total.player_id?` <span class="status">Winner</span>`:""}</div><div class="total-value">${total.score}<small>pts</small></div></div>`).join("")}<div class="complete-banner"><div class="winner-icon">◆</div><h2>${escapeHtml(game.winner_name)} takes the game</h2><p>The result is saved to ${escapeHtml(game.group_name)}’s record.</p></div></section>${roundHistory(game)}`}
    ${active ? "" : `<div class="finish-zone"><div><strong>Game archived</strong><p>This game counts toward player records.</p></div><button class="button button-danger" data-action="delete-game" data-game="${game.id}" data-group="${game.group_id}">Delete game</button></div>`}</section>`;
}

function renderActiveRound(game) {
  const round=game.round;
  const allBid=round.bids.every(bid=>bid.bid!==null);
  const direction=round.direction==="down"?"Going down":round.direction==="up"?"Going up":"Tiebreaker";
  const directionIcon=round.direction==="down"?"↓":round.direction==="up"?"↑":"◆";
  const roundLabel=round.round_number<=13?`Round ${round.round_number} of 13`:`Tiebreaker ${round.round_number-13}`;
  return `<section class="round-dashboard">
    <div class="round-banner"><div><span class="eyebrow">${roundLabel}</span><div class="card-count"><strong>${round.card_count}</strong><span>${plural(round.card_count,"card")} each</span></div></div><div class="direction-badge"><strong>${directionIcon}</strong><span>${direction}</span></div></div>
    ${roundProgress(round.round_number)}
    <div class="caller-panel"><div><span class="caller-label">First to call</span><small>Play order rotates each round</small></div><div class="caller-options">${game.players.map(player=>`<button type="button" class="caller-chip ${player.id===round.first_caller_id?"is-active":""}" data-action="set-caller" data-drag-caller data-game="${game.id}" data-player="${player.id}" aria-label="${escapeHtml(player.name)} in play order" title="Move in play order"><span class="mini-avatar">${initials(player.name)}</span>${escapeHtml(player.name)}</button>`).join("")}</div></div>
    <div class="round-instructions"><strong>Set each bid</strong><span>Then mark the players who hit it exactly.</span></div>
    <section class="round-player-grid">${game.totals.map(total=>roundPlayerCard(total,game)).join("")}</section>
    <div class="round-complete-zone"><div><strong>${round.round_number>=13?"Last hand ready?":"Hand finished?"}</strong><p>Hit bids score 10 + bid². Misses score zero.</p></div><button class="button button-primary complete-round-button" data-action="complete-round" data-game="${game.id}" ${allBid?"":"disabled"}>${round.round_number>=13?"Finish game":"Complete round"} <span>→</span></button></div>
    ${roundHistory(game)}
  </section>`;
}

function roundProgress(roundNumber) {
  return `<div class="round-progress" aria-label="Round ${Math.min(roundNumber,13)} of 13">${Array.from({length:13},(_,index)=>`<span class="${index+1<roundNumber?"is-done":index+1===roundNumber?"is-current":""}"></span>`).join("")}</div>`;
}

function roundPlayerCard(total,game) {
  const bid = game.round.bids.find(item => item.player_id === total.player_id);
  const hit = Boolean(bid?.hit);
  return `<article class="round-player-card ${hit?"is-hit":""}"><div class="round-player-head"><div class="total-player"><span class="mini-avatar">${initials(total.name)}</span><div><strong>${escapeHtml(total.name)}</strong></div></div><div class="player-score"><span class="score-value">${total.score}</span></div>${hit?`<span class="hit-badge">✓ Hit</span>`:""}</div>
    <div class="bid-label"><span>Bid tricks</span>${bid?.bid!==null?`<strong>${hit?`+${trickPoints[bid.bid]} points if completed`:"Bid set"}</strong>`:"<strong>Choose one</strong>"}</div>
    <div class="bid-grid">${trickPoints.slice(0,game.round.card_count+1).map((points,tricks)=>`<button class="bid-card ${bid?.bid===tricks?"is-selected":""} ${bid?.bid===tricks&&hit?"is-hit":""}" data-action="set-bid" data-game="${game.id}" data-player="${total.player_id}" data-bid="${tricks}" aria-pressed="${bid?.bid===tricks}"><strong>${tricks}</strong><span>${plural(tricks,"trick")}</span><small>+${points}</small></button>`).join("")}</div>
    <button class="hit-toggle ${hit?"is-active":""}" data-action="toggle-hit" data-game="${game.id}" data-player="${total.player_id}" data-hit="${hit?"0":"1"}" ${bid?.bid===null?"disabled":""}><span class="hit-check">${hit?"✓":""}</span>${hit?"Bid hit exactly":"Mark bid as hit"}</button></article>`;
}

function roundHistory(game) {
  if(!game.round_history?.length)return "";
  return `<section class="round-history"><div class="recent-head"><strong>Rounds played</strong><div class="round-history-actions"><span>${game.round_history.length}</span><button class="undo-round-button" data-action="undo-round" data-game="${game.id}">Undo last round</button></div></div><div class="round-history-list">${game.round_history.map(round=>`<div class="round-history-row"><div><strong>Round ${round.round_number}</strong><small>${round.card_count} ${plural(round.card_count,"card")} · ${round.direction==="down"?"↓ Down":round.direction==="up"?"↑ Up":"◆ Tiebreaker"}</small></div><div class="history-bids">${round.bids.map(bid=>`<span class="${bid.hit?"is-hit":""}">${escapeHtml(bid.name)} ${bid.bid}${bid.hit?` · +${trickPoints[bid.bid]}`:" · Miss"}</span>`).join("")}</div></div>`).join("")}</div></section>`;
}

async function startGame(groupId) { try { const game=await api(`/api/groups/${groupId}/games`,{method:"POST"}); navigate(`/games/${game.id}`); } catch(error){toast(error.message,true)} }
function rankedTotals(totals){return [...totals].sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name))}
function roundDraftKey(game){return `${game.id}:${game.round.id}`}
function applyRoundDraft(game){const key=roundDraftKey(game);if(!roundDrafts.has(key))roundDrafts.set(key,game.round.bids.map(bid=>({...bid})));game.round.bids=roundDrafts.get(key)}
function setRoundBid(button){const bid=currentGame?.round?.bids.find(item=>item.player_id===Number(button.dataset.player));if(!bid)return;bid.bid=Number(button.dataset.bid);bid.hit=false;renderGame(currentGame)}
function toggleRoundHit(button){const bid=currentGame?.round?.bids.find(item=>item.player_id===Number(button.dataset.player));if(!bid||bid.bid===null)return;bid.hit=!bid.hit;renderGame(currentGame)}
async function setFirstCaller(button){button.disabled=true;try{const game=await api(`/api/games/${button.dataset.game}/round/caller`,{method:"POST",body:JSON.stringify({playerId:Number(button.dataset.player)})});renderGame(game);toast(`${game.round.first_caller_name} calls first`)}catch(error){toast(error.message,true);button.disabled=false}}
function startCallerOrderDrag(event){
  const chip=event.target.closest("[data-drag-caller]");
  if(!chip||event.button!==0||!currentGame?.round)return;
  event.preventDefault();
  callerDrag={chip,gameId:chip.dataset.game,playerId:Number(chip.dataset.player),pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,dragging:false};
  chip.setPointerCapture?.(event.pointerId);
}
function moveCallerOrderDrag(event){
  if(!callerDrag||event.pointerId!==callerDrag.pointerId)return;
  const distance=Math.hypot(event.clientX-callerDrag.startX,event.clientY-callerDrag.startY);
  if(!callerDrag.dragging&&distance<7)return;
  if(!callerDrag.dragging){
    callerDrag.dragging=true;
    callerDrag.chip.classList.add("is-dragging");
    document.body.classList.add("is-reordering-callers");
  }
  event.preventDefault();
  document.querySelectorAll(".caller-chip.is-drop-target").forEach((chip)=>chip.classList.remove("is-drop-target"));
  const target=callerChipAtPoint(event.clientX,event.clientY);
  if(target&&target!==callerDrag.chip)target.classList.add("is-drop-target");
}
function endCallerOrderDrag(event){
  if(!callerDrag||event.pointerId!==callerDrag.pointerId)return;
  const drag=callerDrag;
  callerDrag=null;
  drag.chip.releasePointerCapture?.(event.pointerId);
  document.body.classList.remove("is-reordering-callers");
  document.querySelectorAll(".caller-chip.is-drop-target").forEach((chip)=>chip.classList.remove("is-drop-target"));
  event.preventDefault();
  suppressNextClick=true;
  setTimeout(()=>{suppressNextClick=false},0);
  if(!drag.dragging){setFirstCaller(drag.chip);return}
  const target=callerChipAtPoint(event.clientX,event.clientY);
  drag.chip.classList.remove("is-dragging");
  if(!target||target===drag.chip)return;
  const playerIds=orderedPlayerIdsAfterDrop(drag.playerId,Number(target.dataset.player),target,event.clientX,event.clientY);
  if(!playerIds)return;
  reorderCallerOrder(drag.gameId,playerIds);
}
function cancelCallerOrderDrag(event){
  if(!callerDrag||event.pointerId!==callerDrag.pointerId)return;
  callerDrag.chip.classList.remove("is-dragging");
  document.body.classList.remove("is-reordering-callers");
  document.querySelectorAll(".caller-chip.is-drop-target").forEach((chip)=>chip.classList.remove("is-drop-target"));
  callerDrag=null;
}
function callerChipAtPoint(x,y){
  return document.elementsFromPoint(x,y).map((element)=>element.closest?.("[data-drag-caller]")).find(Boolean);
}
function orderedPlayerIdsAfterDrop(movedId,targetId,targetChip,x,y){
  const current=currentGame?.players.map((player)=>player.id);
  if(!current||!current.includes(movedId)||!current.includes(targetId))return null;
  const next=current.filter((id)=>id!==movedId);
  const rect=targetChip.getBoundingClientRect();
  const after=y>rect.top+rect.height*.65||(y>=rect.top&&y<=rect.bottom&&x>rect.left+rect.width/2);
  const targetIndex=next.indexOf(targetId);
  next.splice(targetIndex+(after?1:0),0,movedId);
  return next.every((id,index)=>id===current[index])?null:next;
}
async function reorderCallerOrder(gameId,playerIds){
  try{
    const game=await api(`/api/games/${gameId}/players/order`,{method:"POST",body:JSON.stringify({playerIds})});
    renderGame(game);
    toast(`${game.round.first_caller_name} calls first`);
  }catch(error){
    toast(error.message,true);
  }
}
async function completeRound(button){button.disabled=true;const draftKey=roundDraftKey(currentGame);const roundId=currentGame.round.id;const bids=currentGame.round.bids.map(({player_id,bid,hit})=>({playerId:player_id,bid,hit}));try{const game=await api(`/api/games/${button.dataset.game}/round/complete`,{method:"POST",body:JSON.stringify({roundId,bids})});roundDrafts.delete(draftKey);renderGame(game);toast(game.status==="complete"?`${game.winner_name} wins the game`:`Round ${game.round.round_number-1} complete`)}catch(error){toast(error.message,true);button.disabled=false}}
async function undoRound(button){button.disabled=true;try{const game=await api(`/api/games/${button.dataset.game}/round/undo`,{method:"POST"});renderGame(game);toast(`Round ${game.round.round_number} reopened`)}catch(error){toast(error.message,true);button.disabled=false}}
async function deleteGame(gameId,groupId){if(!confirm("Delete this game and remove it from player records?"))return;try{await api(`/api/games/${gameId}`,{method:"DELETE"});navigate(`/groups/${groupId}`)}catch(error){toast(error.message,true)}}

function openGroupDialog(){ playerFields.innerHTML=""; addPlayerField("Ellie"); addPlayerField("Paul"); groupForm.reset(); document.querySelector("#group-error").textContent=""; dialog.showModal(); setTimeout(()=>groupForm.elements.name.focus(),50) }
function closeGroupDialog(){ if(!dialog.open)return; if(document.activeElement instanceof HTMLElement)document.activeElement.blur(); dialog.close() }
function closeGroupDialogFromTouch(event){event.preventDefault();event.stopPropagation();closeGroupDialog()}
function closeGroupDialogFromBackdrop(event){const point=event.changedTouches?.[0]||event;const bounds=dialog.getBoundingClientRect();const outside=point.clientX<bounds.left||point.clientX>bounds.right||point.clientY<bounds.top||point.clientY>bounds.bottom;if(outside){event.preventDefault();event.stopPropagation();closeGroupDialog()}}
function addPlayerField(value=""){if(playerFields.children.length>=8)return;const row=document.createElement("div");row.className="player-input";row.innerHTML=`<input name="player" placeholder="Player name" value="${escapeHtml(value)}" autocomplete="off" required><button type="button" class="remove-player" data-action="remove-player" aria-label="Remove player">×</button>`;playerFields.append(row)}
async function createGroup(event){event.preventDefault();const submitter=event.submitter;const players=[...groupForm.elements.player].map? [...groupForm.elements.player].map(i=>i.value):[groupForm.elements.player.value];try{submitter.disabled=true;const group=await api("/api/groups",{method:"POST",body:JSON.stringify({name:groupForm.elements.name.value,players})});dialog.close();navigate(`/groups/${group.id}`)}catch(error){document.querySelector("#group-error").textContent=error.message;submitter.disabled=false}}
async function api(url,options={}){const response=await fetch(url,{headers:{"Content-Type":"application/json"},...options});const body=await response.json();if(!response.ok)throw new Error(body.error||"Request failed.");return body}
function toast(message,isError=false){const el=document.querySelector("#toast");el.textContent=message;el.style.background=isError?"#ffd5d1":"#efffd0";el.classList.add("show");clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.classList.remove("show"),2500)}
function formatDate(value){return new Intl.DateTimeFormat("en",{month:"short",day:"numeric",year:"numeric"}).format(new Date(value.replace(" ","T")+"Z"))}
function plural(count,word){return count===1?word:`${word}s`}
function initials(name){return name.split(/\s+/).map(v=>v[0]).join("").slice(0,2).toUpperCase()}
function escapeHtml(value){return String(value??"").replace(/[&<>'"]/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[char])}
renderRoute();
