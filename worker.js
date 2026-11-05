// Builds avatar and outfit meshes off the main thread so the page stays responsive.
import { makeAvatar, makeOutfit } from './tailor.js';

function buffers(o, out = new Set()) {
  if (!o || typeof o !== 'object') return out;
  if (ArrayBuffer.isView(o)) { out.add(o.buffer); return out; }
  for (const k in o) buffers(o[k], out);
  return out;
}

self.onmessage = (e) => {
  const { id, kind, gender, outfit } = e.data;
  try {
    const res = kind === 'avatar' ? makeAvatar(gender) : makeOutfit(gender, outfit);
    self.postMessage({ id, res }, [...buffers(res)]);
  } catch (err) {
    self.postMessage({ id, error: String((err && err.stack) || err) });
  }
};
