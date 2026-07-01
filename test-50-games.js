/**
 * 联机对战 - 50局测试（修复竞态条件 + 正确错误处理）
 */
const WebSocket = require('ws');
require('./client/server.js');

const BUGS = [];
let ok = 0, fail = 0, totalTurns = 0, minT = 1e9, maxT = 0;

// ---- 带竞态保护的连接客户端 ----
function connectClient(name) {
  return new Promise((resolve) => {
    const client = { name, ws: null, pid: null, rid: null, _queue: [], _resolvers: [] };
    client.ws = new WebSocket('ws://localhost:3456');
    client.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        client._queue.push(msg);
        if (client._resolvers.length > 0) {
          client._resolvers.shift()();
        }
      } catch (e) {}
    });
    client.ws.on('open', () => resolve(client));
    client.close = () => { try { client.ws.close(); } catch (_) {} };
    client.send = (o) => client.ws.send(JSON.stringify(o));

    // 等待 game_state 或 game_over，带竞态保护
    client.waitState = (timeout = 30000) => {
      return new Promise((resolve, reject) => {
        let resolved = false;
        let timer;
        const check = () => {
          if (resolved) return true;
          const idx = client._queue.findIndex(m => m.type === 'game_state' || m.type === 'game_over');
          if (idx >= 0) {
            resolved = true;
            clearTimeout(timer);
            resolve(client._queue.splice(idx, 1)[0]);
            return true;
          }
          return false;
        };
        // 首次检查
        if (check()) return;
        timer = setTimeout(() => {
          if (!resolved) { resolved = true; reject(new Error('超时')); }
        }, timeout);
        const resolver = () => {
          if (check()) clearTimeout(timer);
          else client._resolvers.push(resolver);
        };
        client._resolvers.push(resolver);
        // 弥补 check() 和 push() 之间的竞态窗口
        if (check()) clearTimeout(timer);
      });
    };

    // 等待特定类型
    client.waitType = (type, timeout = 10000) => {
      return new Promise((resolve, reject) => {
        let resolved = false;
        let timer;
        const check = () => {
          if (resolved) return true;
          const idx = client._queue.findIndex(m => m.type === type);
          if (idx >= 0) {
            resolved = true;
            clearTimeout(timer);
            resolve(client._queue.splice(idx, 1)[0]);
            return true;
          }
          return false;
        };
        if (check()) return;
        timer = setTimeout(() => {
          if (!resolved) { resolved = true; reject(new Error('超时:' + type)); }
        }, timeout);
        const resolver = () => {
          if (check()) clearTimeout(timer);
          else client._resolvers.push(resolver);
        };
        client._resolvers.push(resolver);
        if (check()) clearTimeout(timer);
      });
    };

    client.clearQ = () => { client._queue = []; };
    return client;
  });
}

async function playOne(n) {
  const a = await connectClient('A');
  const b = await connectClient('B');
  let error = null;
  let turns = 0;
  try {
    // 建立房间
    await a.waitType('connected');
    await b.waitType('connected');

    a.send({ type: 'create_room', name: 'A', playerCount: 2, enableJoker: true });
    const rc = await a.waitType('room_created');
    a.rid = rc.roomCode; a.pid = rc.playerId;

    b.send({ type: 'join_room', roomCode: a.rid, name: 'B' });
    const jd = await b.waitType('room_joined');
    b.pid = jd.playerId; b.rid = jd.roomCode;

    a.clearQ(); b.clearQ();

    // 开始游戏
    a.send({ type: 'start_game' });
    let sA = await a.waitState(20000);
    let sB = await b.waitState(20000);

    while (turns < 500) {
      // 检查游戏是否结束（game_state 中的 status 或 game_over 消息）
      if ((sA.game && sA.game.status === 'finished') ||
          (sB.game && sB.game.status === 'finished')) break;
      if (sA.type === 'game_over' || sB.type === 'game_over') break;

      const currId = sA.currentPlayerId;
      const cur = currId === a.pid ? a : b;
      const sCur = cur === a ? sA : sB;

      if (!sCur.isMyTurn) {
        sA = await a.waitState(30000);
        sB = await b.waitState(30000);
        continue;
      }

      turns++;

      try {
        if (sCur.phase === 'draw') {
          cur.send({ type: 'game_action', action: { type: 'draw' } });
          sA = await a.waitState(30000);
          sB = await b.waitState(30000);
        } else if (sCur.phase === 'joker_place') {
          cur.send({ type: 'game_action', action: { type: 'place_joker', position: 0 } });
          sA = await a.waitState(30000);
          sB = await b.waitState(30000);
        } else if (sCur.phase === 'guess') {
          const opp = sCur.game.players.find(p => p.id !== cur.pid);
          const tgt = opp ? opp.hand.find(pc => !pc.isRevealed) : null;
          if (!tgt) { error = '无猜测目标'; break; }
          cur.send({ type: 'game_action', action: {
            type: 'guess', targetPlayerId: opp.id, position: tgt.position,
            color: Math.random() < 0.5 ? 'black' : 'white',
            number: Math.floor(Math.random() * 12),
          }});
          sA = await a.waitState(30000);
          sB = await b.waitState(30000);
        } else if (sCur.phase === 'reveal_own') {
          const me = sCur.game.players.find(p => p.id === cur.pid);
          const h = me ? me.hand.find(pc => !pc.isRevealed) : null;
          if (!h) { error = '无牌可公开'; break; }
          cur.send({ type: 'game_action', action: { type: 'reveal_own', position: h.position } });
          sA = await a.waitState(30000);
          sB = await b.waitState(30000);
        } else if (sCur.phase === 'continue_or_stop') {
          cur.send({ type: 'game_action', action: { type: 'stop' } });
          sA = await a.waitState(30000);
          sB = await b.waitState(30000);
        } else {
          sA = await a.waitState(30000);
          sB = await b.waitState(30000);
        }
      } catch (e) {
        error = `回${turns}阶${sCur.phase}: ${e.message}`;
        break;
      }
    }

    if (error) { BUGS.push(`局${n}: ${error}`); fail++; }
    else if (turns >= 500) { BUGS.push(`局${n}:>500回`); fail++; }
    else if (turns > 0) { ok++; totalTurns += turns; if (turns < minT) minT = turns; if (turns > maxT) maxT = turns; }
    else { BUGS.push(`局${n}:0回`); fail++; }
  } catch (e) {
    BUGS.push(`局${n}: ${e.message}`);
    fail++;
  } finally {
    a.close(); b.close();
  }
  return !error && turns > 0;
}

(async () => {
  const T = 50, start = Date.now();
  for (let i = 1; i <= T; i++) {
    process.stdout.write(`${String(i).padStart(2)}/${T} `);
    const good = await playOne(i);
    process.stdout.write(good ? '✅\n' : '❌\n');
  }
  const sec = ((Date.now() - start) / 1000).toFixed(0);
  console.log(`\n完成:${ok}/${T} 失败:${fail} | 均:${ok?(totalTurns/ok).toFixed(1):0}回 短:${minT} 长:${maxT} | ${sec}s`);
  if (BUGS.length) {
    const uniq = [...new Set(BUGS)];
    console.log(`错误(${BUGS.length}次/${uniq.length}种):`);
    uniq.slice(0, 30).forEach(e => console.log(' ', e));
  }
  process.exit(fail > 0 ? 1 : 0);
})();
