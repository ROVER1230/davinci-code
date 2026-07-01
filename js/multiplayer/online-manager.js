/**
 * 在线游戏管理器 —— 客户端侧流程管理
 * 接收服务端推送的 game_state，驱动 GameRenderer 渲染
 * 当轮到本地玩家时显示操作 UI
 */
const OnlineManager = {
  localGame: null,       // 缓存的最新游戏状态（getVisibleState 过滤后）
  playerId: null,
  isLocalTurn: false,
  currentPhase: null,
  _turnTimer: null,
  _turnTimeLeft: 0,
  _timerInterval: null,
  _gameEnded: false,
  _justGuessedCorrect: false, // 刚猜对，显示继续/停止

  /**
   * 初始化（连接 WebSocket 时调用）
   */
  init() {
    this._registerCallbacks();
  },

  /**
   * 注册 OnlineClient 回调
   */
  _registerCallbacks() {
    const OC = OnlineClient;

    OC.onRoomCreated = (msg) => {
      this._showRoomLobby(msg);
    };

    OC.onRoomJoined = (msg) => {
      if (msg.reconnected) {
        // 重连进入游戏
        return;
      }
      this._showRoomLobby(msg);
    };

    OC.onRoomUpdate = (msg) => {
      this._updateRoomLobby(msg);
    };

    OC.onRoomLeft = () => {
      this._cleanup();
      showHome();
      showToast('已退出房间', 'info');
    };

    OC.onTurnStart = (msg) => {
      this._onTurnStart(msg);
    };

    OC.onGameState = (msg) => {
      this._onGameState(msg);
    };

    OC.onGameEvent = (msg) => {
      this._onGameEvent(msg);
    };

    OC.onGameOver = (msg) => {
      this._onGameOver(msg);
    };

    OC.onReconnected = (msg) => {
      this._onReconnected(msg);
    };

    OC.onError = (msg) => {
      showToast(msg, 'error');
    };

    OC.onDisconnected = () => {
      showToast('连接中断，正在重连...', 'warning');
    };
  },

  // ============ 房间大厅 ============

  _showRoomLobby(msg) {
    this.playerId = msg.playerId;
    hideAllScreens();
    const screen = document.getElementById('screen-room-lobby');
    if (screen) screen.classList.remove('hidden');
    this._updateRoomLobby(msg);
  },

  _updateRoomLobby(msg) {
    const roomCodeEl = document.getElementById('lobby-room-code');
    const playersEl = document.getElementById('lobby-players');
    const startBtn = document.getElementById('btn-start-game-online');
    const countEl = document.getElementById('lobby-player-count');

    if (roomCodeEl) roomCodeEl.textContent = OnlineClient.roomCode || msg.roomCode || '';
    if (countEl && msg.players) {
      countEl.textContent = `${msg.players.length}`;
    }

    if (playersEl && msg.players) {
      const totalSlots = Math.max(msg.players.length, 2);
      playersEl.innerHTML = msg.players.map(p => {
        const statusIcon = p.connected ? '🟢' : '🔴';
        const isMe = p.id === this.playerId;
        return `
          <div class="lobby-player">
            <span>${statusIcon}</span>
            <span class="lobby-player-name">${p.name}${isMe ? ' (你)' : ''}</span>
            ${p.isHost ? '<span class="opponent-badge" style="background:rgba(200,168,78,0.2);color:var(--gold)">房主</span>' : ''}
            ${!p.connected ? '<span class="opponent-badge eliminated">离线</span>' : ''}
          </div>`;
      }).join('');
    }

    // 开始按钮：仅房主可见
    if (startBtn) {
      const isHost = msg.players && msg.players.some(p => p.id === this.playerId && p.isHost);
      const allConnected = msg.players && msg.players.every(p => p.connected);
      const enoughPlayers = msg.players && msg.players.length >= 2;
      startBtn.style.display = isHost ? '' : 'none';
      startBtn.disabled = !allConnected || !enoughPlayers;
    }
  },

  // ============ 游戏流程 ============

  /**
   * 服务端推送游戏状态
   */
  _onGameState(msg) {
    this.localGame = msg.game;
    this.isLocalTurn = msg.isMyTurn;
    this.currentPhase = msg.phase;
    this._gameEnded = false;

    // 隐藏大厅，显示游戏画面
    const gameScreen = document.getElementById('screen-game');
    if (gameScreen && gameScreen.classList.contains('hidden')) {
      hideAllScreens();
      gameScreen.classList.remove('hidden');
      // 关闭猜牌面板
      hideGuessPanel();
    }

    // 用 GameRenderer 渲染
    if (typeof GameRenderer !== 'undefined') {
      GameRenderer._onlinePlayerId = this.playerId;
      GameRenderer._onlineGame = this.localGame;
      GameRenderer.render(this.localGame);
    }

    // 更新回合横幅
    this._updateTurnBanner(msg);

    // 开始回合计时
    this._startTurnTimer(msg.timerLimit, msg.timerStartedAt);

    // 根据阶段显示操作 UI
    this._handlePhaseUI(msg);
  },

  /**
   * 更新回合横幅
   */
  _updateTurnBanner(msg) {
    const banner = document.getElementById('turn-banner');
    if (!banner) return;

    banner.classList.remove('my-turn', 'waiting');

    if (msg.isMyTurn) {
      banner.classList.add('my-turn');
      banner.querySelector('.banner-text').textContent = '🎯 轮到你了！';
      banner.querySelector('.banner-sub').textContent = '请做出你的选择';
    } else {
      banner.classList.add('waiting');
      banner.querySelector('.banner-text').textContent = '⏳ 等待中...';
      banner.querySelector('.banner-sub').textContent =
        `${msg.currentPlayerName || '其他玩家'} 正在思考`;
    }
  },

  /**
   * 开始回合倒计时
   */
  _startTurnTimer(limit, startedAt) {
    this._clearTurnTimer();
    this._turnTimeLeft = limit || 60;

    const timerEl = document.getElementById('online-timer');
    if (timerEl) timerEl.style.display = this.isLocalTurn ? '' : 'none';

    this._timerInterval = setInterval(() => {
      this._turnTimeLeft--;
      if (timerEl) {
        timerEl.textContent = `${this._turnTimeLeft}s`;
        timerEl.classList.toggle('warning', this._turnTimeLeft <= 15);
        timerEl.classList.toggle('danger', this._turnTimeLeft <= 5);
      }
      if (this._turnTimeLeft <= 0) {
        this._clearTurnTimer();
      }
    }, 1000);
  },

  _clearTurnTimer() {
    if (this._timerInterval) {
      clearInterval(this._timerInterval);
      this._timerInterval = null;
    }
  },

  /**
   * 根据阶段显示/隐藏操作 UI
   */
  _handlePhaseUI(msg) {
    const gameActions = document.getElementById('game-actions-area');
    const guessPanel = document.getElementById('guess-panel');

    if (!msg.isMyTurn) {
      // 不是我的回合，隐藏所有操作
      if (gameActions) gameActions.innerHTML = '';
      if (guessPanel) guessPanel.classList.add('hidden');
      updateOpponentCardClickability(false);
      return;
    }

    // 我的回合 — 根据阶段显示操作
    switch (msg.phase) {
      case 'draw':
        if (gameActions) {
          gameActions.innerHTML = `
            <button class="btn btn-primary btn-lg" onclick="OnlineManager.doDraw()"
                    style="animation:pulse 1.5s ease infinite;">🃏 摸牌</button>`;
        }
        hideGuessPanel();
        break;

      case 'joker_place':
        if (gameActions) gameActions.innerHTML = '';
        showJokerPlacementDialogOnline();
        break;

      case 'guess':
        if (this._justGuessedCorrect) {
          // 刚猜对 → 显示继续/停止对话框
          hideGuessPanel();
          if (gameActions) gameActions.innerHTML = '';
          showContinueOrStopOnline();
          this._justGuessedCorrect = false;
        } else {
          if (gameActions) {
            gameActions.innerHTML = `
              <button class="btn btn-primary btn-sm" onclick="showGuessPanelOnline()">🎯 猜牌面板</button>`;
          }
          showGuessPanelOnline();
        }
        break;

      case 'reveal_own':
        if (gameActions) gameActions.innerHTML = '';
        showRevealOwnDialogOnline();
        break;

      default:
        if (gameActions) gameActions.innerHTML = '';
        hideGuessPanel();
    }
  },

  /**
   * 回合开始
   */
  _onTurnStart(msg) {
    // 更新状态
    this.isLocalTurn = msg.playerId === this.playerId;
    this.currentPhase = msg.phase;
  },

  /**
   * 游戏事件
   */
  _onGameEvent(msg) {
    const { event, data } = msg;
    switch (event) {
      case 'guess_result':
        this._showGuessResult(data);
        break;
      case 'player_disconnected':
        showToast(`${data.playerName} 连接中断`, 'warning');
        break;
      case 'turn_timeout':
        showToast(`${data.playerName} 操作超时，自动跳过`, 'warning');
        break;
      case 'turn_skipped':
        showToast(`${data.playerName} 离线，回合跳过`, 'warning');
        break;
      case 'game_start':
        showToast(`游戏开始！${data.firstPlayerName} 先手`, 'info');
        break;
    }
  },

  /**
   * 显示猜测结果（通过 toast）
   */
  _showGuessResult(data) {
    const g = data.guessed;
    if (!g) return;
    const guessStr = `${g.color === 'black' ? '⚫黑色' : '⚪白色'}${g.number === 'joker' ? '鬼牌' : g.number}`;

    if (data.correct) {
      showToast(`${data.guesserName} ✅ 猜对了 ${data.targetName} 的 ${guessStr}！`, 'success');
      if (data.targetEliminated) {
        showToast(`💀 ${data.targetName} 出局！`, 'warning');
      }
      // 如果是自己猜对了且目标未被淘汰，标记需要显示继续/停止
      if (data.guesserId === this.playerId && !data.targetEliminated) {
        this._justGuessedCorrect = true;
      }
    } else {
      showToast(`${data.guesserName} ❌ 猜错了！`, 'warning');
      if (data.revealedCard) {
        const rc = data.revealedCard;
        showToast(`🃏 ${data.guesserName} 公开了 ${rc.color === 'black' ? '⚫黑' : '⚪白'}${rc.number === 'joker' ? '鬼' : rc.number}`, 'info');
      }
    }
  },

  /**
   * 游戏结束
   */
  _onGameOver(msg) {
    this._gameEnded = true;
    this._clearTurnTimer();
    hideGuessPanel();

    const isWin = msg.winnerId === this.playerId;
    const resultsHtml = (msg.results || []).map(r => {
      const isMe = r.id === this.playerId;
      return `
        <div class="result-stat">
          <div class="stat-label">${r.name}${isMe ? ' (你)' : ''}</div>
          <div class="stat-value" style="font-size:1.2rem;">
            ${r.isWinner ? '🏆 获胜' : (r.isEliminated ? '💀 出局' : '✅ 存活')}
          </div>
        </div>`;
    }).join('');

    showModal(`
      <div class="result-container" style="padding:var(--space-lg);">
        <div class="winner-icon">${isWin ? '🏆' : '🎭'}</div>
        <h2 style="font-size:1.5rem;">${isWin ? '恭喜你赢了！' : `${msg.winnerName} 获胜`}</h2>
        <div class="result-stats" style="grid-template-columns:repeat(${Math.min(msg.results.length, 4)},1fr);">
          ${resultsHtml}
        </div>
        <div style="margin-top:var(--space-md);color:var(--text-muted);font-size:0.85rem;">
          共 ${msg.turnNumber} 回合
        </div>
        <div class="modal-actions">
          <button class="btn btn-primary" onclick="OnlineManager.leaveAndGoHome()">返回首页</button>
        </div>
      </div>`);
  },

  /**
   * 重连成功
   */
  _onReconnected(msg) {
    this.playerId = msg.playerId;
    showToast('已重新连接！', 'success');

    if (msg.status === 'playing') {
      // 游戏进行中，等 game_state 推送
    } else {
      this._showRoomLobby(msg);
    }
  },

  // ============ 操作函数 ============

  doDraw() {
    OnlineClient.sendAction({ type: 'draw' });
  },

  doGuess(targetPlayerId, position, color, number) {
    OnlineClient.sendAction({
      type: 'guess',
      targetPlayerId,
      position,
      color,
      number,
    });
    hideGuessPanel();
  },

  doStop() {
    OnlineClient.sendAction({ type: 'stop' });
  },

  doContinueGuess() {
    // 继续猜：隐藏弹窗，重新显示猜牌面板
    closeModal(true);
    showGuessPanelOnline();
  },

  doPlaceJoker(position) {
    closeModal(true);
    OnlineClient.sendAction({ type: 'place_joker', position });
  },

  doRevealOwn(position) {
    closeModal(true);
    OnlineClient.sendAction({ type: 'reveal_own', position });
  },

  leaveAndGoHome() {
    closeModal(true);
    OnlineClient.leaveRoom();
    this._cleanup();
    showHome();
  },

  _cleanup() {
    this._clearTurnTimer();
    this.localGame = null;
    this.isLocalTurn = false;
    this._gameEnded = false;
  },
};

// ============ 在线模式 UI 适配函数 ============

let onlineGuessTarget = { playerId: null, position: null, color: null, number: null };

/**
 * 在线模式下显示猜牌面板（重配置按钮事件）
 */
function showGuessPanelOnline() {
  const panel = document.getElementById('guess-panel');
  if (!panel) return;
  panel.classList.remove('hidden');

  // 重定向按钮事件到在线版本
  const colorBlackBtn = document.getElementById('pick-color-black');
  const colorWhiteBtn = document.getElementById('pick-color-white');
  const submitBtn = document.getElementById('btn-submit-guess');
  const resetBtn = panel.querySelector('.btn-secondary');

  if (colorBlackBtn) colorBlackBtn.setAttribute('onclick', "pickGuessColorOnline('black')");
  if (colorWhiteBtn) colorWhiteBtn.setAttribute('onclick', "pickGuessColorOnline('white')");
  if (submitBtn) submitBtn.setAttribute('onclick', 'submitGuessOnline()');
  if (resetBtn) resetBtn.setAttribute('onclick', 'resetGuessSelectionOnline()');

  updateGuessPanelOnlineState();
  updateOpponentCardClickability(true);
}

function hideGuessPanel() {
  const panel = document.getElementById('guess-panel');
  if (panel) panel.classList.add('hidden');
  updateOpponentCardClickability(false);
}

function updateGuessPanelOnlineState() {
  const targetEl = document.getElementById('guess-panel-target');
  if (targetEl) {
    if (onlineGuessTarget.playerId && onlineGuessTarget.position !== null) {
      const game = OnlineManager.localGame;
      const tp = game ? game.players.find(p => p.id === onlineGuessTarget.playerId) : null;
      targetEl.textContent = `目标: ${tp ? tp.name : '?'} 位置${onlineGuessTarget.position + 1}`;
    } else {
      targetEl.textContent = '👆 请点击上方对手的牌选择目标';
    }
  }

  // 颜色按钮
  document.querySelectorAll('.color-pick-btn').forEach(b => b.classList.remove('selected'));
  if (onlineGuessTarget.color) {
    const btn = document.getElementById('pick-color-' + onlineGuessTarget.color);
    if (btn) btn.classList.add('selected');
  }

  // 数字网格
  renderGuessNumberGridOnline();

  // 确认按钮
  const submitBtn = document.getElementById('btn-submit-guess');
  if (submitBtn) {
    submitBtn.disabled = !(onlineGuessTarget.playerId && onlineGuessTarget.position !== null
      && onlineGuessTarget.color && onlineGuessTarget.number !== null);
  }
}

function renderGuessNumberGridOnline() {
  const container = document.getElementById('guess-panel-numbers');
  if (!container) return;

  let html = '';
  for (let i = 0; i <= 11; i++) {
    const sel = onlineGuessTarget.number === i ? ' selected' : '';
    html += `<button class="num-pick-btn${sel}" onclick="pickGuessNumberOnline(${i})">${i}</button>`;
  }
  html += `<button class="num-pick-btn joker-pick${onlineGuessTarget.number === 'joker' ? ' selected' : ''}"
                onclick="pickGuessNumberOnline('joker')">— 鬼牌</button>`;
  container.innerHTML = html;
}

function pickGuessColorOnline(color) {
  onlineGuessTarget.color = color;
  onlineGuessTarget.number = null;
  updateGuessPanelOnlineState();
}

function pickGuessNumberOnline(number) {
  onlineGuessTarget.number = number;
  updateGuessPanelOnlineState();
}

function onOpponentCardClickOnline(playerId, position) {
  const panel = document.getElementById('guess-panel');
  if (!panel || panel.classList.contains('hidden')) return;
  const game = OnlineManager.localGame;
  if (!game || game.phase !== 'guess') return;

  const targetPlayer = game.players.find(p => p.id === playerId);
  if (!targetPlayer) return;
  const pc = targetPlayer.hand.find(c => c.position === position);
  if (!pc || pc.isRevealed) return;

  onlineGuessTarget.playerId = playerId;
  onlineGuessTarget.position = position;
  onlineGuessTarget.color = null;
  onlineGuessTarget.number = null;
  updateGuessPanelOnlineState();
}

function resetGuessSelectionOnline() {
  onlineGuessTarget = { playerId: null, position: null, color: null, number: null };
  updateGuessPanelOnlineState();
}

function submitGuessOnline() {
  if (!onlineGuessTarget.playerId || onlineGuessTarget.position === null
      || !onlineGuessTarget.color || onlineGuessTarget.number === null) return;
  hideGuessPanel();
  OnlineManager.doGuess(
    onlineGuessTarget.playerId,
    onlineGuessTarget.position,
    onlineGuessTarget.color,
    onlineGuessTarget.number
  );
  onlineGuessTarget = { playerId: null, position: null, color: null, number: null };
}

function showJokerPlacementDialogOnline() {
  const game = OnlineManager.localGame;
  const me = game ? game.players.find(p => p.id === OnlineManager.playerId) : null;
  if (!me) return;

  showToast('🃏 你摸到了鬼牌！请选择放置位置', 'warning');

  function renderCard(pc) {
    const c = pc.card;
    if (!c) return '<div style="width:44px;height:66px;"></div>';
    const isJoker = c.number === 'joker';
    const num = isJoker ? '—' : c.number;
    const style = (c.color === 'black')
      ? 'background:linear-gradient(135deg,#2a2a2a,#111);color:#ddd;border:2px solid ' + (isJoker ? '#7a6a9e' : '#555') + ';'
      : 'background:linear-gradient(135deg,#f8f4e8,#e8e0c8);color:#2a2010;border:2px solid ' + (isJoker ? '#b8a0c8' : '#c0b898') + ';';
    return `<div style="width:44px;height:66px;display:flex;flex-direction:column;align-items:center;justify-content:center;
      border-radius:4px;font-weight:700;font-size:0.85rem;${style}">
      <span style="font-size:1.1rem;">${num}</span><span style="font-size:0.6rem;">${c.color === 'black' ? '⚫' : '⚪'}</span></div>`;
  }

  let slotsHtml = `<div class="joker-slot" onclick="OnlineManager.doPlaceJoker(0)">⬅<br><small>最左</small></div>`;
  const handCards = me.hand;
  for (let i = 0; i < handCards.length; i++) {
    if (i > 0) {
      slotsHtml += `<div class="joker-slot between" onclick="OnlineManager.doPlaceJoker(${i})">↓</div>`;
    }
    slotsHtml += renderCard(handCards[i]);
  }
  slotsHtml += `<div class="joker-slot" onclick="OnlineManager.doPlaceJoker(${handCards.length})">➡<br><small>最右</small></div>`;

  showModal(`
    <h2>🃏 放置鬼牌</h2>
    <p style="color:var(--text-secondary);text-align:center;margin-bottom:var(--space-sm);">
      你摸到了鬼牌！点击 <span style="color:var(--gold);">箭头/缝隙</span> 来放置
    </p>
    <div class="joker-slots">${slotsHtml}</div>
    <p style="text-align:center;color:var(--text-muted);font-size:0.75rem;margin-top:var(--space-xs);">
      鬼牌可放在任意位置，放置后不能移动
    </p>`, false);
}

function showContinueOrStopOnline() {
  showModal(`
    <h2>✅ 猜对了！</h2>
    <p style="text-align:center;color:var(--text-secondary);margin:var(--space-md) 0;">
      你可以继续猜测，或者停止并隐藏你的牌
    </p>
    <div class="modal-actions">
      <button class="btn btn-secondary btn-lg" onclick="closeModal(true);OnlineManager.doStop();">
        🛑 停止<br><small style="font-size:0.7rem">隐藏摸到的牌</small>
      </button>
      <button class="btn btn-primary btn-lg" onclick="closeModal(true);OnlineManager.doContinueGuess();">
        🔍 继续猜<br><small style="font-size:0.7rem">继续攻击</small>
      </button>
    </div>`, false);
}

function showRevealOwnDialogOnline() {
  const game = OnlineManager.localGame;
  const me = game ? game.players.find(p => p.id === OnlineManager.playerId) : null;
  if (!me) return;

  const hiddenCards = me.hand.filter(pc => !pc.isRevealed);
  let cardsHtml = hiddenCards.map(pc => `
    <div class="target-player" onclick="OnlineManager.doRevealOwn(${pc.position})" style="cursor:pointer;">
      <span>位置 ${pc.position + 1}</span>
      <span style="color:var(--gold);font-weight:600;">
        ${pc.card ? (pc.card.number === 'joker' ? '— 鬼牌' : pc.card.number) : '?'}
        ${pc.card ? (pc.card.color === 'black' ? '⚫' : '⚪') : ''}
      </span>
    </div>
  `).join('');

  showModal(`
    <h2>😔 猜错了！</h2>
    <p style="color:var(--text-secondary);text-align:center;">
      请选择公开自己的一张未公开牌
    </p>
    <div class="target-selector" style="margin-top:var(--space-md);">${cardsHtml}</div>`, false);
}
