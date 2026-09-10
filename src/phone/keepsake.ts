/**
 * Taking your creature home.
 *
 * Everything else about this project is a place you visit. The world is on
 * a wall, the companion is a page, and both of them end when the event
 * does. A person who drew something and watched it hatch has nothing
 * afterwards, which is the wrong ending for the one object here that is
 * genuinely theirs (user ask, 2026-09-08).
 *
 * Three ways to keep it, because they are three different wants:
 *
 *   picture   a png of the creature, for the camera roll. The one that
 *             gets shown to somebody else.
 *   model     the actual generated mesh as a glb. Openable in blender or
 *             three — proof that the drawing really did become geometry.
 *   link      a url that opens THIS creature on any device, forever.
 *
 * The link is the one that matters most and costs least. It carries an
 * id, not a drawing: the strokes already live in the world's store, and
 * the pipeline is pure, so `(strokes, id)` rebuilds a byte-identical
 * creature anywhere. Encoding the strokes into the url instead would mean
 * quantizing them to fit, and a quantized stroke list is a DIFFERENT
 * drawing — it would rebuild a creature that is nearly right, which is
 * worse than one that is either right or absent.
 *
 * Nothing here is on the render path. Every export builds its own
 * renderer, takes one frame, and disposes it, so a save can never disturb
 * the portrait the person is looking at.
 */

import { Box3, Color, OrthographicCamera, Scene, Vector3, WebGLRenderer } from 'three';
import { createCharacter } from '../character/character';
import type { StrokeList } from '../shape/types';
import { SURFACE } from '../taste/tokens';
import { GrainPass } from '../world/grain';
import { InkPass } from '../world/ink';
import { createLighting } from '../world/lighting';
import { portraitHalfExtent } from './screens/alive';

/**
 * The keepsake's pixel side.
 *
 * Square, and much bigger than the portrait it is taken from: this is the
 * one render nobody is waiting on a frame budget for, and a picture people
 * keep should survive being looked at on something other than a phone.
 */
export const KEEPSAKE_PX = 1024;

/**
 * How much air is left around the creature.
 *
 * More than the portrait's, on purpose. The portrait lives inside a device
 * that already frames it; a picture on its own has no bezel, and a creature
 * that touches the edge of a png reads as a crop rather than a portrait.
 */
export const KEEPSAKE_MARGIN = 1.32;

/*
 * The link and the filenames live in `keeplink.ts`, which imports nothing.
 * The world page needs `readKeepId` to route a keep link and must not pull
 * a renderer in to get it — re-exported here so this stays the one place
 * anything about keeping a creature is looked up.
 */
export { keepUrl, keepsakeFilename, readKeepId } from './keeplink';

export type DeliveryResult = 'shared' | 'downloaded' | 'opened' | 'failed';

/**
 * Has the share sheet already refused once in this document?
 *
 * Not a preference — a fact about this browser, learned the only way it
 * can be learned. A refusal costs the tap that discovered it (see below),
 * so remembering it is what makes the SECOND tap work instead of failing
 * the same way forever.
 */
let shareRefused = false;

/** Are we the companion inside the world's panel, rather than a page? */
function framed(): boolean {
  try {
    return window.parent !== window;
  } catch {
    // Cross-origin parent: not our panel, so behave as a page.
    return false;
  }
}

/**
 * Put a file where the person can find it, WITHOUT losing the tap.
 *
 * On iOS the share sheet is the only route that reaches the camera roll —
 * a download there lands the file in Files, several taps deep, which for a
 * picture is the same as losing it. So the sheet is tried first whenever
 * the browser says it can carry this file. Everywhere else, and for
 * anything the sheet refuses (it commonly refuses model files), a file is
 * the honest answer and is what a desktop wants anyway.
 *
 * The thing that has to be got right is what happens when the sheet says
 * NO. This used to `await nav.share(...)` and, on rejection, fall through
 * to the download anchor — but by then the tap's user activation has been
 * spent on the share that failed, so the download is refused as well and
 * NOTHING HAPPENS (user report, 2026-09-09: *"the 3d file … isn't
 * working"*). A refusal is now reported as a failure, so the row says `try
 * again` rather than lying, and it is REMEMBERED: the next tap skips the
 * sheet and goes straight to the file with a live gesture behind it.
 *
 * A cancelled share is NOT a failure: the person pressed cancel, they know
 * what happened, and falling through would hand them a file they just
 * declined. `AbortError` is the browser telling us that.
 */
export async function deliver(blob: Blob, filename: string): Promise<DeliveryResult> {
  const nav = navigator as Navigator & {
    canShare?: (data: { files?: File[] }) => boolean;
    share?: (data: { files?: File[]; title?: string }) => Promise<void>;
  };
  const file = new File([blob], filename, { type: blob.type });
  if (!shareRefused && typeof nav.share === 'function' && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file] });
      return 'shared';
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return 'shared';
      shareRefused = true;
      return 'failed';
    }
  }
  return saveFile(blob, filename);
}

/**
 * The file itself — synchronous to the browser call, so it runs on the
 * tap's own activation.
 *
 * Two routes, and the frame is what decides. A `download` anchor is the
 * right one on a page: the browser saves the file under the name it was
 * given and says so. INSIDE THE COMPANION'S IFRAME it is the one most
 * likely to be dropped on the floor — a framed download is blocked
 * outright by some engines, and mobile safari ignores `download` on a blob
 * url and navigates instead, which in a frame means the person's companion
 * goes somewhere rather than the file arriving. So a framed PICTURE opens
 * in a tab of its own, which is also how a person on a phone gets one into
 * their camera roll: press and hold, save image.
 *
 * `window.open` needs the same user activation the anchor does — which is
 * exactly why this is called from the tap and never after an await.
 */
function saveFile(blob: Blob, filename: string): DeliveryResult {
  let url = '';
  try {
    url = URL.createObjectURL(blob);
    // Revoked on a timer rather than immediately — revoking in the same
    // tick cancels the transfer that has only just started.
    const forget = (): void => {
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    };
    /*
     * A PICTURE, in a frame, goes to a tab of its own — and only a
     * picture. `window.open` carries no filename, so a model opened this
     * way arrives as an unnamed blob (measured in chromium: a download
     * called `e16f0657-aedf-…`), which is a worse file than the anchor's
     * named one and no easier to reach. A png in a tab is different: it is
     * the only route from a framed companion to a camera roll, and there
     * is nothing to name because nobody files a picture they are about to
     * press and hold on.
     */
    if (framed() && blob.type.startsWith('image/')) {
      const opened = window.open(url, '_blank');
      if (opened) {
        forget();
        return 'opened';
      }
    }
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    // Appended, because a detached anchor's click is ignored in some
    // browsers.
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    forget();
    return 'downloaded';
  } catch {
    if (url) URL.revokeObjectURL(url);
    return 'failed';
  }
}

/**
 * One creature, built and framed on its own, for an export.
 *
 * Shared by both renders so the picture and the model are provably the
 * same object: one `createCharacter` call, one set of bounds, no chance of
 * the two drifting into different framings or different identities.
 */
function buildForExport(
  strokes: StrokeList,
  identity: string | undefined,
): { character: ReturnType<typeof createCharacter>; bounds: Box3 } | null {
  const character = createCharacter(strokes, 1, {
    bubble: false,
    ...(identity === undefined ? {} : { identity }),
  });
  if (!character) return null;
  return { character, bounds: new Box3().setFromObject(character.group) };
}

/**
 * A png of the creature, on paper.
 *
 * The same recipe as the portrait in the person's hand — same lighting,
 * same ink and grain passes, same paper ground, same head-on orthographic
 * camera so the silhouette is the drawing. It has to be the same picture:
 * the thing they are saving is the thing they have been looking at, and a
 * keepsake rendered through a different chain would be a different
 * creature wearing the same shape.
 *
 * Transparent would be the obvious choice and is the wrong one. The
 * quantizer grades a rendered frame rather than an alpha cut-out, so the
 * ink pass needs paper behind the subject to grade against — on
 * transparency the contour lines and the toon bands come out of a
 * different image than the one on screen.
 */
export async function renderKeepsake(
  strokes: StrokeList,
  identity: string | undefined,
  sidePx: number = KEEPSAKE_PX,
): Promise<Blob | null> {
  const built = buildForExport(strokes, identity);
  if (!built?.character) return null;
  const { character, bounds } = built;

  const canvas = document.createElement('canvas');
  canvas.width = sidePx;
  canvas.height = sidePx;

  let renderer: WebGLRenderer | null = null;
  let ink: InkPass | null = null;
  try {
    renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      /*
       * The frame has to survive being read.
       *
       * Without this the drawing buffer may be cleared the moment the
       * browser composites, and everything about a one-shot export happens
       * around that moment. It costs one extra buffer for the few hundred
       * milliseconds this renderer exists, and the pixels are read straight
       * back below rather than through `canvas.toBlob`, so between the two
       * there is nothing left for a mobile gpu to throw away.
       */
      preserveDrawingBuffer: true,
    });
    // Exactly one device pixel per canvas pixel: the canvas is already the
    // size we want, and a pixel ratio on top of it would render at 2048 and
    // hand back a file twice the size for no visible gain.
    renderer.setPixelRatio(1);
    renderer.setSize(sidePx, sidePx, false);

    const scene = new Scene();
    scene.background = new Color(SURFACE.ground);
    scene.add(createLighting().group, character.group);

    const size = bounds.getSize(new Vector3());
    const centre = bounds.getCenter(new Vector3());
    const half = portraitHalfExtent(size.x, size.y) * KEEPSAKE_MARGIN;
    const camera = new OrthographicCamera(-half, half, half, -half, 0.1, 100);
    camera.position.set(centre.x, centre.y, 12);
    camera.lookAt(centre.x, centre.y, 0);

    ink = new InkPass();
    const grain = new GrainPass();
    /*
     * SIZE THE PASSES. Measured cause of the blank keepsake (user report,
     * 2026-09-09, from a real handset: *"the photo in particular is
     * blank"*).
     *
     * Both passes build their render targets at 1x1 in their constructors
     * and only get their real measure from `setSize` — the alive screen
     * calls it from `sizePortrait` on every layout, which is why the
     * portrait in the person's hand has always been right. This path never
     * called it. So the whole scene was rendered into a ONE PIXEL target
     * and that pixel was stretched over the export: measured at 256px, the
     * saved png held 19 distinct colours, zero ink pixels, and a flat
     * rgb(144,144,139) — not even the paper value. Every picture anybody
     * has saved has been that square.
     *
     * Pixel ratio 1, to match `setPixelRatio` above: the canvas is already
     * the pixel size we want.
     */
    ink.setSize(sidePx, sidePx, 1);
    grain.setSize(sidePx, sidePx, 1);

    // One frame, at a fixed time. The ambient drift and the grain are both
    // time-driven, and a keepsake should be reproducible: the same creature
    // saved twice is the same picture, not two frames of an animation.
    const at = 0;
    character.update(0, at);
    grain.compose(renderer, ink.render(renderer, scene, camera, at), at);

    /*
     * Read the pixels back HERE, in the same task as the draw call, off the
     * default framebuffer the grain pass just composed into.
     *
     * `canvas.toBlob` is asynchronous, and on a handset the gap between the
     * render and the callback is exactly where the drawing buffer goes
     * away. `readPixels` is synchronous and returns the frame that was just
     * drawn; from there the picture lives in a 2d canvas, which has no
     * drawing buffer to lose.
     */
    const gl = renderer.getContext();
    const pixels = new Uint8Array(sidePx * sidePx * 4);
    gl.readPixels(0, 0, sidePx, sidePx, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    if (!frameHasInk(pixels)) return null;

    const flat = document.createElement('canvas');
    flat.width = sidePx;
    flat.height = sidePx;
    const flatCtx = flat.getContext('2d');
    if (!flatCtx) return null;
    const image = flatCtx.createImageData(sidePx, sidePx);
    // gl reads bottom-up; a png is top-down. One row copy each way.
    const stride = sidePx * 4;
    for (let y = 0; y < sidePx; y++) {
      image.data.set(pixels.subarray((sidePx - 1 - y) * stride, (sidePx - y) * stride), y * stride);
    }
    flatCtx.putImageData(image, 0, 0);

    return await new Promise<Blob | null>((resolve) => {
      flat.toBlob((blob) => resolve(blob), 'image/png');
    });
  } catch {
    return null;
  } finally {
    // The context is a real gpu resource on a handset that has two others
    // running. It goes back whether or not the render worked.
    ink?.dispose();
    renderer?.dispose();
    character?.dispose?.();
  }
}

/**
 * Is there a creature in this frame, or is it an empty square?
 *
 * A keepsake is a near-black silhouette on paper, so a frame with no dark
 * pixels in it is not a picture of anything — it is the failure mode this
 * export shipped with, and it is indistinguishable from success to
 * everything downstream: a flat grey png is a perfectly valid png, it
 * shares, it downloads, it lands in the camera roll. Checking the pixels is
 * the only thing that can tell the two apart, so it is checked here and a
 * blank frame is a FAILED render — the row says `try again`, which is true,
 * instead of handing somebody an empty square and calling it saved.
 *
 * The threshold is a fraction of the frame rather than a single pixel: one
 * stray dark texel is noise, and a creature at any size covers far more
 * than a two-thousandth of the picture it is the subject of.
 *
 * Exported because it is the only part of the export chain that can be
 * checked without a gpu, and it is the part that decides whether a person
 * is told the truth.
 */
export function frameHasInk(pixels: Uint8Array): boolean {
  const threshold = Math.max(16, Math.floor(pixels.length / 4 / 2000));
  let dark = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i]! < 90 && pixels[i + 1]! < 90 && pixels[i + 2]! < 90) {
      dark++;
      if (dark >= threshold) return true;
    }
  }
  return false;
}

/**
 * The creature as a glb — the mesh itself, not a picture of it.
 *
 * Binary rather than embedded-json gltf: it is roughly a third of the size
 * for the same content, and every tool that opens one opens the other.
 *
 * The exporter is loaded on DEMAND. It is about 35KB and belongs to a
 * button most people will never press, so it has no business in the bundle
 * that has to boot before somebody can draw.
 */
export async function exportGlb(
  strokes: StrokeList,
  identity: string | undefined,
): Promise<Blob | null> {
  const built = buildForExport(strokes, identity);
  if (!built?.character) return null;
  const { character } = built;
  try {
    const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
    const exporter = new GLTFExporter();
    const result = await exporter.parseAsync(character.group, { binary: true });
    // `binary: true` resolves an ArrayBuffer; the json branch cannot be
    // reached here, but it is checked rather than asserted because a
    // wrong answer would produce a file that silently will not open.
    if (!(result instanceof ArrayBuffer)) return null;
    return new Blob([result], { type: 'model/gltf-binary' });
  } catch {
    return null;
  } finally {
    character?.dispose?.();
  }
}
