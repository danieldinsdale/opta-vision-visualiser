// VOD (video) plugin point - placeholder.
//
// No video service is bundled: licensed streams are not available to public users. To connect
// your own, replace the body of getVodUrls (or point main.js at another module). It receives
// the match context and returns an object mapping period number -> https stream URL (MP4 or
// HLS .m3u8), or null/undefined when no video is available:
//
//   export async function getVodUrls({ matchUuid, periods }) {
//     const res = await fetch(`/my-video-service/${matchUuid}`);   // your service, your auth
//     const { period1, period2 } = await res.json();
//     return { 1: period1, 2: period2 };
//   }
//
// Keep credentials server-side. URLs returned here are validated (https only, no embedded
// credentials) before they reach the <video> element. URLs typed into the sidebar take
// precedence over this function.
export async function getVodUrls(/* { matchUuid, periods } */) {
  return null;
}

/** Returns ``url`` if it is a plain https URL without embedded credentials, else throws. */
export function validateStreamUrl(url) {
  const value = (url || '').trim();
  if (!value || value.length > 4096) throw new Error('VOD URL is empty or too long');
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('VOD URL is not a valid URL'); }
  if (parsed.protocol !== 'https:' || !parsed.hostname) throw new Error('VOD URL must start with https://');
  if (parsed.username || parsed.password) throw new Error('VOD URL must not contain embedded credentials');
  return value;
}
