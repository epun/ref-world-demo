// Drive the real handlers against the fake Redis, with real request shapes.
process.env.UPSTASH_REDIS_REST_URL = 'http://localhost:6390';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
process.env.MODERATOR_SECRET = 'a-long-enough-secret';

const drawings = (await import('/home/user/ref-world-demo/api/drawings.ts')).default;
const moderate = (await import('/home/user/ref-world-demo/api/moderate.ts')).default;

const blob = (rx, ry) => {
  const pts = [];
  for (let i = 0; i <= 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    pts.push([+(0.5 + rx * Math.cos(a)).toFixed(4), +(0.5 + ry * Math.sin(a)).toFixed(4)]);
  }
  return [{ color: '#000', width: 8, pts }];
};

function res() {
  const r = { code: 0, body: null, headers: {} };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
}
const call = async (h, req) => { const r = res(); await h(req, r); return r; };

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) failures++;
};

// 1. empty world
let r = await call(drawings, { method: 'GET', query: { world: 'public' }, headers: {} });
check('empty world returns a session log', r.code === 200 && r.body.schema === 'refworld.session' && r.body.events.length === 0);

// 2. submit
r = await call(drawings, { method: 'POST', query: { world: 'public' }, headers: {},
  body: { id: 'phone-a', name: 'ada', strokes: blob(0.26, 0.3) } });
check('a drawing is accepted', r.code === 201 && r.body.status === 'accepted', JSON.stringify(r.body));

// 3. one per device
r = await call(drawings, { method: 'POST', query: { world: 'public' }, headers: {},
  body: { id: 'phone-a', name: 'ada again', strokes: blob(0.2, 0.2) } });
check('the same device is refused a second creature', r.code === 409, JSON.stringify(r.body));

// 4. a different device is fine
r = await call(drawings, { method: 'POST', query: { world: 'public' }, headers: {},
  body: { id: 'phone-b', name: '', strokes: blob(0.33, 0.2) } });
check('a different device may draw', r.code === 201);

// 5. worlds are separate
r = await call(drawings, { method: 'POST', query: { world: 'other' }, headers: {},
  body: { id: 'phone-a', name: 'ada', strokes: blob(0.26, 0.3) } });
check('the same device may draw in a DIFFERENT world', r.code === 201);

// 6. the world reads back
r = await call(drawings, { method: 'GET', query: { world: 'public' }, headers: {} });
const ids = r.body.events.filter((e) => e.k === 'drawing').map((e) => e.id);
check('both creatures come back, in order', JSON.stringify(ids) === '["phone-a","phone-b"]', JSON.stringify(ids));
check('an unsigned drawing has a null name', r.body.events.find((e) => e.id === 'phone-b').name === null);
check('strokes converted to the pure form', Array.isArray(r.body.events[0].strokes) && typeof r.body.events[0].strokes[0].w === 'number');

// 7. validation
r = await call(drawings, { method: 'POST', query: {}, headers: {}, body: { id: 'x' } });
check('a body with no strokes is rejected', r.code === 400);
r = await call(drawings, { method: 'PUT', query: {}, headers: {}, body: {} });
check('an unknown method is rejected', r.code === 405);

// 8. moderator gate
r = await call(moderate, { method: 'GET', query: { world: 'public' }, headers: {} });
check('moderation is invisible without the secret', r.code === 404);
r = await call(moderate, { method: 'GET', query: { world: 'public' }, headers: { 'x-moderator': 'wrong-length-x' } });
check('a wrong secret is refused', r.code === 404);
r = await call(moderate, { method: 'GET', query: { world: 'public' }, headers: { 'x-moderator': 'a-long-enough-secret' } });
check('the moderator sees the list', r.code === 200 && r.body.counts.admitted === 2, JSON.stringify(r.body?.counts));
check('the list carries no stroke payloads', r.body.drawings.every((d) => d.strokes === undefined && typeof d.strokeCount === 'number'));

// 9. removing a creature takes it out of the world
r = await call(moderate, { method: 'POST', query: { world: 'public' }, headers: { 'x-moderator': 'a-long-enough-secret' },
  body: { id: 'phone-a', disposition: 'refused' } });
check('the moderator can refuse one', r.code === 200, JSON.stringify(r.body));
r = await call(drawings, { method: 'GET', query: { world: 'public' }, headers: {} });
const after = r.body.events.filter((e) => e.k === 'drawing').map((e) => e.id);
check('a refused creature leaves the world', JSON.stringify(after) === '["phone-b"]', JSON.stringify(after));

// 10. and can be put back
await call(moderate, { method: 'POST', query: { world: 'public' }, headers: { 'x-moderator': 'a-long-enough-secret' },
  body: { id: 'phone-a', disposition: 'admitted' } });
r = await call(drawings, { method: 'GET', query: { world: 'public' }, headers: {} });
check('and can be admitted again', r.body.events.filter((e) => e.k === 'drawing').length === 2);

r = await call(moderate, { method: 'POST', query: {}, headers: { 'x-moderator': 'a-long-enough-secret' },
  body: { id: 'phone-a', disposition: 'nonsense' } });
check('an unknown disposition is rejected', r.code === 400);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
