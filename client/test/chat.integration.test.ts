import { describe, expect, it } from 'vitest';
import { TEST_HTTP_URL, TEST_WS_URL } from './global-setup';
import { ChatSocket } from '../src/app/ws';
import type { ServerWsMessage } from '../src/app/types';

async function register(username: string): Promise<{ token: string; userId: string }> {
  const res = await fetch(`${TEST_HTTP_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'password123' }),
  });
  const body = (await res.json()) as { token: string; user: { id: string } };
  return { token: body.token, userId: body.user.id };
}

async function createRoom(token: string, name: string): Promise<{ id: string; inviteCode: string }> {
  const res = await fetch(`${TEST_HTTP_URL}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name }),
  });
  const body = (await res.json()) as { room: { id: string; inviteCode: string } };
  return body.room;
}

async function joinRoom(token: string, inviteCode: string): Promise<{ id: string }> {
  const res = await fetch(`${TEST_HTTP_URL}/api/rooms/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ inviteCode }),
  });
  const body = (await res.json()) as { room: { id: string } };
  return body.room;
}

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

async function connectAuthed(token: string): Promise<ChatSocket> {
  const s = new ChatSocket();
  const opened = new Promise<void>((resolve) => s.onStatus((st) => st === 'open' && resolve()));
  s.connect(TEST_WS_URL);
  await opened;
  s.send({ type: 'hello', payload: { token } });
  await nextMsg(s, (m) => m.type === 'hello:ok');
  return s;
}

describe('GameTalk room chat (integration)', () => {
  it('two users: create room, join via invite code, chat in realtime, history persisted', async () => {
    const owner = await register('owner_int');
    const member = await register('member_int');
    const room = await createRoom(owner.token, '集成测试小队');

    // member 通过邀请码加入
    const joined = await joinRoom(member.token, room.inviteCode);
    expect(joined.id).toBe(room.id);

    const a = await connectAuthed(owner.token);
    const b = await connectAuthed(member.token);

    // 双方订阅房间
    a.send({ type: 'room:join', payload: { roomId: room.id } });
    await nextMsg(a, (m) => m.type === 'room:joined');
    const aSeesB = nextMsg(a, (m) => m.type === 'member:joined');
    b.send({ type: 'room:join', payload: { roomId: room.id } });
    await nextMsg(b, (m) => m.type === 'room:joined');
    const seen = await aSeesB;
    expect((seen.payload as { member: { username: string } }).member.username).toBe('member_int');

    // 实时收发
    const bGets = nextMsg(b, (m) => m.type === 'message:new');
    a.send({ type: 'message:send', payload: { roomId: room.id, text: '今晚开黑？' } });
    const got = await bGets;
    expect((got.payload as { message: { text: string; username: string } }).message.text).toBe('今晚开黑？');

    // 历史持久化（REST 拉取应含该消息）
    const hist = await fetch(`${TEST_HTTP_URL}/api/rooms/${room.id}/messages`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    const { messages } = (await hist.json()) as { messages: Array<{ text: string }> };
    expect(messages.map((m) => m.text)).toContain('今晚开黑？');

    a.close();
    b.close();
  });

  it('friends dm over client socket: both sides receive dm:new, history via REST', async () => {
    const a = await register('dm_cli_a');
    const b = await register('dm_cli_b');
    // 互加为好友（反向申请 = 直接成为好友）
    for (const [from, to] of [[a, b], [b, a]] as const) {
      await fetch(`${TEST_HTTP_URL}/api/friends/requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${from.token}` },
        body: JSON.stringify({ userId: to.userId }),
      });
    }

    const sa = await connectAuthed(a.token);
    const sb = await connectAuthed(b.token);
    const bGets = nextMsg(sb, (m) => m.type === 'dm:new');
    const aGets = nextMsg(sa, (m) => m.type === 'dm:new');
    sa.send({ type: 'dm:send', payload: { to: b.userId, text: '私聊测试' } });

    const gotB = await bGets;
    const msg = (gotB.payload as { message: { id: string; from: string; to: string; text: string; kind: string } }).message;
    expect(msg).toMatchObject({ from: a.userId, to: b.userId, text: '私聊测试', kind: 'text' });
    // 发送者自己也会收到回显（多端一致）
    const gotA = await aGets;
    expect((gotA.payload as { message: { id: string } }).message.id).toBe(msg.id);

    // 历史持久化
    const hist = await fetch(`${TEST_HTTP_URL}/api/dm/${b.userId}/messages`, {
      headers: { Authorization: `Bearer ${a.token}` },
    });
    expect(hist.status).toBe(200);
    const body = (await hist.json()) as { messages: Array<{ from: string; text: string }> };
    expect(body.messages[body.messages.length - 1]?.text).toBe('私聊测试');

    sa.close();
    sb.close();
  });

  it('non-member cannot join room via WS (not_in_room)', async () => {
    const owner = await register('guard_owner');
    const outsider = await register('guard_outside');
    const room = await createRoom(owner.token, '私人房间');

    const s = await connectAuthed(outsider.token);
    const errPromise = nextMsg(s, (m) => m.type === 'error');
    s.send({ type: 'room:join', payload: { roomId: room.id } });
    const err = await errPromise;
    expect((err.payload as { code: string }).code).toBe('not_in_room');
    s.close();
  });

  it('reconnects automatically after connection loss', async () => {
    const user = await register('reconnect_int');
    const s = new ChatSocket();
    const statuses: string[] = [];
    s.onStatus((st) => statuses.push(st));

    const opened = new Promise<void>((resolve) => s.onStatus((st) => st === 'open' && resolve()));
    s.connect(TEST_WS_URL);
    await opened;
    s.send({ type: 'hello', payload: { token: user.token } });
    await nextMsg(s, (m) => m.type === 'hello:ok');

    const inner = (s as unknown as { ws: WebSocket }).ws;
    inner.close();

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

  it('roster keeps offline members with presence flags (QQ-style)', async () => {
    const owner = await register('roster_owner');
    const offlineUser = await register('roster_gray');
    const room = await createRoom(owner.token, '花名册小队');

    // 离线成员只走 REST 加入，从不开连接
    await joinRoom(offlineUser.token, room.inviteCode);

    const a = await connectAuthed(owner.token);
    a.send({ type: 'room:join', payload: { roomId: room.id } });
    const joined = await nextMsg(a, (m) => m.type === 'room:joined');
    const rosterOf = () => (joined.payload as { members: Array<{ id: string; online: boolean }> }).members;
    expect(rosterOf().find((m) => m.id === owner.userId)?.online).toBe(true);
    expect(rosterOf().find((m) => m.id === offlineUser.userId)?.online).toBe(false);

    // 离线成员上线：owner 收到 member:joined
    const b = await connectAuthed(offlineUser.token);
    const aSeesJoin = nextMsg(a, (m) => m.type === 'member:joined');
    b.send({ type: 'room:join', payload: { roomId: room.id } });
    await nextMsg(b, (m) => m.type === 'room:joined');
    await aSeesJoin;

    const resubscribe = async (): Promise<Array<{ id: string; online: boolean }>> => {
      a.send({ type: 'room:leave', payload: { roomId: room.id } });
      a.send({ type: 'room:join', payload: { roomId: room.id } });
      const again = await nextMsg(a, (m) => m.type === 'room:joined');
      return (again.payload as { members: Array<{ id: string; online: boolean }> }).members;
    };
    expect((await resubscribe()).find((m) => m.id === offlineUser.userId)?.online).toBe(true);

    // 下线：成员保留在花名册，仅离线标记（不被移除）
    const aSeesLeft = nextMsg(a, (m) => m.type === 'member:left');
    b.close();
    await aSeesLeft;
    const after = await resubscribe();
    const gray = after.find((m) => m.id === offlineUser.userId);
    expect(gray).toBeTruthy();
    expect(gray?.online).toBe(false);
    a.close();
  });
});
