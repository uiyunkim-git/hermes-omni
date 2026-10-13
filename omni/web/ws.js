// Browser WebSocket client for the hub's /ws (design §6): reconnect with jittered exponential
// backoff, re-subscribe sessions after reconnect, fan incoming frames out on the bus as
// "ws:<type>" events. Global frames (nodes, requests, hello) also update the store.

import { api } from './api.js';
import { bus, setConn, setNodes, setRequestsCount, state } from './store.js';

const PING_EVERY_MS = 25000;
const DEAD_AFTER_MS = 70000;     // only enforced once the server has proven it answers pings
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30000;

class OmniSocket {
  constructor() {
    this.ws = null;
    this.running = false;
    this.attempt = 0;
    this.retryTimer = 0;
    this.pingTimer = 0;
    this.lastRx = 0;
    this.serverPongs = false;
    /** key "node\u0000sid" → {node, stored_id, refs} */
    this.subs = new Map();
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
    this.subs.clear();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try { ws.close(1000, 'logout'); } catch { /* ignore */ }
    }
    setConn('closed');
  }

  /** Reconnect immediately if we are waiting in backoff (tab became visible, network back). */
  kick() {
    if (!this.running || this.ws) return;
    clearTimeout(this.retryTimer);
    this.attempt = 0;
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
    setConn('connecting');

    ws.onopen = () => {
      opened = true;
      this.lastRx = Date.now();
      this.serverPongs = false;
      setConn('open');
      for (const s of this.subs.values()) this.send({ op: 'sub', node: s.node, stored_id: s.stored_id });
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
      setConn('closed');
      bus.emit('ws:close', { code: ev.code });
      this.scheduleRetry(opened, ev.code);
    };

    ws.onerror = () => { /* onclose follows and handles retry */ };
  }

  dispatch(msg) {
    switch (msg.type) {
      case 'hello':
        this.attempt = 0;
        if (msg.user) state.user = msg.user;
        break;
      case 'nodes':
        setNodes(msg.nodes);
        break;
      case 'requests':
        setRequestsCount(Number(msg.count) || 0);
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
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempt);
    const delay = Math.round(base * (0.7 + Math.random() * 0.6));
    this.attempt = Math.min(this.attempt + 1, 10);
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

  /**
   * Subscribe to a session's live stream. The hub answers each "sub" with a session.snapshot,
   * and we re-send it after every reconnect. Returns an unsubscribe function.
   */
  subscribe(node, storedId) {
    const key = `${node}\u0000${storedId}`;
    let s = this.subs.get(key);
    if (!s) {
      s = { node, stored_id: storedId, refs: 0 };
      this.subs.set(key, s);
    }
    s.refs += 1;
    this.send({ op: 'sub', node, stored_id: storedId });
    let done = false;
    return () => {
      if (done) return;
      done = true;
      s.refs -= 1;
      if (s.refs <= 0) {
        this.subs.delete(key);
        this.send({ op: 'unsub', node, stored_id: storedId });
      }
    };
  }
}

export const socket = new OmniSocket();
