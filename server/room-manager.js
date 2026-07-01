/**
 * 房间管理器 —— 创建/加入/离开房间
 */

// 生成6位房间码（大写字母+数字，易读）
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉容易混淆的 0/O/1/I
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// 房间存活时间（游戏结束后多久自动清理）
const ROOM_CLEANUP_DELAY = 10 * 60 * 1000; // 10分钟

class RoomManager {
  constructor() {
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
  }

  /**
   * 创建房间
   * @param {object} ws - 房主的 WebSocket
   * @param {string} name - 房主昵称
   * @param {object} settings - { playerCount, enableJoker }
   * @returns {{ roomCode: string, room: Room }}
   */
  createRoom(ws, name, settings = {}) {
    const roomCode = this._generateUniqueCode();
    const playerId = this._genId('p');

    const room = {
      code: roomCode,
      hostId: playerId,
      status: 'waiting', // 'waiting' | 'playing' | 'finished'
      settings: {
        playerCount: settings.playerCount || 3,
        enableJoker: settings.enableJoker !== false,
        turnTimeLimit: 60,
      },
      players: [],
      game: null,       // 游戏开始后赋值
      gameEvents: [],   // 最近的事件历史（用于重连追赶）
      createdAt: Date.now(),
    };

    // 房主作为第一个玩家
    room.players.push({
      id: playerId,
      ws: ws,
      name: name.substring(0, 10),
      seatIndex: 0,
      connected: true,
      isHost: true,
    });

    this.rooms.set(roomCode, room);
    return { roomCode, playerId };
  }

  /**
   * 加入房间
   * @returns {{ success: boolean, playerId?: string, error?: string }}
   */
  joinRoom(ws, roomCode, name) {
    const room = this.rooms.get(roomCode.toUpperCase());
    if (!room) return { success: false, error: '房间不存在，请检查房间码' };
    if (room.status !== 'waiting') return { success: false, error: '游戏已开始，无法加入' };
    if (room.players.length >= room.settings.playerCount) {
      return { success: false, error: '房间已满' };
    }

    // 检查是否已在房间中（重连）
    const existing = room.players.find(p => !p.connected && p.name === name);
    if (existing) {
      existing.ws = ws;
      existing.connected = true;
      return { success: true, playerId: existing.id, reconnected: true };
    }

    const playerId = this._genId('p');
    room.players.push({
      id: playerId,
      ws: ws,
      name: name.substring(0, 10),
      seatIndex: room.players.length,
      connected: true,
      isHost: false,
    });

    return { success: true, playerId };
  }

  /**
   * 玩家离开房间（主动退出）
   */
  leaveRoom(playerId) {
    const room = this._findRoomByPlayer(playerId);
    if (!room) return null;

    if (room.status === 'playing') {
      // 游戏中离开：标记掉线
      const player = room.players.find(p => p.id === playerId);
      if (player) player.connected = false;
    } else {
      // 等待中离开：直接移除
      room.players = room.players.filter(p => p.id !== playerId);
      if (room.players.length === 0) {
        this.rooms.delete(room.code);
        return null;
      }
      // 如果房主离开，转移房主
      if (room.hostId === playerId && room.players.length > 0) {
        room.hostId = room.players[0].id;
        room.players[0].isHost = true;
      }
    }

    return room;
  }

  /**
   * 处理断线（保留位置，给予重连窗口）
   * @returns {{ room: Room, player: object } | null}
   */
  handleDisconnect(wsId) {
    for (const room of this.rooms.values()) {
      const player = room.players.find(p => p.ws === wsId || p.id === wsId);
      if (player) {
        // 不立即移除ws引用，让后续重连可以找到
        player.connected = false;
        player.disconnectedAt = Date.now();
        return { room, player };
      }
    }
    return null;
  }

  /**
   * 重连
   * @param {object} ws - 新的 WebSocket 连接
   * @param {string} roomCode - 房间码
   * @param {string} playerId - 玩家ID
   */
  reconnect(ws, roomCode, playerId) {
    const room = this.rooms.get(roomCode.toUpperCase());
    if (!room) return { success: false, error: '房间已关闭' };

    const player = room.players.find(p => p.id === playerId);
    if (!player) return { success: false, error: '玩家不在房间中' };

    // 更新连接
    player.ws = ws;
    player.connected = true;
    delete player.disconnectedAt;

    return {
      success: true,
      room,
      player,
      isPlaying: room.status === 'playing',
      events: room.gameEvents.slice(-20), // 最近20条事件
    };
  }

  /**
   * 获取房间
   */
  getRoom(roomCode) {
    return this.rooms.get(roomCode.toUpperCase());
  }

  /**
   * 根据玩家ID查找房间
   */
  _findRoomByPlayer(playerId) {
    for (const room of this.rooms.values()) {
      if (room.players.some(p => p.id === playerId)) return room;
    }
    return null;
  }

  /**
   * 广播消息给房间内所有在线玩家
   */
  broadcastToRoom(room, message, excludePlayerId = null) {
    const msg = typeof message === 'string' ? message : JSON.stringify(message);
    for (const player of room.players) {
      if (player.connected && player.ws && player.id !== excludePlayerId) {
        try {
          player.ws.send(msg);
        } catch (e) {
          // 发送失败，标记为断线
          player.connected = false;
          player.disconnectedAt = Date.now();
        }
      }
    }
  }

  /**
   * 发送消息给单个玩家
   */
  sendToPlayer(player, message) {
    if (!player.connected || !player.ws) return false;
    try {
      player.ws.send(typeof message === 'string' ? message : JSON.stringify(message));
      return true;
    } catch (e) {
      player.connected = false;
      return false;
    }
  }

  /**
   * 获取房间的公开玩家列表（供大厅展示）
   */
  getRoomPlayers(room) {
    return room.players.map(p => ({
      id: p.id,
      name: p.name,
      seatIndex: p.seatIndex,
      connected: p.connected,
      isHost: p.isHost,
    }));
  }

  /**
   * 清理过期房间
   */
  cleanupExpired() {
    const now = Date.now();
    for (const [code, room] of this.rooms.entries()) {
      if (room.status === 'finished' && now - room.createdAt > ROOM_CLEANUP_DELAY) {
        this.rooms.delete(code);
      }
      // 等待中的房间超过30分钟也清理
      if (room.status === 'waiting' && now - room.createdAt > 30 * 60 * 1000) {
        this.rooms.delete(code);
      }
    }
  }

  _generateUniqueCode() {
    let code;
    do {
      code = generateRoomCode();
    } while (this.rooms.has(code));
    return code;
  }

  _genId(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
  }
}

module.exports = RoomManager;
