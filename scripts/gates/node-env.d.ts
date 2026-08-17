/**
 * minimal ambient declarations for the node builtins the static gate script
 * uses. @types/node is not a dependency of this project (the app is
 * browser-only); this shim covers exactly what scripts/gates/static.ts needs
 * so `tsc --noEmit` stays green without widening package.json.
 */

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function readdirSync(path: string): string[];
  export function statSync(path: string): { isDirectory(): boolean };
  export function existsSync(path: string): boolean;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function relative(from: string, to: string): string;
}

declare const process: {
  cwd(): string;
  exit(code?: number): never;
  argv: string[];
};
