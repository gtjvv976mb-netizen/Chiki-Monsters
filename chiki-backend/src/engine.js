/* ============================================================================
 * engine.js — authoritative Chikiseum combat.
 *
 * This is a faithful port of the battle rules in play.html (beginRound /
 * applyCard / dealDamage / resolveTurn). The client renders what this engine
 * decides; it never computes damage itself for a live PvP match. Keep the two
 * in sync: any tuning change here must be mirrored in play.html's TVAL block
 * (and vice-versa) or replays will look wrong on screen.
 * ========================================================================== */

'use strict';

/* ---- card tables (mirror of play.html) ---- */
const KIND = ['atk', 'atk', 'atk', 'shi', 'util', 'atk', 'atk', 'atk', 'atk', 'util', 'atk', 'shi'];
const CARD_COST = [1, 2, 1, 1, 0, 1, 2, 1, 1, 1, 1, 2];
const ARCHK = ['strike', 'blast', 'quick', 'guard', 'charge', 'drain', 'nova', 'rend', 'jolt', 'rally', 'wither', 'bulwark'];
const ARCH_LABEL = ['Strike', 'Blast', 'Quick', 'Guard', 'Charge', 'Drain', 'Nova', 'Rend', 'Jolt', 'Rally', 'Wither', 'Bulwark'];

const TVAL = {
  strike: [0, 18, 20, 22, 24, 26], blast: [0, 30, 33, 36, 39, 42], quick: [0, 12, 14, 16, 18, 20],
  guardReflect: [0, 6, 7, 8, 9, 10], guardShield: [0, 30, 34, 38, 42, 46],
  charge: [0, 1.7, 1.8, 1.9, 2.0, 2.2], drainDmg: [0, 14, 16, 18, 20, 22], drainHeal: [0, 0.60, 0.64, 0.68, 0.72, 0.76],
  novaDmg: [0, 40, 44, 48, 52, 56], novaRecoil: [0, 8, 7, 6, 5, 4],
  rendDmg: [0, 16, 18, 20, 22, 24],
  joltDmg: [0, 10, 11, 12, 13, 14],
  rally: [0, 1.25, 1.30, 1.35, 1.40, 1.50],
  witherDmg: [0, 8, 9, 10, 11, 12], witherAmt: [0, 0.30, 0.33, 0.36, 0.39, 0.45],
  bulwarkShield: [0, 45, 50, 55, 60, 65], bulwarkReflect: [0, 10, 11, 12, 13, 14]
};

/* element triangle: each beats the next, Light loops back to Water */
const ELEM_NEXT = { Water: 'Fire', Fire: 'Beast', Beast: 'Storm', Storm: 'Light', Light: 'Water' };
const ELEMENTS = Object.keys(ELEM_NEXT);

const HAND_SIZE = 6;
const MAX_CARDS_PER_TURN = 3;
const MAX_ENERGY = 10;

function elemMult(a, b) {
  if (ELEM_NEXT[a] === b) return 1.5;
  if (ELEM_NEXT[b] === a) return 0.7;
  return 1;
}

const ri = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = ri(0, i);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function statsFor(br) {
  const b = Math.max(1, Math.min(30, br | 0 || 1));
  return { hp: 120 + b * 6, spd: 42 + b * 2, skill: 30 + b * 2, mor: 30 + b * 2 };
}

function tierOf(cardTier, slot) {
  const t = cardTier && cardTier[slot];
  return Math.min(5, Math.max(1, t || 1));
}

function cardDmgN(slot, t) {
  const k = ARCHK[slot];
  if (k === 'strike') return TVAL.strike[t];
  if (k === 'blast') return TVAL.blast[t];
  if (k === 'quick') return TVAL.quick[t];
  if (k === 'drain') return TVAL.drainDmg[t];
  if (k === 'nova') return TVAL.novaDmg[t];
  if (k === 'rend') return TVAL.rendDmg[t];
  if (k === 'jolt') return TVAL.joltDmg[t];
  if (k === 'wither') return TVAL.witherDmg[t];
  return 0;
}

/* A "snap" is what the client posts: {name, handle, element, br, arenaSkills, cardTier}. */
function normalizeSnap(snap) {
  const s = snap && typeof snap === 'object' ? snap : {};
  let skills = Array.isArray(s.arenaSkills) ? s.arenaSkills.map(n => n | 0).filter(n => n >= 0 && n < 12) : [];
  skills = [...new Set(skills)].sort((a, b) => a - b);
  if (!skills.length) skills = shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]).slice(0, 3).sort((a, b) => a - b);
  const tiers = {};
  for (const slot of skills) tiers[slot] = tierOf(s.cardTier, slot);
  return {
    name: String(s.name || 'Legendary').slice(0, 28),
    handle: String(s.handle || 'Trainer').slice(0, 28),
    element: ELEMENTS.includes(s.element) ? s.element : 'Fire',
    br: Math.max(1, Math.min(30, s.br | 0 || 1)),
    arenaSkills: skills,
    cardTier: tiers,
    uid: s.uid || null
  };
}

/* Build a fighter from a snapshot. Deck = 12 cards cycled from the owned skills. */
function makeSide(wallet, snap) {
  const sn = normalizeSnap(snap);
  const st = statsFor(sn.br);
  const deck = [];
  for (let i = 0; i < 12; i++) deck.push(sn.arenaSkills[i % sn.arenaSkills.length]);
  shuffle(deck);
  return {
    wallet,
    snap: sn,
    name: sn.name,
    handle: sn.handle,
    element: sn.element,
    br: sn.br,
    cardTier: sn.cardTier,
    st,
    hp: st.hp,
    maxhp: st.hp,
    shield: 0,
    energy: 0,
    buff: 1,
    draw: deck,
    hand: [],
    disc: [],
    ls: 0,
    started: false,
    playedThisTurn: 0,
    _reflect: 0,
    _turnBuff: 1,
    _joltNext: 0,
    _weaken: 0
  };
}

/* Reset a fighter for a fresh game in a best-of series (same Legendary, new deck). */
function resetSide(side) {
  const deck = [];
  for (let i = 0; i < 12; i++) deck.push(side.snap.arenaSkills[i % side.snap.arenaSkills.length]);
  shuffle(deck);
  Object.assign(side, {
    hp: side.st.hp, maxhp: side.st.hp, shield: 0, energy: 0, buff: 1,
    draw: deck, hand: [], disc: [], ls: 0, started: false, playedThisTurn: 0,
    _reflect: 0, _turnBuff: 1, _joltNext: 0, _weaken: 0
  });
  return side;
}

function drawTo(side, n) {
  for (let i = 0; i < n; i++) {
    if (!side.draw.length) { side.draw = shuffle(side.disc); side.disc = []; }
    if (!side.draw.length) break;
    side.hand.push(side.draw.pop());
  }
}

/* Start a planning round: refresh shields/energy and deal a fresh hand to both sides. */
function beginRound(a, b) {
  for (const s of [a, b]) {
    s.disc = s.disc.concat(s.hand);
    s.hand = [];
    s.shield = 0;
    s._reflect = 0;
    s._turnBuff = 1;
    s.energy = Math.min(MAX_ENERGY, s.started ? s.energy + 1 : 3);
    if (s._joltNext) { s.energy = Math.max(0, s.energy - s._joltNext); s._joltNext = 0; }
    s.started = true;
    s.buff = 1;
    s.playedThisTurn = 0;
    drawTo(s, HAND_SIZE);
  }
}

const critRoll = side => Math.random() < Math.min(0.5, side.st.mor / 240);

function applyHP(def, dmg) {
  if (def.ls > 0) { def.ls--; if (def.ls <= 0) def.hp = -1; return; }
  def.hp -= dmg;
  if (def.hp <= 0) {
    /* Last Stand: high-morale fighters cling on for a few more blows */
    if (Math.random() < def.st.mor / 255 || def.st.mor >= 120) {
      def.ls = 1 + Math.floor(def.st.mor / 60);
      def.hp = 1;
    }
  }
}

/* pierceFrac: 0 normal · 0.5 Rend (half pierce) · 1 Quick (full pierce) */
function dealDamage(att, def, raw, pierceFrac) {
  pierceFrac = pierceFrac || 0;
  let dmg = raw * att.buff; att.buff = 1;
  dmg *= (att._turnBuff || 1);
  dmg *= elemMult(att.element, def.element);
  if (att._weaken) { dmg *= (1 - att._weaken); att._weaken = 0; }
  if (att.playedThisTurn > 1) dmg += Math.round(att.st.skill * 0.4 * (att.playedThisTurn - 1));
  const crit = critRoll(att);
  if (crit) dmg *= 2;
  dmg = Math.round(dmg);
  const direct = Math.round(dmg * pierceFrac), viaShield = dmg - direct;
  if (def.shield > 0 && viaShield > 0) {
    if (def._reflect) applyHP(att, def._reflect);
    if (viaShield >= def.shield) {
      const over = Math.round((viaShield - def.shield) * 1.15);
      def.shield = 0;
      applyHP(def, direct + over);
    } else {
      def.shield -= viaShield;
      applyHP(def, direct);
    }
  } else {
    applyHP(def, dmg);
  }
  return crit;
}

function applyCard(side, foe, slot) {
  const t = tierOf(side.cardTier, slot), k = ARCHK[slot];
  side.energy = Math.max(0, side.energy - CARD_COST[slot]);
  side.playedThisTurn++;
  let crit = false;
  if (k === 'guard') {
    side.shield += TVAL.guardShield[t];
    side._reflect = Math.max(side._reflect || 0, TVAL.guardReflect[t]);
  } else if (k === 'bulwark') {
    side.shield += TVAL.bulwarkShield[t];
    side._reflect = Math.max(side._reflect || 0, TVAL.bulwarkReflect[t]);
  } else if (k === 'charge') {
    side.energy += 1;
    side.buff = Math.max(side.buff, TVAL.charge[t]);
  } else if (k === 'rally') {
    side._turnBuff = Math.max(side._turnBuff || 1, TVAL.rally[t]);
  } else if (k === 'drain') {
    crit = dealDamage(side, foe, TVAL.drainDmg[t], 0);
    side.hp = Math.min(side.maxhp, side.hp + Math.round(TVAL.drainDmg[t] * TVAL.drainHeal[t]));
  } else if (k === 'nova') {
    crit = dealDamage(side, foe, TVAL.novaDmg[t], 0);
    side.hp -= TVAL.novaRecoil[t];
  } else if (k === 'quick') {
    crit = dealDamage(side, foe, TVAL.quick[t], 1);
  } else if (k === 'rend') {
    crit = dealDamage(side, foe, TVAL.rendDmg[t], 0.5);
  } else if (k === 'jolt') {
    crit = dealDamage(side, foe, TVAL.joltDmg[t], 0);
    foe._joltNext = (foe._joltNext || 0) + 1;
  } else if (k === 'wither') {
    crit = dealDamage(side, foe, TVAL.witherDmg[t], 0);
    foe._weaken = Math.max(foe._weaken || 0, TVAL.witherAmt[t]);
  } else {
    crit = dealDamage(side, foe, k === 'strike' ? TVAL.strike[t] : TVAL.blast[t], 0);
  }
  return crit;
}

const isDead = s => s.hp <= 0 && s.ls <= 0;

/* Pick up to 3 affordable cards — used for AI opponents and for auto-play on timeout. */
function autoPlan(side) {
  const queue = [], used = new Set();
  let budget = side.energy;
  const take = pred => {
    for (let i = 0; i < side.hand.length; i++) {
      if (used.has(i)) continue;
      const s = side.hand[i];
      if (pred(s) && CARD_COST[s] <= budget && queue.length < MAX_CARDS_PER_TURN) {
        used.add(i); queue.push(i); budget -= CARD_COST[s];
        if (s === 4) budget += 1;
        return true;
      }
    }
    return false;
  };
  if (side.hp / side.maxhp < 0.4) { if (!take(s => s === 3)) take(s => s === 11); }
  if (side.hand.some(s => s === 4) && side.hand.some(s => s === 6 || s === 1)) take(s => s === 4);
  while (queue.length < MAX_CARDS_PER_TURN) {
    let bi = -1, bd = -1;
    for (let i = 0; i < side.hand.length; i++) {
      if (used.has(i)) continue;
      const s = side.hand[i];
      if (KIND[s] === 'atk' && CARD_COST[s] <= budget && cardDmgN(s, tierOf(side.cardTier, s)) > bd) {
        bd = cardDmgN(s, tierOf(side.cardTier, s));
        bi = i;
      }
    }
    if (bi < 0) break;
    used.add(bi); queue.push(bi); budget -= CARD_COST[side.hand[bi]];
  }
  return queue;
}

/* Clamp a client submission to something legal: real indices, <=3 cards, within energy. */
function sanitizeQueue(side, cards) {
  const out = [], seen = new Set();
  let spent = 0;
  for (const raw of Array.isArray(cards) ? cards : []) {
    const i = raw | 0;
    if (i < 0 || i >= side.hand.length || seen.has(i)) continue;
    const cost = CARD_COST[side.hand[i]];
    if (spent + cost > side.energy) continue;
    seen.add(i); out.push(i); spent += cost;
    if (out.length >= MAX_CARDS_PER_TURN) break;
  }
  return out;
}

/* Resolve one simultaneous turn. Returns the animation sequence the client replays. */
function resolveTurn(a, b, aQueue, bQueue, first) {
  const aSlots = aQueue.map(i => a.hand[i]);
  const bSlots = bQueue.map(i => b.hand[i]);

  /* discard played cards (highest index first so splices stay valid) */
  for (const [side, q] of [[a, aQueue], [b, bQueue]]) {
    q.slice().sort((x, y) => y - x).forEach(i => { side.disc.push(side.hand[i]); side.hand.splice(i, 1); });
  }

  const lists = { a: aSlots, b: bSlots };
  const second = first === 'a' ? 'b' : 'a';
  const order = [];
  const mx = Math.max(aSlots.length, bSlots.length);
  for (let i = 0; i < mx; i++) {
    if (lists[first][i] != null) order.push([first, lists[first][i]]);
    if (lists[second][i] != null) order.push([second, lists[second][i]]);
  }

  const seq = [];
  for (const [who, slot] of order) {
    const att = who === 'a' ? a : b, def = who === 'a' ? b : a;
    const crit = applyCard(att, def, slot);
    seq.push({
      who,
      slot,
      card: ARCH_LABEL[slot],
      crit: !!crit,
      aHp: Math.round(a.hp),
      bHp: Math.round(b.hp),
      aShield: a.shield,
      bShield: b.shield
    });
    if (isDead(a) || isDead(b)) break;
  }
  return seq;
}

module.exports = {
  KIND, CARD_COST, ARCHK, ARCH_LABEL, TVAL, ELEM_NEXT, ELEMENTS,
  HAND_SIZE, MAX_CARDS_PER_TURN, MAX_ENERGY,
  elemMult, ri, shuffle, statsFor, tierOf, cardDmgN, normalizeSnap,
  makeSide, resetSide, drawTo, beginRound, applyCard, dealDamage,
  isDead, autoPlan, sanitizeQueue, resolveTurn
};
