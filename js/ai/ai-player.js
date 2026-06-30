/**
 * 达芬奇密码 - AI玩家
 * 5个难度等级，策略从随机到博弈优化
 */

const AIPlayer = {

  // ===== 难度1：新手 =====
  // 近乎随机，偶尔猜已公开的牌
  novice: {
    name: '新手',
    level: 1,

    decideGuess(game, dedState, myPlayerId) {
      // 找一个可猜的目标
      const targets = [];
      const me = game.players.find(p => p.id === myPlayerId);
      const ownCards = me.hand.filter(pc => !pc.isRevealed).map(pc => pc.card).filter(Boolean);

      for (const player of game.players) {
        if (player.id === myPlayerId || player.isEliminated) continue;
        for (const pc of player.hand) {
          if (!pc.isRevealed) {
            targets.push({ playerId: player.id, position: pc.position });
          }
        }
      }

      if (targets.length === 0) return null;

      const target = targets[Math.floor(Math.random() * targets.length)];

      // 随机颜色
      const color = Math.random() < 0.5 ? 'black' : 'white';

      // 随机数字（10%猜鬼牌）
      let number;
      if (Math.random() < 0.1) {
        number = 'joker';
      } else {
        number = Math.floor(Math.random() * 12); // 0-11
      }

      // 新手可能猜已经出现在自己手里的牌（这正是新手的特征）
      return {
        playerId: target.playerId,
        position: target.position,
        color,
        number,
      };
    },

    decideContinue(game, dedState, myPlayerId) {
      // 只有25%概率继续
      return Math.random() < 0.25;
    },

    decideJokerPosition(hand) {
      // 随机位置
      return Math.floor(Math.random() * (hand.length + 1));
    },

    thinkingTime() {
      return 300 + Math.random() * 600; // 0.3-0.9秒
    },
  },

  // ===== 难度2：入门 =====
  // 排除已公开牌，不做位置推理
  beginner: {
    name: '入门',
    level: 2,

    decideGuess(game, dedState, myPlayerId) {
      DeductionEngine.applyConstraints(dedState, game);

      const targets = [];
      for (const player of game.players) {
        if (player.id === myPlayerId || player.isEliminated) continue;
        for (const pc of player.hand) {
          if (!pc.isRevealed) {
            const possible = DeductionEngine.getPossibleCards(dedState, player.id, pc.position);
            if (possible.length > 0) {
              targets.push({
                playerId: player.id,
                position: pc.position,
                possible,
              });
            }
          }
        }
      }

      if (targets.length === 0) return null;

      // 随机选目标和猜测
      const target = targets[Math.floor(Math.random() * targets.length)];
      const guess = target.possible[Math.floor(Math.random() * target.possible.length)];

      return {
        playerId: target.playerId,
        position: target.position,
        color: guess.color,
        number: guess.number,
      };
    },

    decideContinue(game, dedState, myPlayerId) {
      // 40%概率停止，自己的牌暴露越多越保守
      const me = game.players.find(p => p.id === myPlayerId);
      const revealedCount = me.hand.filter(pc => pc.isRevealed).length;
      const revealRatio = revealedCount / me.hand.length;
      return Math.random() > (0.4 + revealRatio * 0.3);
    },

    decideJokerPosition(hand) {
      // 优先放两端
      return Math.random() < 0.7 ? 0 : hand.length;
    },

    thinkingTime() {
      return 400 + Math.random() * 800;
    },
  },

  // ===== 难度3：进阶 =====
  // 概率推理 + 位置约束
  intermediate: {
    name: '进阶',
    level: 3,

    decideGuess(game, dedState, myPlayerId) {
      DeductionEngine.applyConstraints(dedState, game);
      const best = DeductionEngine.getBestGuess(dedState, game, myPlayerId);

      if (!best) {
        // 兜底：随机猜
        return AIPlayer.beginner.decideGuess(game, dedState, myPlayerId);
      }

      return {
        playerId: best.playerId,
        position: best.position,
        color: best.card.color,
        number: best.card.number,
      };
    },

    decideContinue(game, dedState, myPlayerId) {
      const me = game.players.find(p => p.id === myPlayerId);
      const revealedCount = me.hand.filter(pc => pc.isRevealed).length;
      const revealRatio = revealedCount / me.hand.length;

      // 超过一半牌暴露就保守
      if (revealRatio > 0.5) return false;

      // 评估继续猜的风险
      // 找下一个最佳猜测
      const best = DeductionEngine.getBestGuess(dedState, game, myPlayerId);
      if (!best) return false;

      // 置信度高于阈值才继续
      const hasJokerInHand = me.hand.some(pc => !pc.isRevealed && pc.card && pc.card.number === 'joker');
      const threshold = hasJokerInHand ? 0.3 : 0.2;
      return best.confidence > threshold;
    },

    decideJokerPosition(hand, knownCards) {
      // 找使手牌最模糊的位置（候选最多的位置）
      let bestPos = 0;
      let bestAmbiguity = 0;

      for (let pos = 0; pos <= hand.length; pos++) {
        const testHand = [...hand];
        testHand.splice(pos, 0, { color: 'black', number: 'joker' });
        // 计算有多少种合法赋值
        const ambiguity = this._countValidAssignments(testHand, knownCards);
        if (ambiguity > bestAmbiguity) {
          bestAmbiguity = ambiguity;
          bestPos = pos;
        }
      }

      return bestPos;
    },

    _countValidAssignments(hand, knownCards) {
      // 简化的估值：宽区间 = 更多可能
      const jokerIdx = hand.findIndex(c => c.number === 'joker');
      if (jokerIdx < 0) return 0;

      let minKey = -Infinity;
      let maxKey = Infinity;

      for (let i = jokerIdx - 1; i >= 0; i--) {
        const c = hand[i];
        if (c.number !== 'joker') {
          minKey = GameCore.getCardSortKey(c);
          break;
        }
      }
      for (let i = jokerIdx + 1; i < hand.length; i++) {
        const c = hand[i];
        if (c.number !== 'joker') {
          maxKey = GameCore.getCardSortKey(c);
          break;
        }
      }

      return Math.max(0, maxKey - minKey);
    },

    thinkingTime() {
      return 500 + Math.random() * 1000;
    },
  },

  // ===== 难度4：高手 =====
  // 信息增益最大化 + 风险评估
  advanced: {
    name: '高手',
    level: 4,

    decideGuess(game, dedState, myPlayerId) {
      DeductionEngine.applyConstraints(dedState, game);

      let bestScore = -Infinity;
      let bestGuess = null;

      for (const player of game.players) {
        if (player.id === myPlayerId || player.isEliminated) continue;
        for (const pc of player.hand) {
          if (pc.isRevealed) continue;
          const candidates = DeductionEngine.getPossibleCards(dedState, player.id, pc.position);
          if (candidates.length === 0) continue;

          for (const candidate of candidates) {
            const infoGain = DeductionEngine.calculateInfoGain(
              dedState, game, player.id, pc.position, candidate
            );
            // 结合精确度和信息增益
            const precision = 1.0 / candidates.length;
            const score = precision * 0.3 + infoGain * 0.7;

            if (score > bestScore) {
              bestScore = score;
              bestGuess = {
                playerId: player.id,
                position: pc.position,
                color: candidate.color,
                number: candidate.number,
              };
            }
          }
        }
      }

      if (!bestGuess) {
        return AIPlayer.intermediate.decideGuess(game, dedState, myPlayerId);
      }
      return bestGuess;
    },

    decideContinue(game, dedState, myPlayerId) {
      const me = game.players.find(p => p.id === myPlayerId);
      const revealedCount = me.hand.filter(pc => pc.isRevealed).length;
      const revealRatio = revealedCount / Math.max(1, me.hand.length);

      if (revealRatio > 0.6) return false;

      // 计算继续的期望值
      const best = DeductionEngine.getBestGuess(dedState, game, myPlayerId);
      if (!best) return false;

      const pCorrect = best.confidence;
      const valueInfo = 1.0; // 信息价值
      const costReveal = (1.0 - revealRatio) * 2.0; // 暴露牌的代价

      const expectedValue = pCorrect * valueInfo - (1 - pCorrect) * costReveal;
      return expectedValue > 0;
    },

    decideJokerPosition(hand, knownCards) {
      // 用进阶版的方法，但考虑对手视角
      return AIPlayer.intermediate.decideJokerPosition(hand, knownCards);
    },

    thinkingTime() {
      return 600 + Math.random() * 1400;
    },
  },

  // ===== 难度5：大师 =====
  // 蒙特卡洛前瞻 + 自适应策略
  expert: {
    name: '大师',
    level: 5,

    decideGuess(game, dedState, myPlayerId) {
      DeductionEngine.applyConstraints(dedState, game);

      // 首先获取高手级别的基础评估
      const candidates = this._getAllGuessCandidates(game, dedState, myPlayerId);
      if (candidates.length === 0) {
        return AIPlayer.advanced.decideGuess(game, dedState, myPlayerId);
      }

      // 对前列候选进行浅层模拟
      const topCandidates = candidates
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

      let bestScore = -Infinity;
      let bestGuess = null;

      for (const cand of topCandidates) {
        // 模拟猜对后的收益
        const simScore = this._simulateGuess(game, dedState, myPlayerId, cand, 3);
        const totalScore = cand.score * 0.4 + simScore * 0.6;

        if (totalScore > bestScore) {
          bestScore = totalScore;
          bestGuess = cand;
        }
      }

      return bestGuess || topCandidates[0];
    },

    _getAllGuessCandidates(game, dedState, myPlayerId) {
      const candidates = [];
      for (const player of game.players) {
        if (player.id === myPlayerId || player.isEliminated) continue;
        for (const pc of player.hand) {
          if (pc.isRevealed) continue;
          const possible = DeductionEngine.getPossibleCards(dedState, player.id, pc.position);
          for (const card of possible) {
            const infoGain = DeductionEngine.calculateInfoGain(
              dedState, game, player.id, pc.position, card
            );
            candidates.push({
              playerId: player.id,
              position: pc.position,
              color: card.color,
              number: card.number,
              score: (1.0 / possible.length) + infoGain,
            });
          }
        }
      }
      return candidates;
    },

    _simulateGuess(game, dedState, myPlayerId, guess, depth) {
      // 简化模拟：评估猜对/猜错对信息空间的影响
      const gameClone = GameCore.deepCloneGame(game);
      const target = gameClone.players.find(p => p.id === guess.playerId);
      const card = target.hand.find(pc => pc.position === guess.position);

      if (!card || !card.card) return 0;

      const correct = card.card.color === guess.color && card.card.number === guess.number;

      if (correct) {
        // 猜对：减少不确定性
        const remainingHidden = game.players.reduce((sum, p) => {
          if (p.id === myPlayerId || p.isEliminated) return sum;
          return sum + p.hand.filter(pc => !pc.isRevealed).length;
        }, 0);
        return 1.0 + (1.0 / Math.max(1, remainingHidden));
      } else {
        return -0.5;
      }
    },

    decideContinue(game, dedState, myPlayerId) {
      // 用高手版逻辑，但更激进
      const me = game.players.find(p => p.id === myPlayerId);
      const revealedCount = me.hand.filter(pc => pc.isRevealed).length;
      const revealRatio = revealedCount / Math.max(1, me.hand.length);

      if (revealRatio > 0.7) return false;

      const best = DeductionEngine.getBestGuess(dedState, game, myPlayerId);
      if (!best) return false;

      // 对所有玩家剩余隐藏牌的分析
      const totalHidden = game.players.reduce((sum, p) => {
        if (p.isEliminated) return sum;
        return sum + p.hand.filter(pc => !pc.isRevealed).length;
      }, 0);

      // 如果全局隐藏牌很少，更激进
      if (totalHidden <= 3) return true;

      return best.confidence > 0.15;
    },

    decideJokerPosition(hand, knownCards) {
      // 故意放在中间（反直觉），混淆对手
      if (hand.length >= 3) {
        const middle = Math.floor(hand.length / 2);
        if (Math.random() < 0.4) return middle;
      }
      return AIPlayer.advanced.decideJokerPosition(hand, knownCards);
    },

    thinkingTime() {
      return 700 + Math.random() * 1600;
    },
  },

  // ===== 通用接口 =====

  /** 根据难度等级获取AI策略 */
  getStrategy(difficulty) {
    const strategies = [
      null,
      this.novice,
      this.beginner,
      this.intermediate,
      this.advanced,
      this.expert,
    ];
    return strategies[Math.min(difficulty, 5)] || this.novice;
  },

  /** 获取AI的猜测 */
  getGuess(difficulty, game, dedState, myPlayerId) {
    const strategy = this.getStrategy(difficulty);
    let guess = strategy.decideGuess(game, dedState, myPlayerId);

    // 兜底：如果所有策略都无法产生猜测，做完全随机猜测
    if (!guess) {
      // 找一个任意对手的任意未公开牌
      const me = game.players.find(p => p.id === myPlayerId);
      for (const player of game.players) {
        if (player.id === myPlayerId || player.isEliminated) continue;
        for (const pc of player.hand) {
          if (!pc.isRevealed) {
            const color = Math.random() < 0.5 ? 'black' : 'white';
            const number = Math.random() < 0.1 ? 'joker' : Math.floor(Math.random() * 12);
            guess = {
              playerId: player.id,
              position: pc.position,
              color,
              number,
            };
            break;
          }
        }
        if (guess) break;
      }
    }

    return guess;
  },

  /** 获取AI是否继续 */
  shouldContinue(difficulty, game, dedState, myPlayerId) {
    const strategy = this.getStrategy(difficulty);
    return strategy.decideContinue(game, dedState, myPlayerId);
  },

  /** 获取AI鬼牌放置位置 */
  getJokerPosition(difficulty, hand, knownCards) {
    const strategy = this.getStrategy(difficulty);
    return strategy.decideJokerPosition(hand, knownCards);
  },

  /** 获取AI思考时间 */
  getThinkingTime(difficulty) {
    const strategy = this.getStrategy(difficulty);
    return strategy.thinkingTime();
  },

  /** 难度标签 */
  getDifficultyName(difficulty) {
    const strategy = this.getStrategy(difficulty);
    return strategy.name;
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AIPlayer;
}
if (typeof window !== 'undefined') {
  window.AIPlayer = AIPlayer;
}
