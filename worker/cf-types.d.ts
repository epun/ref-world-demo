/**
 * Minimal ambient declarations for the Cloudflare Workers runtime — exactly
 * what worker/relay.ts touches, nothing more. The project deliberately does
 * not depend on @cloudflare/workers-types or wrangler (same pattern as
 * scripts/gates/node-env.d.ts): these shims keep `tsc --noEmit -p worker`
 * green while the worker logic stays plain portable TS.
 *
 * The base lib here is the DOM lib (inherited from the root tsconfig), which
 * already supplies Request, Response, URL, and the standard WebSocket surface;
 * the declarations below only add the Workers-specific extensions on top.
 */

/** Workers-only: a server-side socket must be accepted before use. */
interface WebSocket {
  accept(): void;
}

/** Workers-only: the client half of a WebSocketPair rides on the 101 Response. */
interface ResponseInit {
  webSocket?: WebSocket | null;
}

/** The two ends of an in-runtime socket: 0 goes to the client, 1 stays server-side. */
declare class WebSocketPair {
  0: WebSocket;
  1: WebSocket;
}

interface DurableObjectId {
  toString(): string;
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

/**
 * Only the identity surface — this relay keeps rooms in memory and never
 * touches `state.storage` (PLAN open decision #4).
 */
interface DurableObjectState {
  id: DurableObjectId;
  waitUntil(promise: Promise<unknown>): void;
}
