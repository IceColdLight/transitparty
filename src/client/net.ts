import type { C2SMessage, S2CMessage } from '../shared/types.js';

export type NetHandlers = {
  onWelcome: (id: string, color: string) => void;
  onState: (msg: Extract<S2CMessage, { type: 'state' }>) => void;
  onStatus: (s: string) => void;
};

export function connect(url: string, handlers: NetHandlers): { send: (m: C2SMessage) => void } {
  const ws = new WebSocket(url);
  handlers.onStatus('connecting…');

  ws.addEventListener('open', () => handlers.onStatus('connected'));
  ws.addEventListener('close', () => handlers.onStatus('disconnected'));
  ws.addEventListener('error', () => handlers.onStatus('error'));
  ws.addEventListener('message', (ev) => {
    let msg: S2CMessage;
    try { msg = JSON.parse(String(ev.data)); } catch { return; }
    if (msg.type === 'welcome') handlers.onWelcome(msg.id, msg.color);
    else if (msg.type === 'state') handlers.onState(msg);
  });

  return {
    send(m) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); },
  };
}
