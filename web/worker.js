// Runs the (CPU-heavy) parsing off the main thread so the page stays responsive on big files.
import { buildMatchPayload } from './lib/pipeline.js';

self.onmessage = async ({ data }) => {
  try {
    const result = await buildMatchPayload(data.inputs, data.options, (text) => self.postMessage({ type: 'progress', text }));
    self.postMessage({ type: 'done', ...result });
  } catch (e) {
    // InputError messages are written for users; anything else is logged and shown generically.
    const known = e && e.name === 'InputError';
    if (!known) console.error(e);
    self.postMessage({ type: 'error', message: known ? e.message : 'Unexpected error while loading the data. See the browser console for details.' });
  }
};
