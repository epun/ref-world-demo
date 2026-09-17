/**
 * A DRAWING FROM THE RUN BEFORE THE RESET IS REFUSED, ON EVERY PATH.
 *
 * > User report, 2026-09-17, valiocon: *"even after reset using the mod
 * > secret key the scene does not reset"*.
 *
 * Measured at the time: the store WAS reset — `GET /api/drawings` answered
 * generation 1 with no drawings — and the projection filled straight back up
 * with the last run's creatures. So they were not coming out of the store.
 * They were coming over the BROKER, through the one door that had no lock on
 * it: the world's own `onDrawing`, which admitted whatever the room's topic
 * carried without ever asking which run of the world it was drawn into.
 *
 * A reset can empty a store and step a generation. It cannot reach into a
 * phone. Every handset in the room still held its drawing — as it must
 * (CLAUDE.md: never delete it) — and every path that offers one back was
 * generation-blind:
 *
 *   - the pad's publish and its hand-back, which carried no epoch at all, so
 *     the world had nothing to judge them by;
 *   - the companion's resend on a recall, and its re-home into what it took
 *     for a restarted world;
 *   - and the world's accept, which is the one that DECIDES.
 *
 * So the rule is one pure function (`admitsDrawing`), the epoch travels with
 * the drawing, and this file pins both: the function's own asymmetry, the
 * wire carrying it through the real `resend` and the real `normalizeDrawing`,
 * and — because src/main.ts cannot be imported — that the world's accept and
 * its announcements are wired to them.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeDrawing } from '../../src/net/drawFeed';
import { createPhoneLink } from '../../src/net/phoneLink';
import { admitsDrawing, epochFor, generationVerdict } from '../../src/phone/identity';
import type { FeedDrawing } from '../../src/net/vendor/draw-feed';

/** src/main.ts, for the seams this harness cannot import. */
const mainSrc = (): string => readFileSync(join(process.cwd(), 'src/main.ts'), 'utf8');
/** The pad, which imports nothing and writes the same rules out again. */
const padSrc = (): string => readFileSync(join(process.cwd(), 'public/draw/index.html'), 'utf8');

const G0 = epochFor('valiocon', 0);
const G1 = epochFor('valiocon', 1);

describe('admitsDrawing — the one rule, and its asymmetry', () => {
  it('refuses a drawing from before the reset', () => {
    expect(admitsDrawing(G1, G0)).toBe(false);
    expect(admitsDrawing(epochFor('valiocon', 9), epochFor('valiocon', 8))).toBe(false);
  });

  it('admits the same generation — which is the whole recovery path', () => {
    // A projection that RESTARTED lost a population it still wants back, and
    // the handsets hand it over under the same generation. That re-home is
    // the property the project is built around; nothing here may touch it.
    expect(admitsDrawing(G1, G1)).toBe(true);
    expect(admitsDrawing(G0, G0)).toBe(true);
  });

  it('admits a NEWER epoch on the drawing, because this side may be behind', () => {
    // A stale retained announcement, or a projection left open on an older
    // build. Refusing on the strength of a message that is behind would drop
    // a creature standing in the world right now.
    expect(admitsDrawing(G0, G1)).toBe(true);
  });

  it('admits everything when the world does not know its own generation', () => {
    expect(admitsDrawing(null, null)).toBe(true);
    expect(admitsDrawing('', G0)).toBe(true);
    expect(admitsDrawing(undefined, undefined)).toBe(true);
    // An installation room's epoch carries no generation at all, so nothing
    // about that world changes.
    expect(admitsDrawing('w1a2b3c', 'w9z8y7')).toBe(true);
  });

  it('reads an absent epoch as generation 0, on both sides', () => {
    // Every drawing published before the epoch travelled says nothing. A
    // world that has never been reset admits it exactly as it always did…
    expect(admitsDrawing(G0, null)).toBe(true);
    expect(admitsDrawing('w-valiocon', undefined)).toBe(true);
    // …and a world that HAS been reset cannot take its word for it.
    expect(admitsDrawing(G1, null)).toBe(false);
  });

  it('is the same rule the handset steps down on', () => {
    // One rule, two sides of the wire: what the world would refuse is what
    // the handset stops offering.
    const mine = { id: 'd', name: null, strokes: [1], ts: 0, epoch: G0 };
    expect(generationVerdict(mine, G1)).toBe('step-down');
    expect(admitsDrawing(G1, mine.epoch)).toBe(false);
    expect(generationVerdict(mine, G0)).toBe('stay');
    expect(admitsDrawing(G0, mine.epoch)).toBe(true);
  });
});

/** A phone link over an in-memory broker: every publish is captured. */
function linkOnBus() {
  const published: { topic: string; body: Record<string, unknown> }[] = [];
  const client = {
    publish(topic: string, payload: string) {
      published.push({ topic, body: JSON.parse(payload) as Record<string, unknown> });
    },
    subscribe() {},
    on() {},
    end() {},
  };
  const link = createPhoneLink('xkcd', 'd-phone', {
    mqtt: { connect: () => client },
    random: () => 0.5,
  });
  return { published, link };
}

describe('the epoch travels WITH the drawing', () => {
  it('a resend carries the run the drawing was admitted under', () => {
    const { published, link } = linkOnBus();
    link?.resend({ id: 'd-phone', name: 'moss', strokes: [{ width: 8, pts: [[0, 0]] }], epoch: G1 });
    const sent = published.find((m) => m.body['strokes'] !== undefined);
    expect(sent?.body['epoch']).toBe(G1);
    // The kit's own wire shape, untouched otherwise — the world's feed has
    // to ingest this exactly as it ingested the original publish.
    expect(sent?.body['id']).toBe('d-phone');
    expect(sent?.body['name']).toBe('moss');
  });

  it('omits it rather than inventing one, which reads as generation 0', () => {
    const { published, link } = linkOnBus();
    link?.resend({ id: 'd-phone', name: null, strokes: [{ width: 8, pts: [[0, 0]] }] });
    const sent = published.find((m) => m.body['strokes'] !== undefined);
    expect('epoch' in (sent?.body ?? {})).toBe(false);
  });

  it('survives the feed’s normalize, which is what the world actually reads', () => {
    const wire = {
      id: 'd-phone',
      name: 'moss',
      epoch: G0,
      strokes: [{ width: 8, pts: [[0.2, 0.3] as [number, number], [0.8, 0.7] as [number, number]] }],
    } satisfies FeedDrawing;
    const normalized = normalizeDrawing(wire);
    expect(normalized?.epoch).toBe(G0);
    // And the world, at generation 1, turns exactly this away.
    expect(admitsDrawing(G1, normalized?.epoch)).toBe(false);
  });

  it('reads a wire message with no epoch as null, never as undefined or ""', () => {
    const wire = {
      id: 'd-phone',
      strokes: [{ width: 8, pts: [[0.2, 0.3] as [number, number], [0.8, 0.7] as [number, number]] }],
    } satisfies FeedDrawing;
    expect(normalizeDrawing(wire)?.epoch).toBeNull();
    // An empty string is a publisher that said nothing, not a world named ''.
    expect(normalizeDrawing({ ...wire, epoch: '' })?.epoch).toBeNull();
  });
});

/**
 * THE DECIDING PAGE — asserted on the source, because src/main.ts is the
 * page and cannot be imported into a unit test.
 *
 * Every one of these was the bug, so each is a line rather than a shape: the
 * accept has to ask, and the announcement has to reach a phone at the three
 * moments a page can be the first to know which world it is.
 */
describe('the world refuses it on the way in', () => {
  it('asks admitsDrawing in the feed’s own accept', () => {
    const src = mainSrc();
    expect(src).toMatch(/admitsDrawing\(publishedEpoch, d\.epoch\)/);
    // Off the epoch this page read for itself, so every page agrees without
    // asking — a viewer that admitted what the host refused would show a
    // creature nothing was simulating.
    expect(src).toMatch(/if \(!admitsDrawing\(publishedEpoch, d\.epoch\)\) \{/);
  });

  it('announces the new generation on the reset’s own answer', () => {
    const src = mainSrc();
    // Not on the next twenty-second poll: `startFresh` reports the number
    // the moderator endpoint answered with, and the room is told at once.
    expect(src).toMatch(/outcome\.generation !== null/);
    expect(src).toMatch(/publishedEpoch = epochFor\(worldName, outcome\.generation\)/);
  });

  it('announces again when this page BECOMES the host', () => {
    const src = mainSrc();
    // Only the host speaks to the handsets, so a page that wins the election
    // inherits the job — and the retained announcement it inherits may be
    // the run that was just cleared.
    const settle = src.slice(src.indexOf('const settleRole'));
    expect(settle.slice(0, settle.indexOf('const beat ='))).toMatch(/announceEpoch\(\)/);
  });

  it('has exactly one place that publishes the announcement', () => {
    const src = mainSrc();
    // Four moments can be the first to know; one function says it, and it is
    // the only thing that is allowed to be gated on being the host.
    expect(src.match(/announceEpochRetained\(/g)).toHaveLength(1);
  });
});

describe('the pad says which run it is drawing into', () => {
  it('stamps the epoch on the wire and on its own record', () => {
    const src = padSrc();
    expect(src).toMatch(/function wireEpoch\(\)/);
    expect(src).toMatch(/if \(wire\) msg\.epoch = wire;/);
    // The same string in both, so the record and the drawing the world
    // admitted can never disagree about which run they belong to.
    expect(src).toMatch(/epoch: wire \|\| null/);
  });

  it('learns the generation from the store even with nothing to heal', () => {
    // `healThenGo` reads the log only when this handset already has a
    // record, so a FIRST-TIME drawer's only source was the retained mqtt
    // announcement — one packet held by one broker, which is not a good
    // enough single point for somebody's drawing now that a drawing with no
    // epoch is refused by a reset world.
    const src = padSrc();
    expect(src).toMatch(/if \(WORLD && !storedSubmission\(\)\) \{/);
    const fn = src.slice(src.indexOf('if (WORLD && !storedSubmission())'));
    expect(fn.slice(0, 900)).toMatch(/learnGeneration\(gen\)/);
  });

  it('asks the world for its epoch as well as waiting to be told', () => {
    // The retained announcement is one packet held by one broker, and the
    // pad now NEEDS the answer: a drawing that cannot say which run it was
    // made in is refused by a world that has been reset.
    expect(padSrc()).toMatch(/type: 'hello'/);
  });
});

/**
 * AND THE HANDSET SIDE, which is where the offer comes FROM.
 *
 * The world's accept is the decision; these are the paths that were spending
 * a packet on a drawing the world would refuse — and one of them, the
 * re-home, fires with nobody pressing anything. Asserted on the source for
 * the same reason as the accept: these are two pages, not two modules.
 */
describe('a handset never offers a drawing from an older run', () => {
  const companion = (): string => readFileSync(join(process.cwd(), 'src/phone/main.ts'), 'utf8');

  it('guards the one function both the recall and the re-home go through', () => {
    const src = companion();
    const fn = src.slice(src.indexOf('const resendMine'), src.indexOf('uplink?.onRecall'));
    expect(fn).toMatch(/admitsDrawing\(epoch, mine\.epoch\)/);
    // And the drawing rides with its own epoch, so the world decides rather
    // than taking the handset's word for it.
    expect(fn).toMatch(/epoch: mine\.epoch \?\? null/);
    // Still never deleted (CLAUDE.md, test/session/recovery.test.ts).
    expect(fn).not.toMatch(/clearSubmission/);
  });

  it('never lets its own record adopt an OLDER generation', () => {
    // The re-home fires on any epoch that merely DIFFERS, so a stale
    // announcement from a projection left open on the last run used to
    // stamp this handset back into that run — after which the next honest
    // announcement would step it down and its own next resend be refused.
    const src = companion();
    expect(src).toMatch(/generationOf\(epoch\) >= generationOf\(mine\.epoch\)/);
  });

  it('steps down in the WORLD VIEW exactly as it does in the companion', () => {
    // `?view=world` on a phone runs src/main.ts, where nothing knew about a
    // reset at all: the tray showed a creature that no longer existed, the
    // stick published drives for it, and the pad still counted that person
    // as having drawn.
    const src = mainSrc();
    expect(src).toMatch(/stepDownOnNewGeneration = \(worldEpoch: string\)/);
    expect(src).toMatch(/generationVerdict\(mySubmission, worldEpoch\) !== 'step-down'/);
    // The same landing as the companion's `stepDownToPad`: the pad, with the
    // world and the room carried along, and `restarted=1` so the note is
    // said on the screen the person arrives at.
    expect(src).toMatch(/restarted=1/);
    // Both places that can learn a new generation feed it: this page's own
    // store pull, and the retained `world` message on the emote uplink.
    expect(src).toMatch(/stepDownOnNewGeneration\(next\)/);
    expect(src).toMatch(
      /uplink\?\.onWorldEpoch\(\(worldEpoch\) => stepDownOnNewGeneration\(worldEpoch\)\)/,
    );
    // And it does not delete anything on the way out.
    const assigned = src.slice(src.indexOf('stepDownOnNewGeneration = ('));
    expect(assigned.slice(0, assigned.indexOf('};'))).not.toMatch(/clearSubmission|removeItem/);
  });

  it('the pad refuses a recall from a world that has started over', () => {
    const src = padSrc();
    const fn = src.slice(src.indexOf('function answerRecall'), src.indexOf('function publish'));
    expect(fn).toMatch(/generationOf\(asking\) > generationOf\(rec\.epoch\)/);
    // The record is never touched — only the offering stops.
    expect(fn).not.toMatch(/removeItem/);
  });

  it('leaves the ?recover=1 link deliberate — it is the operator’s escape hatch', () => {
    // It ignores the age of the record and the room already; a world that
    // has since been reset must not be able to refuse the one link that
    // exists to undo a lost session, so it publishes under the run that is
    // RUNNING and the record adopts it.
    const src = padSrc();
    const fn = src.slice(
      src.indexOf('function recoverFromLink'),
      src.indexOf('function answerRecall'),
    );
    expect(fn).toMatch(/wireEpoch\(\) \? \{ epoch: wireEpoch\(\) \}/);
    expect(fn).not.toMatch(/generationOf/);
  });
});
