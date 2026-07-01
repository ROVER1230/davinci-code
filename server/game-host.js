/**
 * 服务端游戏主机 —— 使用 game-core 运行权威游戏逻辑
 */
const GameCore = require('../client/js/core/game-core.js');

class GameHost {
  constructor(roomManager) {
    this.roomManager = roomManager;
    /** @type {Map<string, NodeJS.Timeout>} 每个房间的回合超时计时器 */
    this.turnTimers = new Map();
  }

  /**
   * 开始游戏
   * @returns {{ success: boolean, error?: string }}
   */
  startGame(room) {
    if (room.status !== 'waiting') return { success: false, error: '游戏状态不正确' };
    if (room.players.length < 2) return { success: false, error: '至少需要2名玩家' };
    if (room.players.some(p => !p.connected)) {
      return { success: false, error: '有玩家已离线，请等待重连' };
    }

    // 用 game-core 创建游戏
    const playerNames = room.players.map(p => p.name);
    try {
      const game = GameCore.createGame({
        mode: 'online',
        playerCount: room.players.length,
        playerNames,
        enableJoker: room.settings.enableJoker,
      });

      // 将 playerId 映射到 game.players[i].id
      room.players.forEach((player, i) => {
        game.players[i].id = player.id;
        game.players[i].userId = player.id;
        game.players[i].connected = true;
      });

      room.game = game;
      room.status = 'playing';

      // 洗牌后随机决定先手
      game.currentPlayerIndex = Math.floor(Math.random() * room.players.length);

      // 向每个玩家发送各自的可见状态
      this._broadcastGameState(room);

      // 发送游戏开始事件
      const firstPlayer = game.players[game.currentPlayerIndex];
      this._addEvent(room, 'game_start', {
        firstPlayerName: firstPlayer.name,
        firstPlayerId: firstPlayer.id,
        cardsPerPlayer: game.settings.cardsPerPlayer,
      });

      // 如果先手玩家有初始鬼牌需要放置，自动跳过（在线模式初始鬼牌随机放置）
      this._handleInitialJokers(room);

      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * 处理初始鬼牌（在线模式自动随机放置）
   */
  _handleInitialJokers(room) {
    const game = room.game;
    const firstPlayer = game.players[game.currentPlayerIndex];
    // 检查先手玩家手牌中是否有鬼牌
    const jokerPositions = [];
    firstPlayer.hand.forEach((pc, idx) => {
      if (pc.card && pc.card.number === 'joker') jokerPositions.push(idx);
    });
    // 在线模式下，初始鬼牌已在 hand 中（由 createGame → dealCards → validateHandWithJokers 处理）
    // 这里检查是否还有未解决的鬼牌位置问题，如有则自动排到合法位置
    // 实际上 game-core 的 createGame 已经通过 validateHandWithJokers 放置好了
    // 直接开始正常游戏流程即可
    this._startTurn(room);
  }

  /**
   * 处理游戏操作
   */
  handleGameAction(room, playerId, action) {
    if (!room.game || room.status !== 'playing') {
      return { success: false, error: '游戏未在进行中' };
    }

    const game = room.game;
    const player = game.players[game.currentPlayerIndex];

    // 验证：是否该玩家的回合
    if (player.id !== playerId) {
      return { success: false, error: '不是你的回合' };
    }

    // 清除超时计时器
    this._clearTurnTimer(room.code);

    try {
      let newGame;
      const actionType = action.type;

      switch (actionType) {
        case 'draw':
          if (game.phase !== 'draw' && game.phase !== 'your_turn') {
            return { success: false, error: '当前不能摸牌，阶段：' + game.phase };
          }
          newGame = GameCore.drawCard(game);
          this._addEvent(room, 'draw', {
            playerId,
            playerName: player.name,
            deckRemaining: newGame.deck.length,
          });

          // 如果摸到鬼牌，自动帮AI玩家随机放置，人类玩家需要客户端发 place_joker
          if (newGame.phase === 'joker_place' && newGame.drawnCard && newGame.drawnCard.number === 'joker') {
            // 等待客户端发 place_joker
            room.game = newGame;
            this._broadcastGameState(room, playerId, {
              type: 'info',
              message: `${player.name} 摸到了鬼牌，正在选择放置位置...`,
            });
            return { success: true };
          }
          break;

        case 'place_joker':
          if (game.phase !== 'joker_place') {
            return { success: false, error: '当前不需要放置鬼牌' };
          }
          newGame = GameCore.placeJoker(game, action.position);
          this._addEvent(room, 'joker_place', {
            playerId,
            playerName: player.name,
            position: action.position,
          });
          break;

        case 'guess':
          if (game.phase !== 'guess') {
            return { success: false, error: '当前不能猜测，阶段：' + game.phase };
          }
          // makeGuess 返回 { game, correct, revealedCard, targetEliminated }
          const guessResult = GameCore.makeGuess(game, action.targetPlayerId, action.position, action.color, action.number, {
            skipNightmareCheck: false,
          });
          newGame = guessResult.game;
          const correct = guessResult.correct;
          const targetEliminated = guessResult.targetEliminated || false;
          const revealedCard = guessResult.revealedCard || null;

          // 查找目标玩家
          const targetPlayer = newGame.players.find(p => p.id === action.targetPlayerId);
          const guessed = { color: action.color, number: action.number };

          this._addEvent(room, 'guess_result', {
            guesserId: playerId,
            guesserName: player.name,
            targetId: action.targetPlayerId,
            targetName: targetPlayer ? targetPlayer.name : '?',
            position: action.position,
            guessed,
            correct,
            revealedCard,
            targetEliminated,
          });

          // 更新游戏状态
          room.game = newGame;

          // 猜对且目标未淘汰 → 让玩家选择继续或停止
          if (correct && !targetEliminated) {
            this._broadcastGameState(room);
            return { success: true };
          }

          // 猜错或目标已淘汰 → 回合自动结束
          if (!correct) {
            this._addEvent(room, 'reveal_own_event', {
              playerId,
              playerName: player.name,
              revealedCard,
            });
          }
          // 推进回合
          this._afterAction(room);
          return { success: true };

        case 'stop':
          if (game.phase !== 'guess' || !game.drawnCard) {
            return { success: false, error: '当前不能停止' };
          }
          newGame = GameCore.stopAfterCorrect(game);
          this._addEvent(room, 'stop', {
            playerId,
            playerName: player.name,
            insertedCard: game.drawnCard,
          });
          room.game = newGame;
          this._afterAction(room);
          return { success: true };

        case 'reveal_own':
          if (game.phase !== 'reveal_own') {
            return { success: false, error: '当前不需要公开牌' };
          }
          newGame = GameCore.revealOwnCard(game, action.position);
          this._addEvent(room, 'reveal_own', {
            playerId,
            playerName: player.name,
            position: action.position,
          });
          room.game = newGame;
          this._afterAction(room);
          return { success: true };

        default:
          return { success: false, error: '未知操作：' + actionType };
      }

      // 非 guess/stop/reveal_own 的简单操作（draw, place_joker）
      room.game = newGame;
      this._afterAction(room);

      return { success: true };
    } catch (e) {
      console.error('游戏操作错误:', e.message);
      return { success: false, error: e.message };
    }
  }

  /**
   * 开始当前玩家的回合
   */
  _startTurn(room) {
    const game = room.game;
    if (!game || game.status === 'finished') return;

    const player = game.players[game.currentPlayerIndex];
    const playerSlot = room.players.find(p => p.id === player.id);

    // 检查当前玩家是否在线
    if (playerSlot && !playerSlot.connected) {
      // 检查是否所有玩家都离线 → 暂停游戏，避免无限递归
      const anyConnected = room.players.some(p => p.connected);
      if (!anyConnected) {
        console.log(`[游戏] 房间 ${room.code} 所有玩家离线，暂停等待重连`);
        this._clearTurnTimer(room.code);
        return;
      }

      // 玩家离线，自动跳过回合
      this._addEvent(room, 'turn_skipped', {
        playerId: player.id,
        playerName: player.name,
        reason: 'disconnected',
      });
      this._advanceToNextPlayer(room);
      return;
    }

    // 设置回合超时
    const timeLimit = (room.settings.turnTimeLimit || 60) * 1000;
    this.turnTimers.set(room.code, setTimeout(() => {
      this._handleTurnTimeout(room);
    }, timeLimit + 5000)); // 额外5秒缓冲

    // 广播回合开始
    this.roomManager.broadcastToRoom(room, {
      type: 'turn_start',
      playerId: player.id,
      playerName: player.name,
      phase: game.phase,
      turnNumber: game.turnNumber,
    });
  }

  /**
   * 回合超时：自动跳过
   */
  _handleTurnTimeout(room) {
    const game = room.game;
    if (!game || game.status === 'finished') return;

    const player = game.players[game.currentPlayerIndex];
    this._addEvent(room, 'turn_timeout', {
      playerId: player.id,
      playerName: player.name,
    });

    // 如果摸过牌了且有摸到的牌，猜错处理
    if (game.drawnCard && game.phase === 'guess') {
      // 自动揭示摸到的牌
      room.game = GameCore.revealDrawnCardAndInsert(game, player.id);
    } else if (game.phase === 'continue_or_stop') {
      // 自动停止
      room.game = GameCore.stopAfterCorrect(game);
    } else {
      // 直接推进
      GameCore.advanceToNextPlayer(game);
    }

    this._broadcastGameState(room);
    this._startTurn(room);
  }

  /**
   * 推进到下一位在线玩家
   */
  _advanceToNextPlayer(room) {
    const game = room.game;
    GameCore.advanceToNextPlayer(game);

    // 检查游戏是否结束
    if (game.status === 'finished') {
      room.status = 'finished';
      this._broadcastGameOver(room);
      return;
    }

    this._broadcastGameState(room);
    this._startTurn(room);
  }

  /**
   * 操作后的统一处理：检查结束 → 广播 → 推进回合
   */
  _afterAction(room) {
    const game = room.game;
    if (!game) return;

    // 检查游戏是否结束
    if (game.status === 'finished' || GameCore.checkWinner(game)) {
      room.status = 'finished';
      game.status = 'finished';
      const winner = game.players.find(p => p.id === game.winnerId);
      if (!winner) {
        // 如果 checkWinner 还没设置 winnerId
        const alivePlayers = game.players.filter(p => !p.isEliminated);
        if (alivePlayers.length === 1) {
          game.winnerId = alivePlayers[0].id;
        }
      }
      const w = game.players.find(p => p.id === game.winnerId);
      this._addEvent(room, 'game_over', {
        winnerId: game.winnerId,
        winnerName: w ? w.name : '?',
      });
      this._broadcastGameOver(room);
      this._clearTurnTimer(room.code);
      return;
    }

    // 广播新状态
    this._broadcastGameState(room);

    // 推进回合
    this._startTurn(room);
  }

  /**
   * 广播游戏状态（每个玩家收到 getVisibleState 过滤后的版本）
   */
  _broadcastGameState(room, excludePlayerId = null, extra = null) {
    const game = room.game;
    if (!game) return;

    for (const player of room.players) {
      if (!player.connected || !player.ws) continue;
      if (player.id === excludePlayerId) continue;

      // 对每个玩家发送信息隔离后的可见状态
      const visibleState = GameCore.getVisibleState(game, player.id);
      // 当前玩家需要看到自己摸到的牌
      if (player.id === visibleState.players[game.currentPlayerIndex].id
          && game.drawnCard
          && (game.phase === GameCore.PHASES.GUESS || game.phase === GameCore.PHASES.JOKER_PLACE)) {
        visibleState.drawnCard = JSON.parse(JSON.stringify(game.drawnCard));
      }
      const currentPlayer = game.players[game.currentPlayerIndex];

      const msg = {
        type: 'game_state',
        game: visibleState,
        currentPlayerId: currentPlayer ? currentPlayer.id : null,
        currentPlayerName: currentPlayer ? currentPlayer.name : null,
        phase: game.phase,
        isMyTurn: game.status === 'playing' && player.id === (currentPlayer ? currentPlayer.id : null),
        turnNumber: game.turnNumber,
        timerStartedAt: game.turnStartedAt || Date.now(),
        timerLimit: room.settings.turnTimeLimit || 60,
      };

      if (extra) Object.assign(msg, extra);

      try {
        player.ws.send(JSON.stringify(msg));
      } catch (e) {
        player.connected = false;
      }
    }
  }

  /**
   * 广播游戏结束
   */
  _broadcastGameOver(room) {
    const game = room.game;
    const winner = game.players.find(p => p.id === game.winnerId);
    const results = game.players.map(p => ({
      id: p.id,
      name: p.name,
      isWinner: p.id === game.winnerId,
      isEliminated: p.isEliminated,
      hand: p.hand.map(pc => ({
        card: pc.card, // 游戏结束，所有牌公开
        isRevealed: true,
      })),
    }));

    this.roomManager.broadcastToRoom(room, {
      type: 'game_over',
      winnerId: game.winnerId,
      winnerName: winner ? winner.name : '?',
      results,
      turnNumber: game.turnNumber,
    });
  }

  /**
   * 添加公开事件到历史
   */
  _addEvent(room, eventType, data) {
    const event = {
      type: eventType,
      data,
      timestamp: Date.now(),
      turnNumber: room.game ? room.game.turnNumber : 0,
    };
    room.gameEvents.push(event);
    // 只保留最近 100 条
    if (room.gameEvents.length > 100) {
      room.gameEvents.shift();
    }

    // 立即广播公开事件
    this.roomManager.broadcastToRoom(room, {
      type: 'game_event',
      event: eventType,
      data,
    });
  }

  /**
   * 清除回合超时计时器
   */
  _clearTurnTimer(roomCode) {
    const timer = this.turnTimers.get(roomCode);
    if (timer) {
      clearTimeout(timer);
      this.turnTimers.delete(roomCode);
    }
  }

  /**
   * 清理房间相关资源
   */
  cleanup(roomCode) {
    this._clearTurnTimer(roomCode);
  }
}

module.exports = GameHost;
