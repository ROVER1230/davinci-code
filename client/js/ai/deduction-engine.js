/**
 * 达芬奇密码 - AI推理引擎
 * 维护每个对手每个位置的可能牌集合，支持启发式推理
 */

const DeductionEngine = {

  /**
   * 创建推理状态
   * @param {Object} game - 游戏状态
   * @param {string} myPlayerId - AI自己的ID
   */
  createState(game, myPlayerId) {
    const state = {
      myPlayerId,
      // 自己的手牌
      myHand: [],
      // 每个对手的每个位置 → 可能的牌集合 [{color, number}]
      opponentPossibilities: {},
      // 所有已公开的牌
      revealedCards: [],
      // 所有牌（完整26张追踪）
      allCards: this.getAllCardsList(),
      // 已确认使用的牌（自己手中 + 已公开）
      usedCards: new Set(),
    };

    // 初始化自己的手牌（包括已公开的——AI当然知道自己的牌）
    const me = game.players.find(p => p.id === myPlayerId);
    if (me) {
      const myCards = me.hand.map(pc => pc.card).filter(Boolean);
      state.myHand = myCards; // 全部自己的牌
      for (const card of myCards) {
        state.usedCards.add(card.color + '_' + card.number);
      }
    }

    // 初始化对手可能集合
    for (const player of game.players) {
      if (player.id === myPlayerId || player.isEliminated) continue;
      state.opponentPossibilities[player.id] = [];

      for (const pc of player.hand) {
        if (pc.isRevealed) {
          state.revealedCards.push({ playerId: player.id, position: pc.position, card: pc.card });
          state.usedCards.add(pc.card.color + '_' + pc.card.number);
          state.opponentPossibilities[player.id][pc.position] = null; // 已公开，不再是未知
        } else {
          // 初始所有可能牌
          state.opponentPossibilities[player.id][pc.position] = this.getAllPossibleCards(state);
        }
      }
    }

    // 应用排序约束缩小范围
    this.applyConstraints(state, game);

    return state;
  },

  /** 获取所有可能的牌值列表 */
  getAllCardsList() {
    const list = [];
    for (const color of ['black', 'white']) {
      for (let num = 0; num <= 11; num++) {
        list.push({ color, number: num });
      }
      list.push({ color, number: 'joker' });
    }
    return list;
  },

  /** 获取当前还可用的牌 */
  getAllPossibleCards(dedState) {
    return dedState.allCards.filter(c => !dedState.usedCards.has(c.color + '_' + c.number));
  },

  /**
   * 更新推理状态——新牌公开
   */
  onCardRevealed(dedState, playerId, position, card) {
    dedState.usedCards.add(card.color + '_' + card.number);
    dedState.revealedCards.push({ playerId, position, card });

    if (dedState.opponentPossibilities[playerId]) {
      dedState.opponentPossibilities[playerId][position] = null;
    }

    // 移除所有其他位置中对此牌的猜测
    for (const pid in dedState.opponentPossibilities) {
      const arr = dedState.opponentPossibilities[pid];
      for (let i = 0; i < arr.length; i++) {
        if (arr[i]) {
          arr[i] = arr[i].filter(c => !(c.color === card.color && c.number === card.number));
        }
      }
    }
  },

  /**
   * 更新推理状态——猜错（排除一种可能）
   */
  onGuessWrong(dedState, targetPlayerId, position, guessedCard) {
    if (dedState.opponentPossibilities[targetPlayerId] && dedState.opponentPossibilities[targetPlayerId][position]) {
      dedState.opponentPossibilities[targetPlayerId][position] = dedState.opponentPossibilities[targetPlayerId][position]
        .filter(c => !(c.color === guessedCard.color && c.number === guessedCard.number));
    }
  },

  /**
   * 应用排序约束
   * 例如：如果位置0只可能是黑3-白5，位置1必须≥位置0
   */
  applyConstraints(dedState, game) {
    for (const player of game.players) {
      if (player.id === dedState.myPlayerId || player.isEliminated) continue;
      const poss = dedState.opponentPossibilities[player.id];
      if (!poss) continue;

      const hand = player.hand;

      // 从左到右传播下界
      for (let i = 1; i < hand.length; i++) {
        if (!poss[i]) continue;
        const prevCard = hand[i - 1];
        if (prevCard.isRevealed && prevCard.card.number !== 'joker') {
          const minKey = GameCore.getCardSortKey(prevCard.card);
          poss[i] = poss[i].filter(c => {
            if (c.number === 'joker') return true;
            return GameCore.getCardSortKey(c) >= minKey;
          });
        }
        if (poss[i - 1]) {
          // 前一个位置的可能牌中最小值的下界
          const minPossible = poss[i - 1].reduce((min, c) => {
            if (c.number === 'joker') return min;
            const k = GameCore.getCardSortKey(c);
            return k < min ? k : min;
          }, Infinity);
          if (minPossible < Infinity) {
            poss[i] = poss[i].filter(c => {
              if (c.number === 'joker') return true;
              return GameCore.getCardSortKey(c) >= minPossible;
            });
          }
        }
      }

      // 从右到左传播上界
      for (let i = hand.length - 2; i >= 0; i--) {
        if (!poss[i]) continue;
        const nextCard = hand[i + 1];
        if (nextCard.isRevealed && nextCard.card.number !== 'joker') {
          const maxKey = GameCore.getCardSortKey(nextCard.card);
          poss[i] = poss[i].filter(c => {
            if (c.number === 'joker') return true;
            return GameCore.getCardSortKey(c) <= maxKey;
          });
        }
        if (poss[i + 1]) {
          const maxPossible = poss[i + 1].reduce((max, c) => {
            if (c.number === 'joker') return max;
            const k = GameCore.getCardSortKey(c);
            return k > max ? k : max;
          }, -Infinity);
          if (maxPossible > -Infinity) {
            poss[i] = poss[i].filter(c => {
              if (c.number === 'joker') return true;
              return GameCore.getCardSortKey(c) <= maxPossible;
            });
          }
        }
      }
    }
  },

  /**
   * 获取某个对手某位置的可能牌列表
   */
  getPossibleCards(dedState, playerId, position) {
    if (!dedState.opponentPossibilities[playerId]) return [];
    return dedState.opponentPossibilities[playerId][position] || [];
  },

  /**
   * 根据当前游戏状态刷新自己的手牌信息
   */
  refreshOwnHand(dedState, game, myPlayerId) {
    const me = game.players.find(p => p.id === myPlayerId);
    if (!me) return;

    // 清空旧的自己的牌
    for (const card of dedState.myHand) {
      dedState.usedCards.delete(card.color + '_' + card.number);
    }
    // 也清除之前记录的drawn card
    if (dedState._myDrawnCard) {
      dedState.usedCards.delete(dedState._myDrawnCard.color + '_' + dedState._myDrawnCard.number);
      dedState._myDrawnCard = null;
    }

    // 重新设置（包括已公开的牌——AI知道自己的所有牌）
    dedState.myHand = [];
    for (const pc of me.hand) {
      if (pc.card) {
        dedState.myHand.push(pc.card);
        dedState.usedCards.add(pc.card.color + '_' + pc.card.number);
      }
    }

    // 如果当前是此玩家的回合且已摸牌，也要排除摸到的牌
    if (game.currentPlayerIndex === me.seatIndex && game.drawnCard) {
      dedState.usedCards.add(game.drawnCard.color + '_' + game.drawnCard.number);
      dedState._myDrawnCard = game.drawnCard;
    }
  },

  /**
   * 获取最佳猜测建议
   * @returns {{ playerId, position, card, confidence }}
   */
  getBestGuess(dedState, game, myPlayerId) {
    let bestScore = -Infinity;
    let bestGuess = null;

    // 刷新自己的手牌（确保刚摸的牌也被排除）
    this.refreshOwnHand(dedState, game, myPlayerId);

    // 获取自己的手牌（不能猜自己手里有的牌）
    const me = game.players.find(p => p.id === myPlayerId);
    const myCardKeys = new Set();
    if (me) {
      for (const pc of me.hand) {
        if (!pc.isRevealed && pc.card) {
          myCardKeys.add(pc.card.color + '_' + pc.card.number);
        }
      }
    }

    for (const player of game.players) {
      if (player.id === myPlayerId || player.isEliminated) continue;
      const poss = dedState.opponentPossibilities[player.id];
      if (!poss) continue;

      for (let pos = 0; pos < player.hand.length; pos++) {
        const pc = player.hand[pos];
        if (pc.isRevealed) continue;
        const candidates = poss[pos];
        if (!candidates || candidates.length === 0) continue;

        // 过滤掉自己手中已有的牌
        const validCandidates = candidates.filter(c =>
          !myCardKeys.has(c.color + '_' + c.number)
        );

        if (validCandidates.length === 0) continue;

        // 基础分数：候选越少越好（确定性高）
        const score = 1.0 / Math.max(1, validCandidates.length);

        // 优先猜数字牌（鬼牌通常更难猜中）
        for (const candidate of validCandidates) {
          const isJoker = candidate.number === 'joker';
          const adjScore = score * (isJoker ? 1.2 : 1.0);

          if (adjScore > bestScore) {
            bestScore = adjScore;
            bestGuess = {
              playerId: player.id,
              position: pos,
              card: candidate,
              confidence: score,
            };
          }
        }
      }
    }

    return bestGuess;
  },

  /**
   * 计算信息增益——猜某张牌能获得多少信息
   */
  calculateInfoGain(dedState, game, targetPlayerId, position, guessedCard) {
    const poss = dedState.opponentPossibilities[targetPlayerId];
    if (!poss || !poss[position]) return 0;

    const candidates = poss[position];
    if (candidates.length === 0) return 0;

    // 如果猜中 -> 得到确定信息；如果猜错 -> 排除一个可能
    const pCorrect = 1.0 / candidates.length;
    let gainIfCorrect = 0;
    let gainIfWrong = Math.log2(candidates.length) - Math.log2(candidates.length - 1);

    // 猜对的信息增益：所有其他位置的约束都会变强
    if (pCorrect > 0) {
      gainIfCorrect = Math.log2(candidates.length); // 从不确定到确定
      // 加上对相邻位置的约束增益
      const hand = game.players.find(p => p.id === targetPlayerId).hand;
      // 简单估算
      gainIfCorrect += 0.5;
    }

    return pCorrect * gainIfCorrect + (1 - pCorrect) * gainIfWrong;
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = DeductionEngine;
}
if (typeof window !== 'undefined') {
  window.DeductionEngine = DeductionEngine;
}
