// Global client state + a tiny event bus. Views subscribe with `bus.on(type, fn)` (returns an
// unsubscribe function) and must unsubscribe in their cleanup.

class Bus {
  constructor() { this.handlers = new Map(); }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type)?.delete(fn);
  }

  emit(type, data) {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(data); } catch (err) { console.error(`[bus] handler for ${type} failed`, err); }
    }
  }
}

export const bus = new Bus();

export const state = {
  user: null,
  /** NodeInfo[] (+ online, last_seen) — kept fresh by the WS "nodes" push. */
  nodes: [],
  nodesLoaded: false,
  requestsCount: 0,
  conn: 'closed',
};

export function setNodes(nodes) {
  state.nodes = Array.isArray(nodes) ? nodes : [];
  state.nodesLoaded = true;
  bus.emit('nodes', state.nodes);
}

export function findNode(nodeId) {
  return state.nodes.find((n) => n.node_id === nodeId) || null;
}

export function setRequestsCount(n) {
  const count = Number.isFinite(n) ? n : 0;
  if (count === state.requestsCount) return;
  state.requestsCount = count;
  bus.emit('requests-count', count);
}

export function setConn(s) {
  if (s === state.conn) return;
  state.conn = s;
  bus.emit('conn', s);
}
