# Changelog

## Unreleased

### Breaking

- `RewriteSlice.pieces(out?)` is replaced by `RewriteSlice.render(sink)`. A render passes each piece to `sink.text(text)` or `sink.range(source, start, end, data, text)` instead of appending a piece object to an array; collecting an array is one sink (see the README). A range piece passed as code reaches the sink as its fields, not as the same object.
- `rewrite.writer(rank)` returns the same writer for the same rank.

### Performance

- Edits are stored by column per writer and merged while rendering; a render allocates no piece objects. Against 1.0.0-alpha.1, on 100k-line workloads, rendering text takes 26-43% less CPU time and recording retains 39-75% less memory.
