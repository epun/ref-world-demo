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

export type DeliveryResult = 'shared' | 'downloaded' | 'failed';

/**
 * Put a file where the person can find it.
 *
 * Two routes, and which one is right depends entirely on the handset.
 *
 * On iOS the share sheet is the ONLY route that reaches the camera roll —
 * a download link there lands the file in Files, several taps deep, which
 * for a picture is the same as losing it. So the share sheet is tried
 * first whenever the browser says it can carry this file.
 *
 * Everywhere else, and for anything the share sheet refuses (it commonly
 * refuses model files), a download is the honest answer and is what a
 * desktop wants anyway.
 *
 * A cancelled share is NOT a failure: the person pressed cancel, they know
 * what happened, and falling through to a download would hand them a file
 * they just declined. `AbortError` is the browser telling us that.
 */
export async function deliver(blob: Blob, filename: string): Promise<DeliveryResult> {
  const nav = navigator as Navigator & {
    canShare?: (data: { files?: File[] }) => boolean;
    share?: (data: { files?: File[]; title?: string }) => Promise<void>;
  };
  const file = new File([blob], filename, { type: blob.type });
  if (typeof nav.share === 'function' && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file] });
      return 'shared';
    } catch (err) {
      // Cancelled. Nothing went wrong and nothing else should happen.
      if (err instanceof Error && err.name === 'AbortError') return 'shared';
      // Anything else: fall through and try the download.
    }
  }
  try {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    // Appended, because a detached anchor's click is ignored in some
    // browsers, and revoked on a timer rather than immediately — revoking
    // in the same tick cancels the download that has only just started.
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return 'downloaded';
  } catch {
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
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false });
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

    const ink = new InkPass();
    const grain = new GrainPass();
    // One frame, at a fixed time. The ambient drift and the grain are both
    // time-driven, and a keepsake should be reproducible: the same creature
    // saved twice is the same picture, not two frames of an animation.
    const at = 0;
    character.update(0, at);
    grain.compose(renderer, ink.render(renderer, scene, camera, at), at);

    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), 'image/png');
    });
  } catch {
    return null;
  } finally {
    // The context is a real gpu resource on a handset that has two others
    // running. It goes back whether or not the render worked.
    renderer?.dispose();
    character?.dispose?.();
  }
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
