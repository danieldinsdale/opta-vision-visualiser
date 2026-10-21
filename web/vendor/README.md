# Vendored third-party scripts

Bundled so the page makes **no third-party requests** at runtime (no CDN), and so the exact
files that run are reviewable in the repository. They are loaded only when needed.

| File | Project | Version | Licence | Used for |
|------|---------|---------|---------|----------|
| `three.min.js`, `OrbitControls.js` | [three.js](https://github.com/mrdoob/three.js) | 0.128.0 | MIT (`three.js.LICENSE`) | 3D view |
| `gif.js`, `gif.worker.js` | [gif.js](https://github.com/jnordberg/gif.js) | 0.2.0 | MIT | GIF export |
| `hls.min.js` | [hls.js](https://github.com/video-dev/hls.js) | 1.7.3 | Apache-2.0 (`hls.js.LICENSE`) | HLS (.m3u8) video, only if a VOD URL is set |

Files are unmodified copies of the packages published on npm. To update, replace the files
from the same package versions and update this table.
