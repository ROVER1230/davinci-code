/**
 * 联机客户端 —— WebSocket 连接管理、消息收发、断线重连
 */
const OnlineClient = {
  ws: null,
  roomCode: null,
  playerId: null,
  playerName: '',
  connected: false,
  reconnectTimer: null,
  reconnectAttempts: 0,
  maxReconnectAttempts: 10,
  baseReconnectDelay: 1500,
  _heartbeatTimer: null,
  _pendingReconnect: false,

  // 回调函数（由 OnlineManager 注册）
  onConnected: null,
  onRoomCreated: null,
  onRoomJoined: null,
  onRoomUpdate: null,
  onRoomLeft: null,
  onGameState: null,
  onGameEvent: null,
  onGameOver: null,
  onReconnected: null,
  onError: null,
  onDisconnected: null,
  onTurnStart: null,

  /**
   * 连接到服务器
   */
  connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}`;

    try {
      this.ws = new WebSocket(url);
    } catch (e) {
      if (this.onError) this.onError('无法创建连接');
      return;
    }

    this.ws.onopen = () => {
      console.log('[OnlineClient] 已连接');
      this.connected = true;
      this.reconnectAttempts = 0;

      // 🔑 启动客户端心跳：每20秒发 ping 防止路由器断开空闲连接
      this._startHeartbeat();

      if (this.onConnected) this.onConnected();
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this._routeMessage(msg);
      } catch (e) {
        console.error('[OnlineClient] 消息解析错误:', e);
      }
    };

    this.ws.onclose = (event) => {
      console.log('[OnlineClient] 连接关闭:', event.code, event.reason);
      this.connected = false;
      this._stopHeartbeat();
      this._tryReconnect();
    };

    this.ws.onerror = (e) => {
      console.error('[OnlineClient] WebSocket 错误');
    };
  },

  /**
   * 🔑 客户端心跳：每20秒发 ping，防止 NAT/路由器因空闲断开 WebSocket
   */
  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.send({ type: 'ping' });
      }
    }, 20000);
  },

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  },

  /**
   * 发送消息
   */
  send(msg) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[OnlineClient] 未连接，无法发送');
      return false;
    }
    this.ws.send(JSON.stringify(msg));
    return true;
  },

  /**
   * 创建房间
   */
  createRoom(name, playerCount, enableJoker) {
    this.playerName = name;
    this.send({
      type: 'create_room',
      name,
      playerCount,
      enableJoker,
    });
  },

  /**
   * 加入房间
   */
  joinRoom(roomCode, name) {
    this.playerName = name;
    this.send({
      type: 'join_room',
      roomCode: roomCode.toUpperCase().trim(),
      name,
    });
  },

  /**
   * 开始游戏（仅房主）
   */
  startGame() {
    this.send({ type: 'start_game' });
  },

  /**
   * 发送游戏操作
   */
  sendAction(action) {
    this.send({ type: 'game_action', action });
  },

  /**
   * 退出房间
   */
  leaveRoom() {
    this.send({ type: 'leave_room' });
    this.roomCode = null;
    this.playerId = null;
    this.reconnectAttempts = this.maxReconnectAttempts; // 手动退出不再重连
  },

  /**
   * 断开连接
   */
  disconnect() {
    this._stopHeartbeat();
    this.reconnectAttempts = this.maxReconnectAttempts;
    this._pendingReconnect = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  },

  // ============ 内部方法 ============

  /**
   * 消息路由
   */
  _routeMessage(msg) {
    switch (msg.type) {
      case 'connected':
        break;

      case 'room_created':
        this.roomCode = msg.roomCode;
        this.playerId = msg.playerId;
        if (this.onRoomCreated) this.onRoomCreated(msg);
        break;

      case 'room_joined':
        this.roomCode = msg.roomCode;
        this.playerId = msg.playerId;
        if (this.onRoomJoined) this.onRoomJoined(msg);
        break;

      case 'room_update':
        if (this.onRoomUpdate) this.onRoomUpdate(msg);
        break;

      case 'room_left':
        this.roomCode = null;
        this.playerId = null;
        if (this.onRoomLeft) this.onRoomLeft();
        break;

      case 'turn_start':
        if (this.onTurnStart) this.onTurnStart(msg);
        break;

      case 'game_state':
        if (this.onGameState) this.onGameState(msg);
        break;

      case 'game_event':
        if (this.onGameEvent) this.onGameEvent(msg);
        break;

      case 'game_over':
        if (this.onGameOver) this.onGameOver(msg);
        break;

      case 'reconnected':
        this.roomCode = msg.roomCode;
        this.playerId = msg.playerId;
        console.log('[OnlineClient] 重连成功');
        if (this.onReconnected) this.onReconnected(msg);
        break;

      case 'error':
        console.error('[OnlineClient] 服务器错误:', msg.message);
        if (this.onError) this.onError(msg.message);
        break;

      case 'pong':
        break;

      default:
        console.log('[OnlineClient] 未知消息:', msg.type);
    }
  },

  /**
   * 断线重连
   */
  _tryReconnect() {
    if (this.onDisconnected) this.onDisconnected();

    // 不清除 roomCode 和 playerId，用于重连
    if (!this.roomCode || !this.playerId) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('[OnlineClient] 达到最大重连次数，停止重连');
      if (this.onError) this.onError('连接已断开，请刷新页面重新加入');
      return;
    }
    if (this._pendingReconnect) return; // 防止重复重连
    this._pendingReconnect = true;

    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts),
      30000
    );

    console.log(`[OnlineClient] ${delay/1000}s 后尝试重连 (${this.reconnectAttempts + 1}/${this.maxReconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this._pendingReconnect = false;
      this.reconnectAttempts++;
      // 重连后自动发送 reconnect 消息
      const origOnConnected = this.onConnected;
      this.onConnected = () => {
        // 先发送重连请求
        this.send({
          type: 'reconnect',
          roomCode: this.roomCode,
          playerId: this.playerId,
        });
        // 恢复原回调（但不要再次被覆盖）
        this.onConnected = origOnConnected;
        // 再调用原回调
        if (origOnConnected) origOnConnected();
      };
      this.connect();
    }, delay);
  },
};
