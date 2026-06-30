/**
 * 达芬奇密码 - 游戏管理器
 * 管理游戏状态、AI交互、玩家输入
 */

const GameManager = {
  // 当前游戏
  game: null,
  // 当前玩家ID（人类玩家）
  humanPlayerId: null,
  // AI推理状态
  dedStates: {},
  // 游戏模式
  mode: 'ai',
  // 本地多人玩家索引
  localPlayerIndex: 0,
  // 已放置过的初始鬼牌ID集合（防止两张鬼牌时死循环）
  _placedInitialJokerIds: null,
  // 回调
  onStateChange: null,
  onPhaseChange: null,
  onGuessResult: null,
  onGameOver: null,
  onAITurn: null,
  onAIGuessConfirm: null,  // AI猜测时需要玩家确认的回调
  onPlayerGuessConfirm: null,  // 玩家自己猜测结果的确认回调
  onToast: null,

  // AI暂停机制
  _aiPauseResolver: null,
  // 玩家猜测结果确认暂停
  _playerConfirmResolver: null,

  /**
   * 初始化游戏
   */
  init(options) {
    const {
      mode = 'ai',
      playerCount = 2,
      playerName = '你',
      aiDifficulty = 1,
      enableJoker = true,
    } = options;

    this.mode = mode;

    const playerNames = [];
    const aiPlayers = [];
    const aiDifficulties = [];

    if (mode === 'ai') {
      playerNames.push(playerName);
      for (let i = 1; i < playerCount; i++) {
        playerNames.push(`电脑${i}`);
        aiPlayers.push(i);
        aiDifficulties.push(aiDifficulty);
      }
    } else if (mode === 'local') {
      for (let i = 0; i < playerCount; i++) {
        playerNames.push(options.playerNames[i] || `玩家${i + 1}`);
      }
    }

    try {
      this.game = GameCore.createGame({
        playerCount,
        playerNames,
        aiPlayers,
        aiDifficulties,
        mode,
        enableJoker,
      });
    } catch (e) {
      if (this.onToast) this.onToast(e.message, 'error');
      return false;
    }

    // 人类是第一个非AI玩家
    const human = this.game.players.find(p => !p.isAI);
    this.humanPlayerId = human ? human.id : this.game.players[0].id;

    // 初始化AI推理
    for (const player of this.game.players) {
      if (player.isAI) {
        this.dedStates[player.id] = DeductionEngine.createState(this.game, player.id);
      }
    }

    this.localPlayerIndex = 0;
    this._placedInitialJokerIds = new Set();
    return true;
  },

  /**
   * 检查人类玩家手牌中是否有鬼牌（初始发牌后）
   * @returns {Array} 鬼牌位置列表
   */
  getInitialJokers() {
    if (!this.game) return [];
    const human = this.game.players.find(p => p.id === this.humanPlayerId);
    if (!human) return [];
    // 过滤掉已经放置过的鬼牌（通过cardId去重，防止两张鬼牌时死循环）
    const placed = this._placedInitialJokerIds || new Set();
    return human.hand
      .map((pc, idx) => ({ position: idx, card: pc.card }))
      .filter(item => item.card && item.card.number === 'joker' && !placed.has(item.card.id))
      .map(item => item.position);
  },

  /**
   * 移动初始手牌中的鬼牌到指定位置
   */
  placeInitialJoker(fromPosition, toPosition) {
    if (!this.game) return;
    const human = this.game.players.find(p => p.id === this.humanPlayerId);
    if (!human) return;
    // 记录该鬼牌的cardId，防止后续重复处理
    const pc = human.hand.find(c => c.position === fromPosition);
    if (pc && pc.card) {
      if (!this._placedInitialJokerIds) this._placedInitialJokerIds = new Set();
      this._placedInitialJokerIds.add(pc.card.id);
    }
    this.game = GameCore.moveCardInHand(this.game, this.humanPlayerId, fromPosition, toPosition);
  },

  /** 当前活跃玩家 */
  getCurrentPlayer() {
    if (!this.game) return null;
    return this.game.players[this.game.currentPlayerIndex];
  },

  /** 当前是人类吗 */
  isHumanTurn() {
    const player = this.getCurrentPlayer();
    if (!player) return false;
    if (this.mode === 'local') {
      return true; // 本地多人总是人类
    }
    return !player.isAI;
  },

  /** 获取当前人类玩家ID */
  getCurrentHumanId() {
    if (this.mode === 'local') {
      return this.game.players[this.game.currentPlayerIndex].id;
    }
    return this.humanPlayerId;
  },

  /**
   * 开始游戏流程
   */
  async startGameFlow() {
    if (!this.game) return;

    // 如果第一个玩家是AI，触发AI链
    if (!this.isHumanTurn()) {
      await this._runAITurns();
    } else {
      // 人类回合：显示摸牌UI，让玩家手动摸牌
      if (this.onPhaseChange) this.onPhaseChange('your_turn');
    }
  },

  /**
   * 摸牌
   */
  doDrawCard() {
    try {
      this.game = GameCore.drawCard(this.game);

      if (this.onStateChange) this.onStateChange(this.game);

      // 向玩家展示摸到的牌
      if (this.game.drawnCard) {
        const c = this.game.drawnCard;
        const cardStr = `${c.color === 'black' ? '⚫黑色' : '⚪白色'}${c.number === 'joker' ? '鬼牌' : c.number}`;
        if (this.onToast) this.onToast(`🃏 你摸到了：${cardStr}`, 'success');
      } else {
        if (this.onToast) this.onToast('牌堆已空，直接进入猜测阶段', 'info');
      }

      // 检查是否摸到鬼牌
      if (this.game.phase === GameCore.PHASES.GUESS) {
        if (this.game.drawnCard && this.game.drawnCard.number === 'joker') {
          // 需要放置鬼牌
          this.game.phase = GameCore.PHASES.JOKER_PLACE;
          if (this.onPhaseChange) this.onPhaseChange('joker_place');
        } else {
          if (this.onPhaseChange) this.onPhaseChange('guess');
        }
      }
    } catch (e) {
      if (this.onToast) this.onToast(e.message, 'error');
    }
  },

  /**
   * 放置鬼牌
   */
  doPlaceJoker(position) {
    try {
      this.game = GameCore.placeJoker(this.game, position);

      if (this.onStateChange) this.onStateChange(this.game);
      if (this.onPhaseChange) this.onPhaseChange('guess');
    } catch (e) {
      if (this.onToast) this.onToast('⚠️ ' + e.message + '，请重新选择位置', 'error');
      // 放置失败，重新显示鬼牌放置对话框让玩家重试
      if (this.onPhaseChange) this.onPhaseChange('joker_place');
    }
  },

  /**
   * 猜测对手牌
   */
  async doGuess(targetPlayerId, position, color, number) {
    try {
      // 保存猜测者信息（makeGuess后currentPlayerIndex可能变化）
      const guesserBefore = this.getCurrentPlayer();
      const guesserId = guesserBefore ? guesserBefore.id : null;
      const isHumanGuesser = guesserBefore && !guesserBefore.isAI;

      // 标准规则：猜错时自动公开摸到的牌（牌堆空时才自选）
      const result = GameCore.makeGuess(this.game, targetPlayerId, position, color, number,
        { autoRevealOnWrong: true });
      this.game = result.game;

      // 更新AI推理
      this._updateAIAfterGuess(targetPlayerId, position, result);

      if (this.onStateChange) this.onStateChange(this.game);
      if (this.onGuessResult) this.onGuessResult(result);

      // 🔑 如果是人类玩家猜的，暂停等待玩家确认弹窗后再继续
      if (isHumanGuesser && this.game.status !== GameCore.GAME_STATUS.FINISHED) {
        const guessInfo = {
          guesserName: guesserBefore.name,
          targetName: (this.game.players.find(p => p.id === targetPlayerId) || {}).name || '?',
          position,
          color,
          number,
          correct: result.correct,
          revealedCard: result.revealedCard || null,
          targetEliminated: result.targetEliminated || false,
        };
        await this._waitForPlayerGuessConfirm(guessInfo);
      }

      if (this.game.status === GameCore.GAME_STATUS.FINISHED) {
        if (this.onGameOver) this.onGameOver(this.game);
        return;
      }

      if (result.correct) {
        // 猜对：保持在GUESS阶段，等待玩家决定继续还是停止
        if (this.onPhaseChange) this.onPhaseChange('continue_or_stop');
      } else {
        // 猜错处理
        if (this.game.phase === GameCore.PHASES.REVEAL_OWN) {
          // 牌堆为空，需要自选公开一张牌
          if (this.onToast) this.onToast('❌ 猜错了！牌堆已空，请选择公开自己的一张牌', 'error');
          if (this.onPhaseChange) this.onPhaseChange('reveal_own');
        } else {
          // 标准规则：摸到的牌已自动公开并插入手牌
          // 用保存的guesserId找到猜测者（而非currentPlayerIndex，因为已经切换）
          const guesser = this.game.players.find(p => p.id === guesserId);
          if (guesser && this.onToast) {
            const revealedCards = guesser.hand.filter(pc => pc.isRevealed);
            if (revealedCards.length > 0) {
              const card = revealedCards[revealedCards.length - 1].card;
              if (card) {
                const cardStr = `${card.color === 'black' ? '⚫黑色' : '⚪白色'}${card.number === 'joker' ? '鬼牌' : card.number}`;
                this.onToast(`❌ 猜错了！你摸到的 ${cardStr} 已公开并按顺序插入手牌`, 'warning');
              }
            }
          }
          // 进入下一回合
          this._afterTurnEnd();
        }
      }
    } catch (e) {
      if (this.onToast) this.onToast(e.message, 'error');
    }
  },

  /**
   * 猜对后停止
   */
  doStop() {
    try {
      this.game = GameCore.stopAfterCorrect(this.game);
      if (this.onStateChange) this.onStateChange(this.game);
      this._afterTurnEnd();
    } catch (e) {
      if (this.onToast) this.onToast(e.message, 'error');
    }
  },

  /**
   * 牌堆空时猜错，公开自己一张牌
   */
  doRevealOwnCard(position) {
    try {
      this.game = GameCore.revealOwnCard(this.game, position);
      if (this.onStateChange) this.onStateChange(this.game);

      if (this.game.status === GameCore.GAME_STATUS.FINISHED) {
        if (this.onGameOver) this.onGameOver(this.game);
        return;
      }

      this._afterTurnEnd();
    } catch (e) {
      if (this.onToast) this.onToast(e.message, 'error');
    }
  },

  /**
   * 等待玩家确认AI的猜测（暂停AI流程）
   * @param {Object} guessInfo - { guesserName, targetName, position, color, number, correct, revealedCard }
   */
  async _waitForPlayerConfirm(guessInfo) {
    return new Promise(resolve => {
      this._aiPauseResolver = resolve;
      if (this.onAIGuessConfirm) this.onAIGuessConfirm(guessInfo);
    });
  },

  /** 玩家确认AI猜测（继续AI流程） */
  confirmAIGuess() {
    if (this._aiPauseResolver) {
      const resolve = this._aiPauseResolver;
      this._aiPauseResolver = null;
      resolve();
    }
  },

  /** 等待玩家确认自己的猜测结果 */
  async _waitForPlayerGuessConfirm(guessInfo) {
    return new Promise(resolve => {
      this._playerConfirmResolver = resolve;
      if (this.onPlayerGuessConfirm) this.onPlayerGuessConfirm(guessInfo);
    });
  },

  /** 玩家确认自己猜测的结果（继续游戏流程） */
  confirmPlayerGuess() {
    if (this._playerConfirmResolver) {
      const resolve = this._playerConfirmResolver;
      this._playerConfirmResolver = null;
      resolve();
    }
  },

  _aiRunning: false,

  /**
   * 回合结束后处理 — 推进到下一位玩家
   */
  async _afterTurnEnd() {
    // 安全检查
    if (!this.game || this.game.status === GameCore.GAME_STATUS.FINISHED) {
      if (this.game && this.onGameOver) this.onGameOver(this.game);
      return;
    }

    // 本地多人：需要切换屏幕
    if (this.mode === 'local') {
      if (this.onPhaseChange) this.onPhaseChange('switch_player');
      return;
    }

    // AI模式：连续运行AI回合直到轮到人类
    if (!this.isHumanTurn()) {
      await this._runAITurns();
    } else {
      // 人类回合
      if (this.onPhaseChange) this.onPhaseChange('your_turn');
    }
  },

  /**
   * 连续运行AI回合，直到轮到人类或游戏结束
   */
  async _runAITurns() {
    // 防止重叠调用
    if (this._aiRunning) return;
    this._aiRunning = true;

    try {
      while (!this.isHumanTurn() && this.game && this.game.status === GameCore.GAME_STATUS.PLAYING) {
        await this._doSingleAITurn();
        // 检查游戏是否结束
        if (!this.game || this.game.status === GameCore.GAME_STATUS.FINISHED) {
          if (this.game && this.onGameOver) this.onGameOver(this.game);
          return;
        }
      }

      // AI回合结束，轮到人类
      if (this.game && this.game.status === GameCore.GAME_STATUS.PLAYING && this.isHumanTurn()) {
        if (this.onPhaseChange) this.onPhaseChange('your_turn');
      }
    } finally {
      this._aiRunning = false;
    }
  },

  /**
   * 本地多人：确认切换玩家后继续
   */
  continueLocalGame() {
    if (this.game.status === GameCore.GAME_STATUS.FINISHED) return;

    if (!this.isHumanTurn()) {
      return;
    }

    // 显示摸牌UI，等待玩家操作
    if (this.onPhaseChange) this.onPhaseChange('your_turn');
  },

  /**
   * 执行单个AI回合（由 _runAITurns 循环调用）
   */
  async _doSingleAITurn() {
    const player = this.getCurrentPlayer();
    if (!player || !player.isAI) return;

    // ⚠️ 安全检查：如果不在DRAW阶段，说明上一轮异常退出
    if (this.game.phase !== GameCore.PHASES.DRAW) {
      console.warn('AI回合异常：当前阶段为 ' + this.game.phase + '，强制跳过');
      // 强制结束回合
      if (this.game.phase === GameCore.PHASES.GUESS && this.game.drawnCard) {
        this.game = GameCore.stopAfterCorrect(this.game);
      } else {
        // 无法正常推进，手动切换到下一玩家
        GameCore.advanceToNextPlayer(this.game);
      }
      if (this.onStateChange) this.onStateChange(this.game);
      return;
    }

    if (this.onAITurn) this.onAITurn(player);

    const difficulty = player.aiDifficulty || 1;
    const dedState = this.dedStates[player.id];

    // 更新推理
    DeductionEngine.applyConstraints(dedState, this.game);

    // 思考延迟
    const thinkingTime = AIPlayer.getThinkingTime(difficulty);
    await sleep(thinkingTime);

    if (this.game.status === GameCore.GAME_STATUS.FINISHED) return;

    try {
      this.game = GameCore.drawCard(this.game);
      if (this.onStateChange) this.onStateChange(this.game);

      // 向玩家展示AI摸到的牌
      if (this.game.drawnCard && this.onToast) {
        this.onToast(`${player.name} 摸了一张牌`, 'info');
      }

      // 如果摸到鬼牌
      if (this.game.drawnCard && this.game.drawnCard.number === 'joker') {
        // 设置JOKER_PLACE阶段（与人类流程一致，placeJoker要求此阶段）
        this.game.phase = GameCore.PHASES.JOKER_PLACE;
        // 传入全部手牌（含已公开牌），确保鬼牌位置相对于完整手牌计算
        const handCards = player.hand.map(pc => pc.card).filter(Boolean);
        const knownCards = GameCore.getAllKnownCards(this.game, player.id);
        const pos = AIPlayer.getJokerPosition(difficulty, handCards, knownCards);
        try {
          this.game = GameCore.placeJoker(this.game, pos);
        } catch (jokerErr) {
          // 鬼牌放置失败：兜底放到末尾（总是合法的），继续猜测阶段
          console.warn('AI鬼牌放置失败，兜底到末尾:', jokerErr.message);
          this.game = GameCore.placeJoker(this.game, this.game.players[this.game.currentPlayerIndex].hand.length);
        }
        if (this.onStateChange) this.onStateChange(this.game);
      }

      // AI猜测循环
      let keepGuessing = true;
      while (keepGuessing && this.game.phase === GameCore.PHASES.GUESS) {
        await sleep(300 + Math.random() * 400);

        const guess = AIPlayer.getGuess(difficulty, this.game, dedState, player.id);
        if (!guess) break;

        const result = GameCore.makeGuess(
          this.game, guess.playerId, guess.position, guess.color, guess.number
        );
        this.game = result.game;

        // 更新其他AI推理
        this._updateAIAfterGuess(guess.playerId, guess.position, result);

        if (this.onStateChange) this.onStateChange(this.game);
        if (this.onGuessResult) this.onGuessResult(result);

        // 构建AI猜测信息给玩家确认
        const targetPlayer = this.game.players.find(p => p.id === guess.playerId);
        const guessInfo = {
          guesserName: player.name,
          targetName: targetPlayer ? targetPlayer.name : '?',
          position: guess.position,
          color: guess.color,
          number: guess.number,
          correct: result.correct,
          revealedCard: result.revealedCard || null,
          targetEliminated: result.targetEliminated || false,
        };
        // 暂停等待玩家确认
        await this._waitForPlayerConfirm(guessInfo);

        if (this.game.status === GameCore.GAME_STATUS.FINISHED) {
          // onGameOver 由 _runAITurns 统一调用，避免重复
          return;
        }

        if (result.correct) {
          keepGuessing = AIPlayer.shouldContinue(difficulty, this.game, dedState, player.id);
          if (!keepGuessing) {
            this.game = GameCore.stopAfterCorrect(this.game);
            if (this.onStateChange) this.onStateChange(this.game);
          }
        } else {
          keepGuessing = false;
        }
      }

      // ⚠️ 如果循环结束后仍在GUESS阶段（没有通过猜错或停止退出），强制停止
      if (this.game.phase === GameCore.PHASES.GUESS) {
        this.game = GameCore.stopAfterCorrect(this.game);
        if (this.onStateChange) this.onStateChange(this.game);
      }

      // ⚠️ AI猜错且牌堆为空：需要公开自己一张牌（REVEAL_OWN阶段）
      if (this.game.phase === GameCore.PHASES.REVEAL_OWN) {
        const aiPlayer = this.game.players.find(p => p.id === player.id);
        if (aiPlayer) {
          const hiddenCards = aiPlayer.hand.filter(pc => !pc.isRevealed);
          if (hiddenCards.length > 0) {
            // 随机公开一张未公开的牌
            const toReveal = hiddenCards[Math.floor(Math.random() * hiddenCards.length)];
            this.game = GameCore.revealOwnCard(this.game, toReveal.position);
            if (this.onStateChange) this.onStateChange(this.game);
            if (this.onToast) {
              const c = toReveal.card;
              const cardStr = `${c.color === 'black' ? '⚫黑色' : '⚪白色'}${c.number === 'joker' ? '鬼牌' : c.number}`;
              this.onToast(`${player.name} 猜错且牌堆已空，公开了 ${cardStr}`, 'warning');
            }
          }
        }
      }
    } catch (e) {
      console.error('AI error:', e);
      // ⚠️ 异常时也要确保回合推进，不丢失摸到的牌
      try {
        if (this.game) {
          if (this.game.phase === GameCore.PHASES.JOKER_PLACE && this.game.drawnCard) {
            // 鬼牌放置失败：兜底放到末尾（总是合法的）
            this.game = GameCore.placeJoker(this.game, this.game.players[this.game.currentPlayerIndex].hand.length);
          } else if (this.game.phase === GameCore.PHASES.GUESS && this.game.drawnCard) {
            this.game = GameCore.stopAfterCorrect(this.game);
          } else if (this.game.phase === GameCore.PHASES.GUESS) {
            GameCore.advanceToNextPlayer(this.game);
          } else if (this.game.phase === GameCore.PHASES.REVEAL_OWN) {
            // 随机公开AI一张牌
            const aiP = this.game.players[this.game.currentPlayerIndex];
            if (aiP) {
              const hidden = aiP.hand.filter(pc => !pc.isRevealed);
              if (hidden.length > 0) {
                this.game = GameCore.revealOwnCard(this.game, hidden[0].position);
              } else {
                GameCore.advanceToNextPlayer(this.game);
              }
            }
          }
        }
        if (this.onStateChange) this.onStateChange(this.game);
      } catch (e2) {
        console.error('AI recovery failed:', e2);
      }
    }
  },

  /** @deprecated 使用 _doSingleAITurn，保留用于向后兼容 */
  async doAITurn() {
    return this._doSingleAITurn();
  },

  /** 更新AI推理状态 */
  _updateAIAfterGuess(targetPlayerId, position, result) {
    const actualCard = result.revealedCard;
    const guessed = result.correct;

    for (const pid in this.dedStates) {
      if (pid === targetPlayerId) continue; // 目标玩家不更新（他们已经知道自己的牌）
      if (actualCard) {
        DeductionEngine.onCardRevealed(this.dedStates[pid], targetPlayerId, position, actualCard);
      }
      if (!guessed && result.game && result.game.history) {
        const last = result.game.history[result.game.history.length - 1];
        if (last && last.data && last.data.guessed) {
          DeductionEngine.onGuessWrong(
            this.dedStates[pid], targetPlayerId, position,
            last.data.guessed
          );
        }
      }
    }
  },

  /** 获取对玩家可见的状态 */
  getVisibleState(playerId) {
    return GameCore.getVisibleState(this.game, playerId || this.humanPlayerId);
  },
};

/** 辅助：Promise sleep */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = GameManager;
}
if (typeof window !== 'undefined') {
  window.GameManager = GameManager;
}
