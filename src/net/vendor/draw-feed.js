// draw-feed.js — a live feed of drawings from phones into your app.
//
// Framework-agnostic. No dependency except an MQTT client (window.mqtt from
// ./vendor/mqtt.min.js, or pass your own in `opts.mqtt`). You get each drawing
// as a plain object and decide what to do with it — spawn a mesh, an <img>,
// whatever. A helper renders the strokes to a <canvas> you can use as a texture.
//
// Protocol (matches phone/index.html):
//   topic:   `${topicPrefix}${room}`          phones publish here, you subscribe
//   payload: { id, name, strokes, ts }
//   strokes: [{ color:'#rrggbb', width:Number, pts:[[x,y], …] }]   x,y in 0..1
//   back-channel (optional, two-way):
//   topic:   `${topicPrefix}${room}/up`        you publish here, phones subscribe
//
// Quick start:
//   import { createDrawFeed, strokesToCanvas } from './src/draw-feed.js';
//   const feed = createDrawFeed({
//     room: 'my-room',
//     onDrawing: (d) => { const tex = strokesToCanvas(d.strokes); /* … */ },
//     onStatus:  (state, text) => console.log('[feed]', state, text),
//   });
//   // two-way: tell the phones something back
//   feed.publishToPhones({ type: 'ack', name: 'Sarah' });

export const DEFAULTS = {
  broker: 'wss://broker.emqx.io:8084/mqtt', // free public broker — see README before production
  topicPrefix: 'drawto3d/v1/',
  room: 'demo',
};

/**
 * Subscribe to the live drawing feed for a room.
 * @returns {{client, topic, upTopic, setAccepting, publishToPhones, destroy}}
 */
export function createDrawFeed({
  broker = DEFAULTS.broker,
  topicPrefix = DEFAULTS.topicPrefix,
  room = DEFAULTS.room,
  mqtt = (typeof window !== 'undefined' ? window.mqtt : null),
  accept = true,
  maxQueue = 80,        // in a flood, keep only the newest N pending
  throttleMs = 0,       // >0 paces onDrawing calls (ms apart) so bursts don't spike your render loop
  dedupe = true,        // ignore repeat message ids
  onDrawing = () => {},
  onStatus = () => {},
} = {}) {
  if (!mqtt || typeof mqtt.connect !== 'function') {
    throw new Error('draw-feed: no MQTT client. Load ./vendor/mqtt.min.js before this module, or pass { mqtt }.');
  }
  const topic = topicPrefix + room;
  const upTopic = topic + '/up';
  const seen = new Set();
  const queue = [];
  let draining = false;
  let accepting = accept !== false;

  const client = mqtt.connect(broker, {
    clientId: 'feed_' + Math.random().toString(16).slice(2, 10),
    keepalive: 30,
    reconnectPeriod: 2000,
  });

  client.on('connect',   () => { onStatus('on', 'live');           client.subscribe(topic); });
  client.on('reconnect', () => onStatus('', 'reconnecting'));
  client.on('close',     () => onStatus('off', 'offline'));
  client.on('error',     (e) => onStatus('off', 'error: ' + (e && e.message || e)));
  client.on('message',   (t, payload) => {
    if (t !== topic || !accepting) return;
    let msg;
    try { msg = JSON.parse(payload.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (dedupe && msg.id != null) { if (seen.has(msg.id)) return; seen.add(msg.id); }
    if (throttleMs > 0) {
      queue.push(msg);
      if (queue.length > maxQueue) queue.splice(0, queue.length - maxQueue);
      if (!draining) drain();
    } else {
      safe(msg);
    }
  });

  function drain() {
    draining = true;
    const m = queue.shift();
    if (!m) { draining = false; return; }
    safe(m);
    setTimeout(drain, throttleMs);
  }
  function safe(m) { try { onDrawing(m); } catch (e) { console.error('draw-feed onDrawing threw:', e); } }

  return {
    client,
    topic,
    upTopic,
    /** Pause / resume accepting incoming drawings (wiring stays connected). */
    setAccepting: (v) => { accepting = v !== false; return accepting; },
    /** Two-way: send a message down to every phone in this room. */
    publishToPhones: (obj) => client.publish(upTopic, JSON.stringify(obj), { qos: 0 }),
    /** Disconnect and stop. */
    destroy: () => { try { client.end(true); } catch {} },
  };
}

/**
 * Render normalised strokes to a <canvas> (a clean card). Use it as a texture
 * (e.g. new THREE.CanvasTexture(canvas)), draw it to another canvas, or
 * strokesToDataURL() it into an <img>.
 */
export function strokesToCanvas(strokes, { size = 448, background = '#ffffff', padding = 0 } = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d');
  if (background) { x.fillStyle = background; x.fillRect(0, 0, size, size); }
  x.lineCap = 'round';
  x.lineJoin = 'round';
  const span = size - padding * 2;
  for (const s of (strokes || [])) {
    if (!s || !s.pts || !s.pts.length) continue;
    x.strokeStyle = s.color || '#111111';
    x.lineWidth = Math.max(2, (s.width || 6) * (size / 320));
    x.beginPath();
    x.moveTo(padding + s.pts[0][0] * span, padding + s.pts[0][1] * span);
    for (let i = 1; i < s.pts.length; i++) x.lineTo(padding + s.pts[i][0] * span, padding + s.pts[i][1] * span);
    if (s.pts.length === 1) x.lineTo(padding + s.pts[0][0] * span + 0.01, padding + s.pts[0][1] * span);
    x.stroke();
  }
  return c;
}

export const strokesToDataURL = (strokes, opts) => strokesToCanvas(strokes, opts).toDataURL('image/png');

/** The topic a room publishes/receives on — handy for tools or a custom publisher. */
export const topicFor = (room, prefix = DEFAULTS.topicPrefix) => prefix + room;
