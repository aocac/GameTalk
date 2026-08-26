import { describe, expect, it } from 'vitest';
import { TEST_WS_URL } from './global-setup';
import { ChatSocket } from '../src/app/ws';
import type { ServerWsMessage } from '../src/app/types';

function nextMsg(socket: ChatSocket, predicate?: (m: ServerWsMessage) => boolean): Promise<ServerWsMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for ws message')), 5000);
    const off = socket.onMessage((msg) => {
      if (!predicate || predicate(msg)) {
        clearTimeout(timer);
        off();
        resolve(msg);
      }
    });
  });
}

describe('ChatSocket integration (against real server)', () => {
  it('connects, hello, joins room, sends and receives messages', async () => {
    const a = new ChatSocket();
    const b = new ChatSocket();

    const aOpened = new Promise<void>((resolve) => a.onStatus((s) => s === 'open' && resolve()));
    const bOpened = new Promise<void>((resolve) => b.onStatus((s) => s === 'open' && resolve()));
    a.connect(TEST_WS_URL);
    b.connect(TEST_WS_URL);
    await Promise.all([aOpened, bOpened]);

    const helloA = nextMsg(a, (m) => m.type === 'hello:ok');
    const helloB = nextMsg(b, (m) => m.type === 'hello:ok');
    a.send({ type: 'hello', payload: { name: 'ClientA' } });
    b.send({ type: 'hello', payload: { name: 'ClientB' } });
    const meA = (await helloA).payload as { me: { id: string; username: string } };
    expect(meA.me.username).toBe('ClientA');
    await helloB;

    // 双方入房：B 入房时 room:joined 应含 A；A 会收到 Bob 的 member:joined
    a.send({ type: 'room:join', payload: { roomId: 'lobby' } });
    await nextMsg(a, (m) => m.type === 'room:joined');
    const aSeesB = nextMsg(a, (m) => m.type === 'member:joined' && m.payload.member.username === 'ClientB');
    b.send({ type: 'room:join', payload: { roomId: 'lobby' } });
    const bJoined = await nextMsg(b, (m) => m.type === 'room:joined');
    const bMembers = bJoined.payload.members as Array<{ username: string }>;
    expect(bMembers.map((x) => x.username)).toContain('ClientA');
    await aSeesB;

    const bGetsMsg = nextMsg(b, (m) => m.type === 'message:new');
    a.send({ type: 'message:send', payload: { roomId: 'lobby', text: 'ping from A' } });
    const got = await bGetsMsg;
    const p = got.payload as { message: { text: string; username: string } };
    expect(p.message.text).toBe('ping from A');
    expect(p.message.username).toBe('ClientA');

    a.close();
    b.close();
  });

  it('reconnects automatically after connection loss', async () => {
    const s = new ChatSocket();
    const statuses: string[] = [];
    s.onStatus((st) => statuses.push(st));

    const opened = new Promise<void>((resolve) => s.onStatus((st) => st === 'open' && resolve()));
    s.connect(TEST_WS_URL);
    await opened;

    // 模拟异常断线：直接关闭底层连接（非用户主动 close）
    const inner = (s as unknown as { ws: WebSocket }).ws;
    inner.close();

    // 应进入 reconnecting 并再次 open（自动重连）
    const deadline = Date.now() + 8000;
    await new Promise<void>((resolve, reject) => {
      const t = setInterval(() => {
        const opens = statuses.filter((x) => x === 'open').length;
        if (opens >= 2) {
          clearInterval(t);
          resolve();
        } else if (Date.now() > deadline) {
          clearInterval(t);
          reject(new Error(`reconnect failed, statuses=${statuses.join(',')}`));
        }
      }, 50);
    });

    expect(statuses).toContain('reconnecting');
    s.close();
  });
});
