// Central input-size and safety limits (defence against oversized / hostile files).
// Mirrors limits.py.
export const MAX_INPUT_BYTES = 600 * 1024 * 1024;          // one uploaded / downloaded file
export const MAX_ARCHIVE_MEMBER_BYTES = 800 * 1024 * 1024; // decompressed size of one archive member
export const MAX_ARCHIVE_ENTRIES = 5000;                   // files listed in one archive
export const MAX_ARCHIVE_DEPTH = 2;                        // archives inside archives (zip -> tar.gz)
export const MAX_PACKAGE_BYTES = 1200 * 1024 * 1024;       // everything unpacked from one data package
export const MAX_JSON_BYTES = 150 * 1024 * 1024;           // one JSON feed
export const MAX_BAD_LINE_FRACTION = 0.01;                 // tolerated malformed tracking lines

/** Error for malformed or unsafe input; the UI shows ``message`` to the user. */
export class InputError extends Error {
  constructor(message) { super(message); this.name = 'InputError'; }
}
