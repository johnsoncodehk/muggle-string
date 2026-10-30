Ranked, conflict-free rewrites of a source text, rendered as format-neutral pieces.

muggle-string has no dependencies and knows no mapping format: a rewrite renders to pieces, new text and ranges of the source, and the consumer turns them into whatever its tooling maps with.

> 1.0 replaces the segment-array helpers of 0.4 (`replace`, `replaceSourceRange`, `toString`, ...). They are gone, not deprecated.

## Model

- Writers have ranks. A higher rank sits outside a lower one, and `core` sits outside all.
- `insertBefore(offset, code)` and `insertAfter(offset, code)` attach code to a side of a char, so it goes wherever that char goes. `replace(start, end, code)` removes the text and puts `code` in the place of its first char.
- Removals add up, so edits of different writers never conflict.
- Text moves only by `cut(start, end, { data, placeholder })`, which every writer has. The cuts of all writers are nested or disjoint. A cut renders its text, with the edits of all writers in it, wherever its slice is placed, exactly once; the cut around it renders `placeholder` instead.
- Code at the head or tail of a cut belongs to the outermost cut that has that edge.
- `order` sorts the entries of one writer at one side of one char; equal keys keep call order.
- The first render freezes the rewrite.

## Usage

```ts
import { createSourceRewrite } from 'muggle-string';

const text = 'log(name);\nconst name = "Ada";\n';
const rewrite = createSourceRewrite<string, string>('main.js', text);
const { core } = rewrite;
const renamer = rewrite.writer(0);

for (const { index } of text.matchAll(/\bname\b/g)) {
	renamer.replace(index, index + 'name'.length, 'user');
}

const file = core.cut(0, text.length, { data: 'file' });
const declaration = core.cut(text.indexOf('const'), text.length, { data: 'declaration' });
core.insertBefore(0, declaration);

const pieces = file.pieces();
// [{ source: 'main.js', start: 11, end: 17, data: 'declaration' }, 'user', ..., { source: 'main.js', start: 0, end: 4, data: 'file' }, ...]
// const user = "Ada";
// log(user);
```

## Pieces

```ts
type Piece<Source, Data> = string | { source: Source; start: number; end: number; data: Data; text?: string };
```

A string is new text, which maps nowhere. An object is the range `start`..`end` of the text of `source`: without `text` it copies the text there, and with `text` it is code that stands for the range, mapped as the consumer of the pieces decides. The kept text of a rewrite renders as pieces without `text`, with the data of the cut that owns them.

Code is a piece, a slice, which renders its cut in place, or an array of code. `slice.pieces(out)` appends to `out` and returns it.
