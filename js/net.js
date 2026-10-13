// Network layer: phones talk through a free public MQTT broker over secure WebSockets.
// The host phone owns the game state and publishes it as a retained message, so a phone that
// (re)connects immediately gets the latest state. Guests send actions; the host applies them.
//
// Topics, for a game with code ABCDE:
//   gotovim-vmeste/v1/ABCDE/state   retained, the whole game state (host → everyone)
//   gotovim-vmeste/v1/ABCDE/recipe  retained, the recipe being cooked (host → everyone)
//   gotovim-vmeste/v1/ABCDE/act     actions from phones (guests → host)
//
// Public brokers need no account and cost nothing. They are also readable by anyone who knows
// the game code, which is fine for a cooking game: nothing personal is sent besides first names.

const PUBLIC_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];

/** `?broker=ws://localhost:8883` replaces the list (local development and tests). */
export function brokers() {
  try {
    const b = new URLSearchParams(location.search).get('broker');
    if (b) return [b];
  } catch (e) { /* not in a browser */ }
  return PUBLIC_BROKERS;
}

const NS = 'gotovim-vmeste/v1/';
const topic = (code, kind) => `${NS}${code}/${kind}`;

function connectOne(url, clientId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const client = window.mqtt.connect(url, {
      clientId, clean: true, keepalive: 30, reconnectPeriod: 0, connectTimeout: timeoutMs,
      protocolVersion: 4,
    });
    const timer = setTimeout(() => { client.end(true); reject(new Error('timeout')); }, timeoutMs + 500);
    client.once('connect', () => { clearTimeout(timer); resolve(client); });
    client.once('error', err => { clearTimeout(timer); client.end(true); reject(err); });
  });
}

export class Net {
  constructor(pid, onStatus) {
    this.pid = pid;
    this.onStatus = onStatus || (() => {});
    this.client = null;
    this.broker = -1;
    this.handlers = {};
    this.code = null;
  }

  /** Connect to the broker with the given index, or try them in order from `start`. */
  async connect(index, { tryOthers = true } = {}) {
    const list = brokers();
    const order = tryOthers ? [...list.keys()].map(k => (k + (index || 0)) % list.length) : [index || 0];
    let lastErr = null;
    for (const i of order) {
      if (i >= list.length) continue;
      try {
        const id = `gv_${this.pid.slice(0, 10)}_${Math.random().toString(36).slice(2, 7)}`;
        const client = await connectOne(list[i], id, 7000);
        this.attach(client, i, list[i]);
        return i;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('no broker');
  }

  attach(client, index, url) {
    this.close();
    this.client = client;
    this.broker = index;
    // Keep reconnecting after the first successful connection (phones sleep, Wi‑Fi changes).
    client.options.reconnectPeriod = 2000;
    client.on('error', () => { /* reconnect handles it */ });
    client.on('connect', () => { this.onStatus('online'); this.resubscribe(); });
    client.on('reconnect', () => this.onStatus('connecting'));
    client.on('offline', () => this.onStatus('offline'));
    client.on('close', () => this.onStatus('offline'));
    client.on('message', (t, buf, packet) => {
      const kind = t.split('/').pop();
      const h = this.handlers[kind];
      if (!h) return;
      const text = buf.toString();
      if (!text) { h(null, packet); return; }
      try { h(JSON.parse(text), packet); } catch (e) { /* ignore malformed */ }
    });
    this.onStatus('online');
    this.resubscribe();
  }

  resubscribe() {
    if (!this.client || !this.code) return;
    const kinds = Object.keys(this.handlers);
    if (kinds.length) this.client.subscribe(kinds.map(k => topic(this.code, k)), { qos: 1 });
  }

  /** Listen to `state`, `recipe` or `act` messages of one game. */
  join(code, handlers) {
    if (this.code && this.code !== code && this.client) {
      this.client.unsubscribe(Object.keys(this.handlers).map(k => topic(this.code, k)));
    }
    this.code = code;
    this.handlers = handlers;
    this.resubscribe();
  }

  publish(kind, data, { retain = false } = {}) {
    if (!this.client || !this.code) return false;
    this.client.publish(topic(this.code, kind), data == null ? '' : JSON.stringify(data), { qos: 1, retain });
    return this.client.connected;
  }

  /** Remove a finished game's retained messages from the broker. */
  clear(code) {
    if (!this.client) return;
    for (const k of ['state', 'recipe']) this.client.publish(topic(code, k), '', { qos: 1, retain: true });
  }

  get online() { return !!(this.client && this.client.connected); }

  close() {
    if (this.client) { try { this.client.end(true); } catch (e) { /* already closed */ } }
    this.client = null;
  }
}

/**
 * Find which broker a game lives on when only its code is known: connect to each broker and
 * wait briefly for the retained state.
 */
export async function findGame(code, pid) {
  const list = brokers();
  for (let i = 0; i < list.length; i++) {
    let client = null;
    try {
      client = await connectOne(list[i], `gv_probe_${pid.slice(0, 6)}_${Math.random().toString(36).slice(2, 6)}`, 6000);
      const found = await new Promise(resolve => {
        const t = setTimeout(() => resolve(false), 3500);
        client.on('message', (_t, buf) => { if (buf.length) { clearTimeout(t); resolve(true); } });
        client.subscribe(topic(code, 'state'), { qos: 1 });
      });
      client.end(true);
      if (found) return i;
    } catch (e) { if (client) client.end(true); }
  }
  return -1;
}
