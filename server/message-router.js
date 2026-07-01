/**
 * 消息路由器 —— 解析客户端消息并分发到对应处理器
 */
const RoomManager = require('./room-manager.js');
const GameHost = require('./game-host.js');
const GameCore = require('../client/js/core/game-core.js');

class MessageRouter {
  constructor() {
    this.roomManager = new RoomManager();
    this.gameHost = new GameHost(this.roomManager);

    // 定期清理过期房间
    setInterval(() => this.roomManager.cleanupExpired(), 5 * 60 * 1000);
  }

  /**
   * 处理 WebSocket 消息
   * @param {object} ws - WebSocket 连接
   * @param {string} rawMsg - 原始消息文本
   */
  handleMessage(ws, rawMsg) {
    let msg;
    try {
      msg = JSON.parse(rawMsg);
    } catch (e) {
      this._send(ws, { type: 'error', message: '消息格式错误' });
      return;
    }

    if (!msg.type) {
      this._send(ws, { type: 'error', message: '缺少 type 字段' });
      return;
    }

    switch (msg.type) {
      case 'create_room':
        this._handleCreateRoom(ws, msg);
        break;
      case 'join_room':
        this._handleJoinRoom(ws, msg);
        break;
      case 'leave_room':
        this._handleLeaveRoom(ws, msg);
        break;
      case 'start_game':
        this._handleStartGame(ws, msg);
        break;
      case 'game_action':
        this._handleGameAction(ws, msg);
        break;
      case 'reconnect':
        this._handleReconnect(ws, msg);
        break;
      case 'ping':
        this._send(ws, { type: 'pong' });
        break;
      default:
        this._send(ws, { type: 'error', message: '未知消息类型：' + msg.type });
    }
  }

  /**
   * 处理 WebSocket 断开
   */
  handleDisconnect(ws) {
    const result = this.roomManager.handleDisconnect(ws);
    if (!result) return;

    const { room, player } = result;
    // 通知房间其他玩家
    this.roomManager.broadcastToRoom(room, {
      type: 'room_update',
      players: this.roomManager.getRoomPlayers(room),
      hostId: room.hostId,
      status: room.status,
    });

    if (room.status === 'playing') {
      this.roomManager.broadcastToRoom(room, {
        type: 'game_event',
        event: 'player_disconnected',
        data: { playerId: player.id, playerName: player.name },
      });
    }
  }

  // ============ 私有处理函数 ============

  _handleCreateRoom(ws, msg) {
    const name = (msg.name || '玩家').substring(0, 10);
    const settings = {
      playerCount: Math.min(4, Math.max(2, msg.playerCount || 3)),
      enableJoker: msg.enableJoker !== false,
    };

    const { roomCode, playerId } = this.roomManager.createRoom(ws, name, settings);
    // 将 playerId 暂存在 ws 对象上
    ws._playerInfo = { roomCode, playerId };

    this._send(ws, {
      type: 'room_created',
      roomCode,
      playerId,
      players: this.roomManager.getRoomPlayers(this.roomManager.getRoom(roomCode)),
      hostId: playerId,
    });

    console.log(`[房间] ${name} 创建了房间 ${roomCode} (${settings.playerCount}人)`);
  }

  _handleJoinRoom(ws, msg) {
    const name = (msg.name || '玩家').substring(0, 10);
    const roomCode = (msg.roomCode || '').toUpperCase().trim();

    if (!roomCode) {
      this._send(ws, { type: 'error', message: '请输入房间码' });
      return;
    }

    const result = this.roomManager.joinRoom(ws, roomCode, name);
    if (!result.success) {
      this._send(ws, { type: 'error', message: result.error });
      return;
    }

    ws._playerInfo = { roomCode, playerId: result.playerId };
    const room = this.roomManager.getRoom(roomCode);

    this._send(ws, {
      type: 'room_joined',
      roomCode,
      playerId: result.playerId,
      players: this.roomManager.getRoomPlayers(room),
      hostId: room.hostId,
      reconnected: result.reconnected || false,
    });

    // 通知房间其他人
    this.roomManager.broadcastToRoom(room, {
      type: 'room_update',
      players: this.roomManager.getRoomPlayers(room),
      hostId: room.hostId,
      status: room.status,
    });

    console.log(`[房间] ${name} 加入了房间 ${roomCode}`);
  }

  _handleLeaveRoom(ws, msg) {
    const playerId = ws._playerInfo?.playerId;
    if (!playerId) return;

    const room = this.roomManager.leaveRoom(playerId);
    if (!room) {
      this._send(ws, { type: 'room_left' });
      return;
    }

    this._send(ws, { type: 'room_left' });
    this.roomManager.broadcastToRoom(room, {
      type: 'room_update',
      players: this.roomManager.getRoomPlayers(room),
      hostId: room.hostId,
      status: room.status,
    });
  }

  _handleStartGame(ws, msg) {
    const info = ws._playerInfo;
    if (!info) {
      this._send(ws, { type: 'error', message: '请先创建或加入房间' });
      return;
    }

    const room = this.roomManager.getRoom(info.roomCode);
    if (!room) {
      this._send(ws, { type: 'error', message: '房间不存在' });
      return;
    }

    if (room.hostId !== info.playerId) {
      this._send(ws, { type: 'error', message: '只有房主可以开始游戏' });
      return;
    }

    const result = this.gameHost.startGame(room);
    if (!result.success) {
      this._send(ws, { type: 'error', message: result.error });
      return;
    }

    console.log(`[游戏] 房间 ${room.code} 游戏开始！`);
  }

  _handleGameAction(ws, msg) {
    const info = ws._playerInfo;
    if (!info || !info.roomCode || !info.playerId) {
      this._send(ws, { type: 'error', message: '未在房间中' });
      return;
    }

    const room = this.roomManager.getRoom(info.roomCode);
    if (!room) {
      this._send(ws, { type: 'error', message: '房间不存在' });
      return;
    }

    if (!msg.action) {
      this._send(ws, { type: 'error', message: '缺少 action 字段' });
      return;
    }

    const result = this.gameHost.handleGameAction(room, info.playerId, msg.action);
    if (!result.success) {
      this._send(ws, { type: 'error', message: result.error });
    }
  }

  _handleReconnect(ws, msg) {
    const roomCode = (msg.roomCode || '').toUpperCase().trim();
    const playerId = msg.playerId;

    if (!roomCode || !playerId) {
      this._send(ws, { type: 'error', message: '重连信息不完整' });
      return;
    }

    const result = this.roomManager.reconnect(ws, roomCode, playerId);
    if (!result.success) {
      this._send(ws, { type: 'error', message: result.error });
      return;
    }

    ws._playerInfo = { roomCode, playerId };

    // 如果在游戏中，发送当前状态
    if (result.isPlaying && result.room.game) {
      const game = result.room.game;
      const visibleState = GameCore.getVisibleState(game, playerId);
      const currentPlayer = game.players[game.currentPlayerIndex];

      this._send(ws, {
        type: 'reconnected',
        roomCode,
        playerId,
        players: this.roomManager.getRoomPlayers(result.room),
        hostId: result.room.hostId,
        status: 'playing',
      });

      this._send(ws, {
        type: 'game_state',
        game: visibleState,
        currentPlayerId: currentPlayer ? currentPlayer.id : null,
        currentPlayerName: currentPlayer ? currentPlayer.name : null,
        phase: game.phase,
        isMyTurn: playerId === (currentPlayer ? currentPlayer.id : null),
        turnNumber: game.turnNumber,
        timerStartedAt: game.turnStartedAt || Date.now(),
        timerLimit: result.room.settings.turnTimeLimit || 60,
      });

      // 发送追赶事件
      if (result.events && result.events.length > 0) {
        for (const event of result.events) {
          this._send(ws, { type: 'game_event', event: event.type, data: event.data });
        }
      }
    } else {
      this._send(ws, {
        type: 'reconnected',
        roomCode,
        playerId,
        players: this.roomManager.getRoomPlayers(result.room),
        hostId: result.room.hostId,
        status: 'waiting',
      });
    }

    // 通知房间其他人
    this.roomManager.broadcastToRoom(result.room, {
      type: 'room_update',
      players: this.roomManager.getRoomPlayers(result.room),
      hostId: result.room.hostId,
      status: result.room.status,
    });

    console.log(`[重连] ${result.player.name} 重连到房间 ${roomCode}`);
  }

  _send(ws, msg) {
    if (ws.readyState === 1) { // WebSocket.OPEN
      try {
        ws.send(JSON.stringify(msg));
      } catch (e) {
        // 忽略发送错误
      }
    }
  }
}

module.exports = MessageRouter;
