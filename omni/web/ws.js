// Browser WebSocket client for the hub's /ws (spec §5.6). Reconnects with backoff 0.5→8 s,
// re-subscribes the open chat after reconnect and fans frames out on the bus as "ws:<type>".
// Global frames (hello, nodes, sessions, requests) also update the store.

import { api } from './api.js';
import {
  bus, setConn, setNodes, setRequests, replaceSessions, upsertSessions, removeSessions, state,
} from './store.js';

const PING_EVERY_MS = 25000;
const DEAD_AFTER_MS = 70000;     // only enforced once the server has proven it answers pings
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];

class OmniSocket {
  constructor() {
    this.ws = null;
    this.running = false;
    this.attempt = 0;
    this.retryTimer = 0;
    this.pingTimer = 0;
    this.lastRx = 0;
    this.serverPongs = false;
    /** The single live subscription (the open chat): {node, stored_id} | null */
    this.sub = null;
    this.onVisible = () => {
      if (document.visibilityState === 'visible') this.kick();
    };
    this.onOnline = () => this.kick();
  }

  get isOpen() { return this.ws?.readyState === WebSocket.OPEN; }

  start() {
    if (this.running) return;
    this.running = true;
    document.addEventListener('visibilitychange', this.onVisible);
    window.addEventListener('online', this.onOnline);
    this.connect();
  }

  stop() {
    this.running = false;
    document.removeEventListener('visibilitychange', this.onVisible);
    window.removeEventListener('online', this.onOnline);
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    this.sub = null;
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try { ws.close(1000, 'logout'); } catch { /* ignore */ }
    }
    this.attempt = 0;
    setConn('closed', 0);
  }

  /** Reconnect now if we are waiting in backoff (tab visible again, network back, user tap). */
  kick() {
    if (!this.running || this.ws) return;
    clearTimeout(this.retryTimer);
    this.connect();
  }

  connect() {
    if (!this.running) return;
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      console.warn('[ws] construct failed', err);
      this.scheduleRetry(false);
      return;
    }
    this.ws = ws;
    let opened = false;
    setConn('connecting', this.attempt);

    ws.onopen = () => {
      opened = true;
      this.attempt = 0;
      this.lastRx = Date.now();
      this.serverPongs = false;
      setConn('open', 0);
      if (this.sub) this.send({ op: 'sub', node: this.sub.node, stored_id: this.sub.stored_id });
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.heartbeat(), PING_EVERY_MS);
      bus.emit('ws:open');
    };

    ws.onmessage = (ev) => {
      this.lastRx = Date.now();
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg || typeof msg.type !== 'string') return;
      this.dispatch(msg);
    };

    ws.onclose = (ev) => {
      if (this.ws !== ws) return;          // superseded or stopped
      this.ws = null;
      clearInterval(this.pingTimer);
      bus.emit('ws:close', { code: ev.code });
      this.scheduleRetry(opened, ev.code);
    };

    ws.onerror = () => { /* onclose follows and handles retry */ };
  }

  dispatch(msg) {
    switch (msg.type) {
      case 'hello':
        if (msg.user) state.user = msg.user;
        if (msg.hub_version) state.hubVersion = msg.hub_version;
        break;
      case 'nodes':
        setNodes(msg.nodes);
        break;
      case 'sessions':
        if (msg.full) replaceSessions(msg.sessions);
        else {
          if (Array.isArray(msg.remove) && msg.remove.length) removeSessions(msg.remove);
          if (Array.isArray(msg.upsert) && msg.upsert.length) upsertSessions(msg.upsert);
        }
        break;
      case 'requests':
        setRequests(msg);
        break;
      case 'pong':
        this.serverPongs = true;
        break;
      default:
        break;
    }
    bus.emit(`ws:${msg.type}`, msg);
  }

  heartbeat() {
    if (!this.isOpen) return;
    if (this.serverPongs && Date.now() - this.lastRx > DEAD_AFTER_MS) {
      console.warn('[ws] no traffic, reconnecting');
      try { this.ws.close(4000, 'stale'); } catch { /* ignore */ }
      return;
    }
    this.send({ op: 'ping' });
  }

  async scheduleRetry(wasOpen, code) {
    if (!this.running) return;
    this.attempt += 1;
    setConn('connecting', this.attempt);
    // A handshake that never opened (or an auth close) may mean the session cookie expired.
    if (!wasOpen || code === 4401 || code === 1008) {
      try {
        await api.me();
      } catch (err) {
        if (err.status === 401) {
          bus.emit('unauthorized');
          return;
        }
      }
      if (!this.running) return;
    }
    const base = BACKOFF_MS[Math.min(this.attempt - 1, BACKOFF_MS.length - 1)];
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  send(obj) {
    if (!this.isOpen) return false;
    try {
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  /** Ask the hub to re-send the full sessions index and requests (pull-to-refresh). */
  resync() {
    return this.send({ op: 'resync' });
  }

  /**
   * Subscribe to one session's live stream (exactly one at a time). The hub answers with a
   * session.snapshot; it is re-sent after every reconnect. Returns an unsubscribe function.
   */
  subscribe(node, storedId) {
    if (this.sub && (this.sub.node !== node || this.sub.stored_id !== storedId)) {
      this.send({ op: 'unsub', node: this.sub.node, stored_id: this.sub.stored_id });
    }
    const sub = { node, stored_id: storedId };
    this.sub = sub;
    this.send({ op: 'sub', node, stored_id: storedId });
    return () => {
      if (this.sub !== sub) return;
      this.sub = null;
      this.send({ op: 'unsub', node, stored_id: storedId });
    };
  }
}

export const socket = new OmniSocket();
