/**
 * 达芬奇密码 - 核心游戏引擎
 * 纯函数模块，不依赖浏览器或Node环境
 *
 * 卡牌规则：
 *   - 26张牌：黑色0-11(12张) + 白色0-11(12张) + 黑色鬼牌(1张) + 白色鬼牌(1张)
 *   - 排序：数字从小到大，同数字黑色<白色，鬼牌可放任意位置
 *   - 2-3人各4张起始手牌，4人各3张
 */

// ============ 常量 ============

const CARD_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const COLORS = ['black', 'white'];
const TOTAL_DECK_SIZE = 26; // 12黑 + 12白 + 2鬼牌

const PHASES = {
  WAITING:    'waiting',
  PLAYING:    'playing',
  DRAW:       'draw',
  GUESS:      'guess',
  JOKER_PLACE:'joker_place',
  REVEAL:     'reveal',
  REVEAL_OWN: 'reveal_own',    // 牌堆空时猜错，公开自己一张牌
  GAME_OVER:  'game_over',
};

const GAME_STATUS = {
  WAITING:  'waiting',
  PLAYING:  'playing',
  FINISHED: 'finished',
};

// ============ 工具函数 ============

/** 生成唯一ID (浏览器环境用crypto，否则用简单随机) */
function generateId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'id_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

/** 洗牌 (Fisher-Yates) */
function shuffle(arr) {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// ============ 牌组管理 ============

/** 创建完整牌组 */
function createDeck() {
  const cards = [];
  // 数字牌
  for (const color of COLORS) {
    for (const num of CARD_VALUES) {
      cards.push({ id: generateId(), color, number: num });
    }
  }
  // 鬼牌
  cards.push({ id: generateId(), color: 'black', number: 'joker' });
  cards.push({ id: generateId(), color: 'white', number: 'joker' });
  return cards;
}

/** 创建并洗牌 */
function createAndShuffleDeck() {
  return shuffle(createDeck());
}

/** 发牌 */
function dealCards(deck, playerCount) {
  const cardsPerPlayer = playerCount === 4 ? 3 : 4;
  const hands = [];
  let remaining = [...deck];

  for (let i = 0; i < playerCount; i++) {
    const hand = remaining.slice(0, cardsPerPlayer);
    remaining = remaining.slice(cardsPerPlayer);
    hands.push(hand);
  }

  return {
    hands: hands.map(h => sortHand(h)),
    drawPile: remaining,
    cardsPerPlayer,
  };
}

// ============ 手牌排序 ============

/**
 * 获取牌的排序键值
 * 数字牌按数值，黑色在白色左边；鬼牌返回特殊标记
 */
function getCardSortKey(card) {
  if (card.number === 'joker') return null; // 鬼牌位置自由
  // 数字 * 2，黑色+0，白色+1，保证同数字黑色<白色
  return card.number * 2 + (card.color === 'white' ? 1 : 0);
}

/** 排序手牌（鬼牌保持原位） */
function sortHand(hand) {
  // 分离鬼牌和非鬼牌
  const jokers = hand.filter(c => c.number === 'joker');
  const numbered = hand.filter(c => c.number !== 'joker');

  // 对数字牌排序
  numbered.sort((a, b) => getCardSortKey(a) - getCardSortKey(b));

  // 鬼牌插入到原手牌中鬼牌的位置
  // 由于洗牌后手牌无序，需要找到鬼牌在原数组中的位置
  if (jokers.length === 0) return numbered;

  // 先找出原手中鬼牌的位置索引（相对于排序后的位置）
  // 简化处理：鬼牌放最后，由玩家自行放置
  const result = [...numbered];
  for (const joker of jokers) {
    result.push(joker);
  }
  return result;
}

/**
 * 验证手牌是否合法（考虑鬼牌可在任意位置）
 * 原理：枚举鬼牌可能代表的牌值，检查是否存在一种赋值使手牌整体有序
 */
function validateHandWithJokers(hand) {
  const jokerPositions = [];
  const fixedCards = [];

  hand.forEach((card, idx) => {
    if (card.number === 'joker') {
      jokerPositions.push(idx);
    } else {
      fixedCards.push({ idx, sortKey: getCardSortKey(card), card });
    }
  });

  if (jokerPositions.length === 0) {
    // 没有鬼牌，直接检查排序
    for (let i = 1; i < hand.length; i++) {
      const prev = getCardSortKey(hand[i - 1]);
      const curr = getCardSortKey(hand[i]);
      if (prev !== null && curr !== null && prev > curr) return false;
    }
    return true;
  }

  // 固定牌必须内部有序
  for (let i = 1; i < fixedCards.length; i++) {
    if (fixedCards[i - 1].sortKey > fixedCards[i].sortKey) return false;
  }

  // 获取所有可能的牌值（用于鬼牌替换）
  const allPossibleValues = [];
  for (const color of COLORS) {
    for (const num of CARD_VALUES) {
      allPossibleValues.push({ color, number: num, sortKey: num * 2 + (color === 'white' ? 1 : 0) });
    }
  }

  // 所有可能的牌值（鬼牌可代表的）
  const availableValues = allPossibleValues;

  if (availableValues.length === 0) return false;

  // 对于每个鬼牌位置，尝试所有可能的候选值（回溯搜索）
  function tryAssign(jokerIdx, assigned) {
    if (jokerIdx >= jokerPositions.length) {
      // 所有鬼牌已赋值，验证整手牌
      const fullHand = hand.map((c, i) => {
        if (c.number !== 'joker') return c;
        return assigned[i];
      });
      for (let i = 1; i < fullHand.length; i++) {
        const pk = getCardSortKey(fullHand[i - 1]);
        const ck = getCardSortKey(fullHand[i]);
        if (pk !== null && ck !== null && pk > ck) return false;
      }
      return true;
    }

    const pos = jokerPositions[jokerIdx];
    let minKey = -Infinity;
    let maxKey = Infinity;

    // 左侧最近已知牌
    for (let i = pos - 1; i >= 0; i--) {
      const c = hand[i];
      const key = c.number === 'joker' ? (assigned[i] ? getCardSortKey(assigned[i]) : null) : getCardSortKey(c);
      if (key !== null) { minKey = key; break; }
    }
    // 右侧最近已知牌（包括已赋值的鬼牌）
    for (let i = pos + 1; i < hand.length; i++) {
      const c = hand[i];
      const key = c.number === 'joker' ? (assigned[i] ? getCardSortKey(assigned[i]) : null) : getCardSortKey(c);
      if (key !== null) { maxKey = key; break; }
    }

    const candidates = availableValues.filter(v => {
      if (Object.values(assigned).some(a => a && a.color === v.color && a.number === v.number)) return false;
      return v.sortKey >= minKey && v.sortKey <= maxKey;
    });

    if (candidates.length === 0) return false;

    // 遍历所有候选值（而非只尝试3个），确保不遗漏合法赋值
    for (const candidate of candidates) {
      assigned[pos] = candidate;
      if (tryAssign(jokerIdx + 1, assigned)) return true;
    }

    delete assigned[pos];
    return false;
  }

  return tryAssign(0, {});
}

// ============ 游戏状态初始化 ============

/** 创建新游戏 */
function createGame(options = {}) {
  const {
    playerCount = 2,
    playerNames = [],
    aiPlayers = [],
    aiDifficulties = [],
    mode = 'ai',
    enableJoker = true,
  } = options;

  // 校验
  if (playerCount < 2 || playerCount > 4) {
    throw new Error('玩家数量必须是2-4人');
  }

  // 创建牌组
  let deck;
  if (enableJoker) {
    deck = createAndShuffleDeck();
  } else {
    // 无鬼牌模式：移除鬼牌
    deck = shuffle(createDeck().filter(c => c.number !== 'joker'));
  }

  // 发牌
  const { hands, drawPile, cardsPerPlayer } = dealCards(deck, playerCount);

  // 创建玩家状态
  const players = [];
  for (let i = 0; i < playerCount; i++) {
    const isAI = aiPlayers.includes(i);
    players.push({
      id: generateId(),
      userId: null,
      name: playerNames[i] || (isAI ? `电脑${i + 1}` : `玩家${i + 1}`),
      seatIndex: i,
      hand: hands[i].map((card, pos) => ({
        cardId: card.id,
        position: pos,
        isRevealed: false,
        card: card,
      })),
      isActive: true,
      isEliminated: false,
      isAI: isAI,
      aiDifficulty: aiDifficulties[i] || 1,
      connected: true,
    });
  }

  const game = {
    id: generateId(),
    mode,
    status: GAME_STATUS.PLAYING,
    players,
    currentPlayerIndex: 0,
    phase: PHASES.DRAW,
    deck: drawPile,
    drawnCard: null,
    turnNumber: 1,
    turnTimeLimit: mode === 'online' ? 60 : null,
    turnStartedAt: Date.now(),
    winnerId: null,
    settings: {
      playerCount,
      cardsPerPlayer,
      enableJoker,
    },
    history: [],
  };

  return game;
}

// ============ 核心操作 ============

/**
 * 玩家摸牌
 * 返回新游戏状态
 */
function drawCard(game) {
  if (game.phase !== PHASES.DRAW && game.phase !== PHASES.PLAYING) {
    throw new Error('当前阶段不能摸牌');
  }

  const player = game.players[game.currentPlayerIndex];
  if (!player.isActive || player.isEliminated) {
    throw new Error('当前玩家已出局');
  }

  const newGame = deepCloneGame(game);

  if (newGame.deck.length > 0) {
    // 从牌堆摸牌
    newGame.drawnCard = newGame.deck.pop();
    newGame.phase = PHASES.GUESS;
    addHistory(newGame, 'draw', {
      cardDrawn: true,
      deckRemaining: newGame.deck.length,
      drawnCard: { color: newGame.drawnCard.color, number: newGame.drawnCard.number },
    });
  } else {
    // 牌堆已空，直接进入猜测阶段（不摸牌）
    newGame.drawnCard = null;
    newGame.phase = PHASES.GUESS;
    addHistory(newGame, 'draw', { cardDrawn: false, deckEmpty: true });
  }

  newGame.turnStartedAt = Date.now();
  return newGame;
}

/**
 * 玩家猜测对手的牌
 * @param {Object} game - 当前游戏状态
 * @param {string} targetPlayerId - 目标玩家ID
 * @param {number} targetPosition - 目标牌位置
 * @param {string} guessedColor - 猜测的颜色 'black'|'white'
 * @param {number|string} guessedNumber - 猜测的数字 0-11 或 'joker'
 * @returns {Object} { game, correct, revealedCard }
 */
function makeGuess(game, targetPlayerId, targetPosition, guessedColor, guessedNumber, options = {}) {
  const { autoRevealOnWrong = true } = options;
  if (game.phase !== PHASES.GUESS) {
    throw new Error('当前阶段不能猜测');
  }

  const player = game.players[game.currentPlayerIndex];
  if (!player.isActive || player.isEliminated) {
    throw new Error('当前玩家已出局');
  }

  // 不能猜自己
  if (targetPlayerId === player.id) {
    throw new Error('不能猜测自己的牌');
  }

  // 找目标玩家
  const targetPlayer = game.players.find(p => p.id === targetPlayerId);
  if (!targetPlayer || targetPlayer.isEliminated) {
    throw new Error('目标玩家不存在或已出局');
  }

  // 找目标牌
  const targetCard = targetPlayer.hand.find(pc => pc.position === targetPosition && !pc.isRevealed);
  if (!targetCard) {
    throw new Error('目标牌不存在或已公开');
  }

  const actualCard = targetCard.card;

  const newGame = deepCloneGame(game);
  const correct = actualCard.color === guessedColor && actualCard.number === guessedNumber;

  addHistory(newGame, 'guess', {
    guesserId: player.id,
    targetId: targetPlayerId,
    targetCardId: targetCard.card.id,
    position: targetPosition,
    guessed: { color: guessedColor, number: guessedNumber },
    actual: actualCard ? { color: actualCard.color, number: actualCard.number } : null,
    correct,
  });

  if (correct) {
    // 猜对：目标牌公开
    const targetInNew = newGame.players.find(p => p.id === targetPlayerId);
    const cardInNew = targetInNew.hand.find(pc => pc.position === targetPosition);
    cardInNew.isRevealed = true;

    // 检查目标是否被淘汰
    checkElimination(targetInNew);

    // 检查游戏是否结束
    const winner = checkWinner(newGame);
    if (winner) {
      // 游戏结束前，将摸到的牌插入胜者手牌（避免牌数丢失）
      if (newGame.drawnCard) {
        const winnerInNew = newGame.players.find(p => p.id === winner.id);
        insertCardSecretly(winnerInNew, newGame.drawnCard);
        newGame.drawnCard = null;
      }
      newGame.winnerId = winner.id;
      newGame.status = GAME_STATUS.FINISHED;
      newGame.phase = PHASES.GAME_OVER;
    }
    // 否则保持在GUESS阶段，玩家可选择继续或停止

    return { game: newGame, correct: true, revealedCard: actualCard, targetEliminated: targetInNew.isEliminated };
  } else {
    // 猜错
    if (newGame.drawnCard) {
      if (autoRevealOnWrong) {
        // 自动公开摸到的牌（AI行为）
        revealDrawnCardAndInsert(newGame, player.id);
      } else {
        // 秘密插入手牌，让玩家自选公开哪张
        insertCardSecretly(player, newGame.drawnCard);
        newGame.drawnCard = null;
        newGame.phase = PHASES.REVEAL_OWN;
        addHistory(newGame, 'reveal_own_pending', { note: 'player_must_choose' });
      }
    } else {
      // 牌堆已空没摸牌：需要公开自己一张未公开牌
      newGame.phase = PHASES.REVEAL_OWN;
    }

    return { game: newGame, correct: false };
  }
}

/**
 * 玩家猜对后选择停止
 */
function stopAfterCorrect(game) {
  if (game.phase !== PHASES.GUESS) {
    throw new Error('当前阶段不能停止');
  }

  const newGame = deepCloneGame(game);
  const player = newGame.players[newGame.currentPlayerIndex];

  // 把摸到的牌秘密插入手牌
  let insertedCard = null;
  if (newGame.drawnCard) {
    insertedCard = newGame.drawnCard;
    insertCardSecretly(player, newGame.drawnCard);
    newGame.drawnCard = null;
  }

  addHistory(newGame, 'stop', {
    insertedCard: insertedCard ? { color: insertedCard.color, number: insertedCard.number } : null,
    handSize: player.hand.length,
  });
  advanceToNextPlayer(newGame);
  return newGame;
}

/**
 * 放置鬼牌
 */
function placeJoker(game, position) {
  if (game.phase !== PHASES.JOKER_PLACE) {
    throw new Error('当前阶段不能放置鬼牌');
  }

  const newGame = deepCloneGame(game);
  const player = newGame.players[newGame.currentPlayerIndex];
  const joker = newGame.drawnCard;

  if (!joker || joker.number !== 'joker') {
    throw new Error('摸到的不是鬼牌');
  }

  // 验证位置合法性
  if (position < 0 || position > player.hand.length) {
    throw new Error('无效的放置位置');
  }

  // 插入鬼牌
  const newCard = {
    cardId: joker.id,
    position: position,
    isRevealed: false,
    card: joker,
  };

  player.hand.splice(position, 0, newCard);
  // 更新所有position
  player.hand.forEach((pc, idx) => { pc.position = idx; });

  // 验证手牌合法性（传入全部手牌，包含已公开牌作为排序锚点）
  // 鬼牌放在末尾总是合法的（无需验证）
  if (position < player.hand.length - 1) {
    const handCards = player.hand.map(pc => pc.card).filter(Boolean);
    if (!validateHandWithJokers(handCards)) {
      throw new Error('鬼牌放置位置不合法：无法使手牌有序');
    }
  }

  newGame.drawnCard = null;
  newGame.phase = PHASES.GUESS;

  // 找到刚放置的鬼牌（的卡牌信息）
  const placedCard2 = player.hand.find(pc => pc.position === position);
  addHistory(newGame, 'joker_place', {
    position,
    cardId: placedCard2 && placedCard2.card ? placedCard2.card.id : null,
    card: placedCard2 && placedCard2.card ? { color: placedCard2.card.color, number: placedCard2.card.number } : null,
  });
  return newGame;
}

/**
 * 牌堆空时猜错，公开自己一张未公开牌
 */
function revealOwnCard(game, position) {
  if (game.phase !== PHASES.REVEAL_OWN) {
    throw new Error('当前阶段不需要公开自己的牌');
  }

  const newGame = deepCloneGame(game);
  const player = newGame.players[newGame.currentPlayerIndex];
  const card = player.hand.find(pc => pc.position === position && !pc.isRevealed);

  if (!card) {
    throw new Error('该位置没有未公开的牌');
  }

  card.isRevealed = true;
  addHistory(newGame, 'reveal_own', { position, cardId: card.card.id });

  // 检查是否被淘汰
  checkElimination(player);

  // 检查游戏结束
  const winner = checkWinner(newGame);
  if (winner) {
    newGame.winnerId = winner.id;
    newGame.status = GAME_STATUS.FINISHED;
    newGame.phase = PHASES.GAME_OVER;
  } else {
    advanceToNextPlayer(newGame);
  }

  return newGame;
}

// ============ 辅助函数 ============

/** 公开摸的牌并插入手牌 */
function revealDrawnCardAndInsert(game, playerId) {
  const player = game.players.find(p => p.id === playerId);
  if (!player || !game.drawnCard) return;

  // 插入到正确位置并标记为公开
  const card = game.drawnCard;
  const newCard = {
    cardId: card.id,
    position: 0,
    isRevealed: true,
    card: card,
  };

  // 找到正确插入位置
  const sortKey = getCardSortKey(card);
  let insertPos = player.hand.length;
  if (sortKey !== null) {
    for (let i = 0; i < player.hand.length; i++) {
      const pc = player.hand[i];
      const existingKey = getCardSortKey(pc.card);
      if (existingKey !== null && sortKey < existingKey) {
        insertPos = i;
        break;
      }
    }
  }

  player.hand.splice(insertPos, 0, newCard);
  player.hand.forEach((pc, idx) => { pc.position = idx; });

  game.drawnCard = null;
  checkElimination(player);

  // 检查游戏结束
  const winner = checkWinner(game);
  if (winner) {
    game.winnerId = winner.id;
    game.status = GAME_STATUS.FINISHED;
    game.phase = PHASES.GAME_OVER;
  } else {
    advanceToNextPlayer(game);
  }
}

/** 秘密插入牌到手牌 */
function insertCardSecretly(player, card) {
  const sortKey = getCardSortKey(card);
  let insertPos = player.hand.length;

  // 鬼牌放最后，等玩家之后再调整
  if (sortKey !== null) {
    for (let i = 0; i < player.hand.length; i++) {
      const pc = player.hand[i];
      const existingKey = getCardSortKey(pc.card);
      if (existingKey !== null && sortKey < existingKey) {
        insertPos = i;
        break;
      }
    }
  }

  const newCard = {
    cardId: card.id,
    position: insertPos,
    isRevealed: false,
    card: card,
  };

  player.hand.splice(insertPos, 0, newCard);
  player.hand.forEach((pc, idx) => { pc.position = idx; });
}

/** 检查玩家是否被淘汰（所有牌都公开了） */
function checkElimination(player) {
  const allRevealed = player.hand.every(pc => pc.isRevealed);
  if (allRevealed && player.hand.length > 0) {
    player.isEliminated = true;
    player.isActive = false;
  }
}

/** 检查胜者 */
function checkWinner(game) {
  const activePlayers = game.players.filter(p => !p.isEliminated);
  if (activePlayers.length === 1) {
    return activePlayers[0];
  }
  if (activePlayers.length === 0) {
    // 所有玩家同时淘汰：最后被淘汰的玩家算胜者
    // 从历史记录中找到最后一个被淘汰的人的前一个活跃玩家
    return game.players[game.players.length - 1] || null;
  }
  return null;
}

/** 推进到下一个玩家 */
function advanceToNextPlayer(game) {
  const playerCount = game.players.length;
  let nextIndex = (game.currentPlayerIndex + 1) % playerCount;
  let attempts = 0;

  // 跳过已淘汰的玩家
  while (game.players[nextIndex].isEliminated && attempts < playerCount) {
    nextIndex = (nextIndex + 1) % playerCount;
    attempts++;
  }

  game.currentPlayerIndex = nextIndex;
  game.phase = PHASES.DRAW;
  game.turnNumber++;
  game.turnStartedAt = Date.now();
}

/** 获取游戏中所有已知的牌 */
function getAllKnownCards(game, viewerId) {
  const known = [];
  for (const player of game.players) {
    for (const pc of player.hand) {
      if (pc.isRevealed) {
        known.push(pc.card);
      } else if (player.id === viewerId) {
        known.push(pc.card);
      }
    }
  }
  return known;
}

/**
 * 移动手牌中的一张牌到新位置（用于初始鬼牌放置）
 * @returns 新游戏状态
 */
function moveCardInHand(game, playerId, fromPosition, toPosition) {
  const newGame = deepCloneGame(game);
  const player = newGame.players.find(p => p.id === playerId);
  if (!player) throw new Error('玩家不存在');

  // 移除
  const [moved] = player.hand.splice(fromPosition, 1);
  if (!moved) throw new Error('无效的源位置');

  // 插入（考虑移除后的偏移）
  let insertPos = toPosition;
  if (toPosition > fromPosition) insertPos--;
  player.hand.splice(insertPos, 0, moved);

  // 更新位置编号
  player.hand.forEach((pc, idx) => { pc.position = idx; });

  addHistory(newGame, 'move_card', { fromPosition, toPosition });
  return newGame;
}

/** 获取对指定玩家可见的游戏状态（用于联机模式的信息隔离） */
function getVisibleState(game, playerId) {
  const state = deepCloneGame(game);

  // 隐藏其他玩家的未公开牌
  for (const player of state.players) {
    if (player.id !== playerId) {
      for (const pc of player.hand) {
        if (!pc.isRevealed) {
          pc.card = null; // 隐藏牌值
        }
      }
    }
  }

  // 隐藏牌堆和摸到的牌
  state.deck = state.deck.map(() => null);
  state.drawnCard = null;

  return state;
}

/** 添加历史记录 */
function addHistory(game, actionType, data) {
  game.history.push({
    turnNumber: game.turnNumber,
    playerIndex: game.currentPlayerIndex,
    actionType,
    data,
    timestamp: Date.now(),
  });
}

/** 深拷贝游戏状态 */
function deepCloneGame(game) {
  return JSON.parse(JSON.stringify(game));
}

// ============ 导出 ============

const GameCore = {
  // 常量
  PHASES,
  GAME_STATUS,
  CARD_VALUES,
  COLORS,
  TOTAL_DECK_SIZE,

  // 牌组
  createDeck,
  createAndShuffleDeck,
  dealCards,
  shuffle,

  // 手牌
  sortHand,
  getCardSortKey,
  validateHandWithJokers,

  // 游戏生命周期
  createGame,
  drawCard,
  makeGuess,
  stopAfterCorrect,
  placeJoker,
  revealOwnCard,

  // 辅助
  advanceToNextPlayer,
  checkWinner,
  checkElimination,
  getVisibleState,
  getAllKnownCards,
  moveCardInHand,
  generateId,
  deepCloneGame,
};

// 支持浏览器和Node环境
if (typeof module !== 'undefined' && module.exports) {
  module.exports = GameCore;
}
if (typeof window !== 'undefined') {
  window.GameCore = GameCore;
}
