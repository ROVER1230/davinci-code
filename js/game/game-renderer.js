/**
 * 达芬奇密码 - 游戏界面渲染器
 * 管理所有DOM更新
 */

const GameRenderer = {
  // 当前人类玩家
  humanPlayerId: null,
  // 是否本地多人模式
  isLocalMode: false,
  // 游戏引用
  game: null,
  // 在线模式：当前玩家的玩家ID
  _onlinePlayerId: null,
  // 在线模式：来自服务端的 getVisibleState 缓存
  _onlineGame: null,

  /** 初始化 */
  init(humanPlayerId, isLocalMode) {
    this.humanPlayerId = humanPlayerId;
    this.isLocalMode = isLocalMode;
  },

  /** 完整渲染游戏状态 */
  render(game) {
    this.game = game;
    this.renderOpponents(game);
    this.renderMyHand(game);
    this.renderDrawnCard(game);
    this.renderGameInfo(game);
    this.renderTurnBanner(game);
    this.renderDrawPile(game);
  },

  /** 渲染对手 */
  renderOpponents(game) {
    const container = document.getElementById('opponents-area');
    if (!container) return;

    const viewerId = this._getViewerId(game);
    const players = game.players.filter(p => p.id !== viewerId);

    container.innerHTML = players.map(p => this._renderOpponentCards(p, game)).join('');
  },

  _renderOpponentCards(player, game) {
    const cards = player.hand.map((pc, idx) => {
      if (pc.isRevealed) {
        const c = pc.card;
        const cls = c.number === 'joker' ? `joker joker-${c.color}` : `color-${c.color}`;
        const colorEmoji = c.color === 'black' ? '⚫' : '⚪';
        const colorLabel = c.color === 'black' ? '黑' : '白';
        return `
          <div class="game-card revealed ${cls}" data-player="${player.id}" data-pos="${pc.position}">
            <div class="card-inner">
              <div class="card-back"></div>
              <div class="card-front">
                <span class="card-number">${c.number === 'joker' ? '—' : c.number}</span>
                <span class="card-symbol"></span>
                <span class="card-color-label">${colorLabel}</span>
              </div>
            </div>
          </div>`;
      } else {
        const c = pc.card;
        const colorCls = c ? `color-${c.color}` : '';
        const colorLabel = c ? (c.color === 'black' ? '黑' : '白') : '';
        const clickFn = game.mode === 'online' ? 'onOpponentCardClickOnline' : 'onOpponentCardClick';
        return `
          <div class="game-card selectable-target ${colorCls}" data-player="${player.id}" data-pos="${pc.position}"
               onclick="${clickFn}('${player.id}', ${pc.position})">
            <div class="card-inner">
              <div class="card-back">
                <span class="card-back-color">${colorLabel}</span>
              </div>
              <div class="card-front"></div>
            </div>
          </div>`;
      }
    }).join('');

    const statusBadge = player.isEliminated
      ? '<span class="opponent-badge eliminated">已出局</span>'
      : (game.players[game.currentPlayerIndex].id === player.id
        ? '<span class="opponent-badge active-turn">当前回合</span>'
        : (player.isAI ? '<span class="opponent-badge ai">AI</span>' : ''));

    return `
      <div class="opponent-section card-panel ${player.isEliminated ? 'eliminated' : ''}">
        <div class="opponent-header">
          <span class="opponent-name">${player.name}</span>
          ${statusBadge}
          <span style="font-size:0.8rem;color:var(--text-muted)">
            ${player.hand.filter(pc => pc.isRevealed).length}/${player.hand.length} 已公开
          </span>
        </div>
        <div class="card-row">
          ${cards}
        </div>
      </div>`;
  },

  /** 渲染自己的手牌 */
  renderMyHand(game) {
    const container = document.getElementById('my-hand');
    if (!container) return;

    const viewerId = this._getViewerId(game);
    const me = game.players.find(p => p.id === viewerId);
    if (!me) return;

    const cards = me.hand.map(pc => {
      const c = pc.card;
      if (!c) return '';

      const cls = c.number === 'joker' ? `joker joker-${c.color}` : `color-${c.color}`;
      const revealedClass = pc.isRevealed ? 'revealed own-revealed' : '';
      const colorLabel = c.color === 'black' ? '黑' : '白';

      return `
        <div class="game-card own-card ${revealedClass} ${cls}" data-pos="${pc.position}" data-own="true">
          <div class="card-inner">
            <div class="card-back"></div>
            <div class="card-front">
              <span class="card-number">${c.number === 'joker' ? '—' : c.number}</span>
              <span class="card-symbol"></span>
              <span class="card-color-label">${colorLabel}</span>
            </div>
          </div>
          ${pc.isRevealed ? '<span class="revealed-badge">已公开</span>' : ''}
        </div>`;
    }).join('');

    container.innerHTML = cards;

    // 更新手牌区域标题
    const label = document.getElementById('my-hand-label');
    if (label) {
      const hiddenCount = me.hand.filter(pc => !pc.isRevealed).length;
      const revealedCount = me.hand.filter(pc => pc.isRevealed).length;
      label.textContent = `我的手牌 (${hiddenCount}张未公开, ${revealedCount}张已公开)`;
    }
  },

  /** 渲染摸到的牌（在手牌区上方展示） */
  renderDrawnCard(game) {
    const container = document.getElementById('drawn-card-area');
    if (!container) return;

    const viewerId = this._getViewerId(game);
    const currentPlayer = game.players[game.currentPlayerIndex];

    // 只有在当前是查看者回合、有摸到的牌、且处于guess或joker_place阶段才显示
    if (currentPlayer && currentPlayer.id === viewerId &&
        game.drawnCard &&
        (game.phase === GameCore.PHASES.GUESS || game.phase === GameCore.PHASES.JOKER_PLACE)) {
      const c = game.drawnCard;
      const cls = c.number === 'joker' ? `joker joker-${c.color}` : `color-${c.color}`;
      const num = c.number === 'joker' ? '—' : c.number;
      const colorEmoji = c.color === 'black' ? '⚫' : '⚪';
      const colorLabel = c.color === 'black' ? '黑' : '白';

      container.innerHTML = `
        <div class="drawn-card-display">
          <span class="drawn-badge">🃏 刚摸到</span>
          <div class="game-card own-card drawn-card-fresh ${cls}">
            <div class="card-inner">
              <div class="card-back"></div>
              <div class="card-front">
                <span class="card-number">${num}</span>
                <span class="card-symbol"></span>
                <span class="card-color-label">${colorLabel}</span>
              </div>
            </div>
          </div>
          <span class="drawn-card-label">${colorEmoji}${c.color === 'black' ? '黑色' : '白色'}${num}</span>
        </div>`;
      container.style.display = 'flex';
    } else {
      container.innerHTML = '';
      container.style.display = 'none';
    }
  },

  /** 渲染游戏信息 */
  renderGameInfo(game) {
    const turnEl = document.getElementById('info-turn');
    const pileEl = document.getElementById('info-deck');
    const modeEl = document.getElementById('info-mode');

    if (turnEl) turnEl.textContent = `第 ${game.turnNumber} 回合`;
    if (pileEl) pileEl.textContent = `${game.deck.length}`;
    if (modeEl) {
      let modeText = game.mode === 'ai' ? 'AI对战' : (game.mode === 'local' ? '本地多人' : '联机对战');
      if (game.mode === 'online' && typeof OnlineClient !== 'undefined' && OnlineClient.roomCode) {
        modeText += ' · ' + OnlineClient.roomCode;
      }
      modeEl.textContent = modeText;
    }
  },

  /** 渲染回合横幅 */
  renderTurnBanner(game) {
    const banner = document.getElementById('turn-banner');
    if (!banner) return;

    const viewerId = this._getViewerId(game);
    const currentPlayer = game.players[game.currentPlayerIndex];

    if (game.status === GameCore.GAME_STATUS.FINISHED) {
      const winner = game.players.find(p => p.id === game.winnerId);
      banner.className = 'turn-banner';
      banner.innerHTML = `
        <div class="banner-text">🏆 ${winner ? winner.name : '?'} 获胜！</div>
        <div class="banner-sub">游戏结束</div>`;
      return;
    }

    if (currentPlayer.id === viewerId) {
      banner.className = 'turn-banner my-turn';
      // 根据阶段给出不同提示
      let phaseText = '';
      switch (game.phase) {
        case 'draw': phaseText = '👆 点击牌堆或下方按钮摸牌'; break;
        case 'guess': phaseText = '🎯 点击对手的牌来猜测'; break;
        case 'joker_place': phaseText = '🃏 选择鬼牌的放置位置'; break;
        case 'reveal_own': phaseText = '😔 猜错了！选择公开自己的一张牌'; break;
        default: phaseText = '轮到你了';
      }
      banner.innerHTML = `
        <div class="banner-text">✨ 轮到你了</div>
        <div class="banner-sub">${phaseText}</div>`;
    } else {
      banner.className = 'turn-banner waiting';
      banner.innerHTML = `
        <div class="banner-text">⏳ ${currentPlayer.name} 正在思考...</div>
        <div class="banner-sub">请稍候</div>`;
    }
  },

  /** 渲染牌堆 */
  renderDrawPile(game) {
    const container = document.getElementById('draw-pile-area');
    if (!container) return;

    const count = game.deck.length;
    const showCards = Math.min(count, 3);

    let pileHtml = '<div class="pile-stack">';
    for (let i = 0; i < showCards; i++) {
      pileHtml += '<div class="pile-card"></div>';
    }
    pileHtml += '</div>';

    // 摸牌阶段牌堆可点击
    const clickable = game.phase === 'draw' && game.status === 'playing' ? ' pile-clickable' : '';

    container.innerHTML = `
      <div class="draw-pile${clickable}" onclick="if(typeof playerDoDraw==='function')playerDoDraw()" title="${game.phase==='draw'?'点击摸牌':''}">
        ${pileHtml}
        <span class="pile-count">剩余 ${count} 张</span>
      </div>`;
  },

  /** 获取当前查看者ID */
  _getViewerId(game) {
    // 在线模式：使用 OnlineManager 的 playerId
    if (game && game.mode === 'online') {
      return this._onlinePlayerId || this.humanPlayerId;
    }
    if (this.isLocalMode) {
      return game.players[game.currentPlayerIndex].id;
    }
    return this.humanPlayerId;
  },

  /** 高亮某张牌 */
  highlightCard(playerId, position) {
    document.querySelectorAll('.game-card').forEach(el => {
      el.classList.remove('card-highlight');
    });
    const el = document.querySelector(`.game-card[data-player="${playerId}"][data-pos="${position}"]`);
    if (el) el.classList.add('card-highlight');
  },

  /** 播放翻牌动画 */
  animateReveal(playerId, position) {
    const el = document.querySelector(`.game-card[data-player="${playerId}"][data-pos="${position}"]`);
    if (el) {
      el.classList.add('card-revealing');
      setTimeout(() => el.classList.remove('card-revealing'), 500);
    }
  },

  /** 播放摸牌动画 */
  animateDraw() {
    const pile = document.querySelector('.pile-stack');
    if (pile) {
      pile.classList.add('card-drawing');
      setTimeout(() => pile.classList.remove('card-drawing'), 400);
    }
  },

  /** 显示/隐藏画布 */
  showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
    const screen = document.getElementById(id);
    if (screen) screen.classList.remove('hidden');
  },

  /** Toast消息 */
  showToast(message, type = 'info') {
    const container = document.querySelector('.toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = GameRenderer;
}
if (typeof window !== 'undefined') {
  window.GameRenderer = GameRenderer;
}
