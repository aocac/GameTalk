import { create } from 'zustand';
import { ChatSocket } from '../app/ws';
import { playMessageSound, playSendSound } from '../app/audio';
import { useSettings } from '../app/settings';
import { useAuth } from './auth';
import { wsUrlOf } from '../app/settings';
import type { ChatMessage, UserBrief, WsStatus } from '../app/types';

interface ChatState {
  status: WsStatus;
  me: UserBrief | null;
  roomId: string | null;
  members: UserBrief[];
  messages: ChatMessage[];
  connect: () => void;
  disconnect: () => void;
  sendMessage: (text: string) => void;
}

let socket: ChatSocket | null = null;

export const useChat = create<ChatState>()((set, get) => ({
  status: 'idle',
  me: null,
  roomId: null,
  members: [],
  messages: [],

  connect: () => {
    const { token } = useAuth.getState();
    if (!token) return;
    if (socket) socket.close();

    socket = new ChatSocket();
    socket.onStatus((status) => {
      set({ status });
      if (status === 'open') {
        socket?.send({ type: 'hello', payload: { token } });
      }
    });
    socket.onMessage((msg) => {
      const state = get();
      switch (msg.type) {
        case 'hello:ok':
          set({ me: msg.payload.me });
          socket?.send({ type: 'room:join', payload: { roomId: 'lobby' } });
          break;
        case 'room:joined':
          set({ roomId: msg.payload.roomId, members: msg.payload.members });
          break;
        case 'member:joined':
          if (msg.payload.roomId === state.roomId && !state.members.some((m) => m.id === msg.payload.member.id)) {
            set({ members: [...state.members, msg.payload.member] });
          }
          break;
        case 'member:left':
          if (msg.payload.roomId === state.roomId) {
            set({ members: state.members.filter((m) => m.id !== msg.payload.userId) });
          }
          break;
        case 'message:new': {
          if (msg.payload.roomId !== state.roomId) break;
          set({ messages: [...state.messages, msg.payload.message] });
          const isMine = msg.payload.message.userId === state.me?.id;
          if (!isMine) playMessageSound(useSettings.getState().soundEnabled);
          break;
        }
        case 'error':
          if (msg.payload.code === 'unauthorized') {
            useAuth.getState().logout();
          }
          break;
        default:
          break;
      }
    });

    socket.connect(wsUrlOf(useSettings.getState().serverUrl));
  },

  disconnect: () => {
    socket?.close();
    set({ status: 'closed', me: null, roomId: null, members: [], messages: [] });
  },

  sendMessage: (text) => {
    const trimmed = text.trim();
    const { roomId } = get();
    if (!trimmed || !roomId) return;
    const ok = socket?.send({ type: 'message:send', payload: { roomId, text: trimmed } });
    if (ok) playSendSound(useSettings.getState().soundEnabled);
  },
}));
