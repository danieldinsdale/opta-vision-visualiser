"""Central input-size and safety limits (defence against oversized / hostile files)."""

# Largest single input accepted from an upload or from a remote download.
MAX_INPUT_BYTES = 600 * 1024 * 1024
# Largest single member read out of an uploaded archive (decompressed size).
MAX_ARCHIVE_MEMBER_BYTES = 800 * 1024 * 1024
# Largest JSON feed (events / lineup / phases / runs) accepted.
MAX_JSON_BYTES = 150 * 1024 * 1024
# Network timeout (seconds) for every outbound request.
HTTP_TIMEOUT_S = 30
# Fraction of malformed tracking lines tolerated before the file is rejected.
MAX_BAD_LINE_FRACTION = 0.01
