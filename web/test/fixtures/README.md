# Test fixtures

Small, fully synthetic inputs (no real match data) and the animation payload they should produce.

`expected_payload.json` was generated once by the original Python implementation that this
JavaScript code replaced, so `pipeline.test.mjs` doubles as a regression test against that
behaviour. It is checked with a small numeric tolerance (positions can differ by 0.01 m at rounding
ties). Do not regenerate it casually: if the output must change on purpose, update the file by
running the JS pipeline on these inputs and review the diff.
