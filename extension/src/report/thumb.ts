// Session thumbnail: first screenshot if there is one, otherwise a decoded video frame (WebCodecs), cached in OPFS.
import { dbIndexAll } from '../storage/db';
import { opfsExists, opfsRead, opfsWrite } from '../storage/opfs';
import { readSegment, segmentsOfSession } from '../storage/segments';
import type { ScreenshotItem } from '../shared/types';

const urls = new Map<string, string | null>();

async function videoFrameThumb(sessionId: string): Promise<Blob | null> {
  const segs = await segmentsOfSession(sessionId);
  if (!segs.length || typeof VideoDecoder === 'undefined') return null;
  const seg = segs[Math.floor(segs.length / 2)]; // a frame from the middle of the evidence is more telling than the first
  const chunks = await readSegment(seg.id);
  const key = chunks.find((c) => c.key);
  if (!key) return null;
  return new Promise<Blob | null>((resolve) => {
    let done = false;
    const finish = (b: Blob | null) => {
      if (!done) {
        done = true;
        resolve(b);
      }
    };
    const dec = new VideoDecoder({
      output: (frame) => {
        const w = 360, h = Math.round((frame.displayHeight / frame.displayWidth) * w);
        const c = new OffscreenCanvas(w, h);
        c.getContext('2d')!.drawImage(frame, 0, 0, w, h);
        frame.close();
        c.convertToBlob({ type: 'image/jpeg', quality: 0.82 }).then(finish, () => finish(null));
      },
      error: () => finish(null),
    });
    try {
      dec.configure({ codec: seg.codec, codedWidth: seg.width, codedHeight: seg.height });
      dec.decode(new EncodedVideoChunk({ type: 'key', timestamp: 0, data: key.data }));
      void dec.flush().catch(() => finish(null));
    } catch {
      finish(null);
    }
    setTimeout(() => finish(null), 4000);
  });
}

/** Object URL of a thumbnail for the session, or null when there is nothing to show. */
export async function sessionThumb(sessionId: string): Promise<string | null> {
  if (urls.has(sessionId)) return urls.get(sessionId)!;
  let url: string | null = null;
  try {
    const shots = (await dbIndexAll<ScreenshotItem>('shots', 'sessionId', sessionId)).sort((a, b) => a.ts - b.ts);
    if (shots[0]) url = URL.createObjectURL(await opfsRead(shots[0].file));
    else {
      const path = `thumbs/${sessionId}.jpg`;
      if (!(await opfsExists(path))) {
        const blob = await videoFrameThumb(sessionId);
        if (blob) await opfsWrite(path, blob);
      }
      if (await opfsExists(path)) url = URL.createObjectURL(await opfsRead(path));
    }
  } catch {
    url = null;
  }
  urls.set(sessionId, url);
  return url;
}
