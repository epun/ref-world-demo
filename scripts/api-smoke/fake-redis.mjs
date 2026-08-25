// A minimal Upstash-REST-compatible server, so the api can be exercised
// against a real network round trip without provisioning anything.
import http from 'node:http';
const lists = new Map(), keys = new Map();
const run = (cmd) => {
  const [op, ...args] = cmd.map(String);
  switch (op.toLowerCase()) {
    case 'set': {
      const [k, v, ...rest] = args;
      const nx = rest.some((r) => String(r).toLowerCase() === 'nx');
      if (nx && keys.has(k)) return null;
      keys.set(k, v); return 'OK';
    }
    case 'get': return keys.has(args[0]) ? keys.get(args[0]) : null;
    case 'rpush': {
      const [k, ...vals] = args;
      const l = lists.get(k) ?? []; l.push(...vals); lists.set(k, l); return l.length;
    }
    case 'lrange': {
      const [k, a, b] = args; const l = lists.get(k) ?? [];
      const end = Number(b) === -1 ? l.length : Number(b) + 1;
      return l.slice(Number(a), end);
    }
    case 'lset': {
      const [k, i, v] = args; const l = lists.get(k) ?? [];
      if (!l.length) return null; l[Number(i)] = v; return 'OK';
    }
    default: return null;
  }
};
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let cmd;
    try { cmd = JSON.parse(body); } catch { cmd = decodeURIComponent(req.url).slice(1).split('/'); }
    const result = Array.isArray(cmd?.[0]) ? cmd.map(run).map((r) => ({ result: r })) : run(cmd);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(Array.isArray(cmd?.[0]) ? result : { result }));
  });
}).listen(6390, () => console.log('fake redis on 6390'));
