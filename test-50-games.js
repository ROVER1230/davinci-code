/**
 * 达芬奇密码 - 50局自动化测试
 * 运行: node test-50-games.js
 */

// 加载游戏核心模块（通过 global 桥接，模拟浏览器全局变量行为）
const GameCore = require('./js/core/game-core.js');
global.GameCore = GameCore;
const DeductionEngine = require('./js/ai/deduction-engine.js');
global.DeductionEngine = DeductionEngine;
const AIPlayer = require('./js/ai/ai-player.js');
global.AIPlayer = AIPlayer;

const TOTAL_GAMES = 50;
const MAX_TURNS = 500;

// ===== 统计 =====
const stats = {
  total: 0,
  completed: 0,
  errors: [],
  anomalies: [],
  turnCounts: [],
};

/**
 * 模拟AI玩家的完整回合，返回新游戏状态
 */
function simulateAITurn(game, dedStates) {
  const player = game.players[game.currentPlayerIndex];
  if (!player || !player.isAI || player.isEliminated) {
    return { game, error: 'invalid_player' };
  }

  const difficulty = player.aiDifficulty || 1;
  const dedState = dedStates[player.id];

  DeductionEngine.applyConstraints(dedState, game);

  try {
    // Step 1: 检查阶段
    if (game.phase !== GameCore.PHASES.DRAW) {
      stats.anomalies.push(`第${game.turnNumber}回合 AI-${player.name}: 阶段异常 phase=${game.phase}`);
      if (game.phase === GameCore.PHASES.GUESS && game.drawnCard) {
        game = GameCore.stopAfterCorrect(game);
      } else {
        GameCore.advanceToNextPlayer(game);
      }
      return { game };
    }

    // Step 2: 摸牌
    game = GameCore.drawCard(game);

    // Step 3: 处理鬼牌
    if (game.drawnCard && game.drawnCard.number === 'joker') {
      game.phase = GameCore.PHASES.JOKER_PLACE;
      const handCards = player.hand.map(pc => pc.card).filter(Boolean);
      const knownCards = GameCore.getAllKnownCards(game, player.id);
      const pos = AIPlayer.getJokerPosition(difficulty, handCards, knownCards);
      try {
        game = GameCore.placeJoker(game, pos);
      } catch (jokerErr) {
        // 鬼牌放置失败：兜底放到末尾（总是合法的），然后继续猜测阶段
        stats.errors.push({ turn: game.turnNumber, player: player.name, phase: 'joker_place', error: jokerErr.message });
        game = GameCore.placeJoker(game, game.players[game.currentPlayerIndex].hand.length);
      }
    }

    // Step 4: 猜测循环
    let attempts = 0;
    while (game.phase === GameCore.PHASES.GUESS && game.status === GameCore.GAME_STATUS.PLAYING) {
      attempts++;
      if (attempts > 50) {
        stats.anomalies.push(`第${game.turnNumber}回合 AI-${player.name}: 猜测次数过多(${attempts})`);
        game = GameCore.stopAfterCorrect(game);
        break;
      }

      DeductionEngine.refreshOwnHand(dedState, game, player.id);

      const guess = AIPlayer.getGuess(difficulty, game, dedState, player.id);
      if (!guess) {
        game = GameCore.stopAfterCorrect(game);
        break;
      }

      const result = GameCore.makeGuess(game, guess.playerId, guess.position, guess.color, guess.number);
      game = result.game;

      // 更新推理
      if (result.revealedCard) {
        for (const pid in dedStates) {
          if (pid === guess.playerId) continue;
          DeductionEngine.onCardRevealed(dedStates[pid], guess.playerId, guess.position, result.revealedCard);
        }
      }
      if (!result.correct && game.history) {
        const last = game.history[game.history.length - 1];
        if (last && last.data && last.data.guessed) {
          for (const pid in dedStates) {
            if (pid === guess.playerId) continue;
            DeductionEngine.onGuessWrong(dedStates[pid], guess.playerId, guess.position, last.data.guessed);
          }
        }
      }

      if (game.status === GameCore.GAME_STATUS.FINISHED) break;

      if (result.correct) {
        if (!AIPlayer.shouldContinue(difficulty, game, dedState, player.id)) {
          game = GameCore.stopAfterCorrect(game);
          break;
        }
      } else {
        break;
      }
    }

    // Step 5: 处理REVEAL_OWN
    if (game.phase === GameCore.PHASES.REVEAL_OWN && game.status === GameCore.GAME_STATUS.PLAYING) {
      const aiPlayer = game.players.find(p => p.id === player.id);
      if (aiPlayer) {
        const hidden = aiPlayer.hand.filter(pc => !pc.isRevealed);
        if (hidden.length > 0) {
          game = GameCore.revealOwnCard(game, hidden[Math.floor(Math.random() * hidden.length)].position);
        }
      }
    }

    // Step 6: 兜底——强制退出GUESS阶段
    if (game.phase === GameCore.PHASES.GUESS && game.status === GameCore.GAME_STATUS.PLAYING) {
      game = GameCore.stopAfterCorrect(game);
    }

    return { game };
  } catch (e) {
    stats.errors.push({
      turn: game.turnNumber,
      player: player.name,
      phase: game.phase,
      error: e.message,
    });
    // 尝试恢复
    try {
      if (game.phase === GameCore.PHASES.JOKER_PLACE && game.drawnCard) {
        // 鬼牌放置失败：兜底放到末尾（总是合法的）
        game = GameCore.placeJoker(game, game.players[game.currentPlayerIndex].hand.length);
      } else if (game.phase === GameCore.PHASES.GUESS && game.drawnCard) {
        game = GameCore.stopAfterCorrect(game);
      } else if (game.phase === GameCore.PHASES.REVEAL_OWN) {
        const sp = game.players[game.currentPlayerIndex];
        const hidden = sp.hand.filter(pc => !pc.isRevealed);
        if (hidden.length > 0) {
          game = GameCore.revealOwnCard(game, hidden[0].position);
        } else {
          GameCore.advanceToNextPlayer(game);
        }
      } else {
        GameCore.advanceToNextPlayer(game);
      }
      return { game };
    } catch (e2) {
      stats.errors.push({
        turn: game.turnNumber,
        player: player.name,
        phase: 'recovery',
        error: e2.message,
      });
      return { game, error: 'unrecoverable' };
    }
  }
}

/**
 * 运行一局完整的AI对战
 */
function runOneGame(config) {
  const { playerCount, difficulties, enableJoker, gameIndex } = config;

  const playerNames = [];
  const aiPlayers = [];
  const aiDifficulties = [];

  for (let i = 0; i < playerCount; i++) {
    playerNames.push(`AI${i + 1}`);
    aiPlayers.push(i);
    aiDifficulties.push(difficulties[i] || 1);
  }

  let game;
  try {
    game = GameCore.createGame({ playerCount, playerNames, aiPlayers, aiDifficulties, mode: 'ai', enableJoker });
  } catch (e) {
    stats.errors.push({ gameIndex, phase: 'create', error: e.message });
    return null;
  }

  // 初始化推理状态
  const dedStates = {};
  for (const player of game.players) {
    dedStates[player.id] = DeductionEngine.createState(game, player.id);
  }

  // 游戏循环
  let turnCount = 0;

  while (game.status === GameCore.GAME_STATUS.PLAYING) {
    turnCount++;
    if (turnCount > MAX_TURNS) {
      stats.anomalies.push(`游戏#${gameIndex}: 超过${MAX_TURNS}回合，疑似死循环`);
      return { finished: false, turns: turnCount, reason: 'max_turns' };
    }

    const cp = game.players[game.currentPlayerIndex];
    if (!cp || cp.isEliminated) {
      GameCore.advanceToNextPlayer(game);
      continue;
    }

    const result = simulateAITurn(game, dedStates);
    if (result.error === 'unrecoverable') {
      return { finished: false, turns: turnCount, reason: 'crash' };
    }
    game = result.game;

    // 检查游戏是否应该结束但没结束
    const activePlayers = game.players.filter(p => !p.isEliminated);
    if (activePlayers.length <= 1 && game.status !== GameCore.GAME_STATUS.FINISHED) {
      stats.anomalies.push(`游戏#${gameIndex}: 只剩${activePlayers.length}活跃玩家但未结束`);
      // 手动设置胜者
      if (activePlayers.length === 1) {
        game = GameCore.deepCloneGame(game);
        game.winnerId = activePlayers[0].id;
        game.status = GameCore.GAME_STATUS.FINISHED;
        game.phase = GameCore.PHASES.GAME_OVER;
      }
    }
  }

  // 验证牌数守恒
  let totalCards = 0;
  for (const p of game.players) totalCards += p.hand.length;
  totalCards += game.deck.length;
  const expected = enableJoker ? 26 : 24;
  const cardOK = totalCards === expected;
  if (!cardOK) {
    stats.anomalies.push(`游戏#${gameIndex}: 牌数异常 ${totalCards}(期望${expected})`);
  }

  const winner = game.players.find(p => p.id === game.winnerId);
  return {
    finished: game.status === GameCore.GAME_STATUS.FINISHED,
    turns: turnCount,
    winner: winner ? winner.name : '?',
    cardOK,
    eliminated: game.players.filter(p => p.isEliminated).length,
  };
}

/**
 * 主流程
 */
async function main() {
  console.log('='.repeat(60));
  console.log('达芬奇密码 - 50局自动化测试');
  console.log('='.repeat(60) + '\n');

  const configs = [];
  for (let i = 0; i < TOTAL_GAMES; i++) {
    const playerCount = (i % 3) + 2;
    const enableJoker = i % 5 !== 0;
    const difficulties = [];
    for (let p = 0; p < playerCount; p++) {
      difficulties.push(Math.min(5, Math.floor(i / 10) + (p % 3) + 1));
    }
    configs.push({ playerCount, difficulties, enableJoker, gameIndex: i + 1 });
  }

  const results = [];

  for (const cfg of configs) {
    process.stdout.write(`测试 ${cfg.gameIndex}/${TOTAL_GAMES} (${cfg.playerCount}人 鬼牌:${cfg.enableJoker?'是':'否'} 难度:${cfg.difficulties.join(',')}) ... `);
    const r = runOneGame(cfg);
    results.push(r);

    if (r && r.finished) {
      stats.completed++;
      stats.turnCounts.push(r.turns);
      process.stdout.write(`✅ ${r.turns}回合 胜者:${r.winner} 牌数:${r.cardOK?'OK':'异常'}\n`);
    } else if (r) {
      process.stdout.write(`❌ 未完成 (${r.reason})\n`);
    } else {
      process.stdout.write(`💥 崩溃\n`);
    }
  }

  // 报告
  console.log('\n' + '='.repeat(60));
  console.log('统计报告');
  console.log('='.repeat(60));

  console.log(`\n📊 基本统计:`);
  console.log(`   总游戏数:   ${TOTAL_GAMES}`);
  console.log(`   正常完成:   ${stats.completed}`);
  console.log(`   异常:       ${TOTAL_GAMES - stats.completed}`);

  if (stats.turnCounts.length > 0) {
    const sorted = [...stats.turnCounts].sort((a, b) => a - b);
    const avg = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);
    console.log(`\n📈 回合统计:`);
    console.log(`   平均: ${avg}  中位数: ${sorted[Math.floor(sorted.length/2)]}  范围: ${sorted[0]}-${sorted[sorted.length-1]}`);
    console.log(`   <10回合: ${sorted.filter(t=>t<10).length}   >100回合: ${sorted.filter(t=>t>100).length}`);
  }

  console.log(`\n🔍 异常:`);
  if (stats.errors.length === 0 && stats.anomalies.length === 0) {
    console.log(`   ✅ 无异常`);
  } else {
    if (stats.errors.length > 0) {
      console.log(`   ❌ 错误(${stats.errors.length}):`);
      stats.errors.forEach((e, i) => console.log(`      #${i+1} 第${e.turn}回合 ${e.player}: ${e.error}`));
    }
    if (stats.anomalies.length > 0) {
      console.log(`   ⚠️ 可疑(${stats.anomalies.length}):`);
      stats.anomalies.slice(0, 20).forEach(a => console.log(`      - ${a}`));
      if (stats.anomalies.length > 20) console.log(`      ... 还有${stats.anomalies.length - 20}条`);
    }
  }

  console.log(`\n✅ 测试完成。`);
}

main().catch(console.error);
