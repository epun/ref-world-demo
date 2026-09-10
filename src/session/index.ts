/**
 * The session recorder (docs/SESSION.md).
 *
 * An append-only log of what happened in one world session, in a form that can
 * be replayed in code later. The log holds INPUTS (stroke lists, ids, names,
 * personality answers) and DECISIONS (the moderation verdict, the operator's
 * taps, when an egg was forced open), each at an offset in ms from session
 * start — never per-frame state, because generation is deterministic and does
 * not need any (see events.ts for the argument).
 *
 * This barrel is pure: node-safe, no Three.js, no DOM. It ships in the DEMO
 * build, not just dev — a live event is exactly when you want the log. Only
 * the panel button that downloads it is dev-gated (src/dev/index.ts).
 */

export {
  SESSION_SCHEMA,
  SESSION_SCHEMA_VERSION,
  countByKind,
  parseSessionLog,
  readSessionLog,
  serializeSessionLog,
  sessionDurationMs,
  type DrawingEvent,
  type DrawingSource,
  type DriveEvent,
  type EggEvent,
  type EmoteEvent,
  type EmoteSource,
  type HatchCause,
  type HatchEvent,
  type KeepAction,
  type KeepEvent,
  type KeepSource,
  type OperatorAction,
  type OperatorEvent,
  type PaintEvent,
  type RetireCause,
  type RetireEvent,
  type SessionConfig,
  type SessionEvent,
  type SessionEventKind,
  type SessionHeader,
  type SessionLog,
  type WorldEvent,
} from './events';

export {
  DEFAULT_COALESCE_MS,
  DEFAULT_DRIVE_MIN_GAP_MS,
  DEFAULT_EVENT_LIMIT,
  DRIVE_HEADING_STEPS,
  DRIVE_MAG_STEP,
  createSessionRecorder,
  type DriveVector,
  type DrawingRecord,
  type PaintRecord,
  type RecorderOptions,
  type SessionRecorder,
} from './recorder';

export {
  applyEvent,
  createReplayState,
  expectedCreatures,
  replayNow,
  replaySession,
  type ApplyOptions,
  type ReplayDriver,
  type ReplayHandle,
  type ReplayOptions,
  type ReplaySpawn,
  type ReplayState,
} from './replay';

export {
  MAX_SCENE_BATCH,
  MAX_SCENE_EVENTS,
  SCENE_EXTENT,
  SCENE_MAX_RADIUS,
  SCENE_TERRAIN_LIMITS,
  SCENE_WORLD_FIELDS,
  compactScene,
  isSceneEvent,
  readSceneBatch,
  readSceneEvent,
  type SceneEvent,
  type SceneWorldField,
} from './scene';

export {
  recordCreatures,
  recordGate,
  type CreatureObserverShape,
  type GateObserverShape,
  type GateRecorderOptions,
  type RecordableDrawing,
  type RecordableEntry,
} from './wire';
