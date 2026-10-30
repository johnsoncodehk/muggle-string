Ranked, conflict-free rewrites of a source text, rendered as format-neutral pieces.

muggle-string has no dependencies and knows no mapping format: a rewrite renders to pieces, new text and ranges of the source, and the consumer turns them into whatever its tooling maps with.

> 1.0 replaces the segment-array helpers of 0.4 (`replace`, `replaceSourceRange`, `toString`, ...). They are gone, not deprecated.

## Model

- The rewrite is itself a writer, and `rewrite.writer(rank)` gives the writer of a rank. A higher rank sits outside a lower one, and the rewrite sits outside all.
- `insertBefore(offset, code)` and `insertAfter(offset, code)` attach code to a side of a char, so it goes wherever that char goes. `replace(start, end, code)` removes the text and puts `code` in the place of its first char.
- Removals add up, so edits of different writers never conflict.
- Text moves only by `cut(start, end, { data, placeholder })`, which every writer has. The cuts of all writers are nested or disjoint. A cut renders its text, with the edits of all writers in it, wherever its slice is placed, exactly once; the cut around it renders `placeholder` instead.
- Code at the head or tail of a cut belongs to the outermost cut that has that edge.
- The entries of one writer at one side of one char keep call order; code that must go outside them comes from a writer of a higher rank.
- The first render freezes the rewrite.

## Usage

```ts
import { createSourceRewrite } from 'muggle-string';

const text = 'log(name);\nconst name = "Ada";\n';
const rewrite = createSourceRewrite<string, string>('main.js', text);

for (const { index } of text.matchAll(/\bname\b/g)) {
	rewrite.replace(index, index + 'name'.length, 'user');
}

const file = rewrite.cut(0, text.length, { data: 'file' });
const declaration = rewrite.cut(text.indexOf('const'), text.length, { data: 'declaration' });
rewrite.insertBefore(0, declaration);

let output = '';
file.render({
	text: code => output += code,
	range: (source, start, end, data, code) => output += code ?? text.slice(start, end),
});
// const user = "Ada";
// log(user);
```

## Pieces

```ts
type Piece<Origin = unknown> = string | (Origin & { start: number; end: number; text?: string });
```

A string is new text, which maps nowhere. An object is the range `start`..`end` of a source text: without `text` it copies the text there, and with `text` it is code that stands for the range, mapped as the consumer of the pieces decides.

`Origin` is what a range carries beyond its offsets. A producer of one source and no data, such as [muggle-pug](https://github.com/johnsoncodehk/muggle-pug), emits `Piece`, whose ranges are only offsets: its consumer knows the source. The code of a rewrite can mix sources, so its pieces are `Piece<{ source: Source; data: Data }>`, and its kept text renders as ranges without `text`, with the data of the cut that owns them.

Code is a piece of a rewrite, a slice, which renders its cut in place, or an array of code.

## Rendering

```ts
interface PieceSink<Source, Data> {
	text(text: string): void;
	range(source: Source, start: number, end: number, data: Data, text: string | undefined): void;
}
```

`slice.render(sink)` passes the pieces of the slice to `sink` in order, as arguments rather than objects: `text` for a string, which is never empty, and `range` for a range, whose `text` is undefined for kept text. A consumer that wants an array of pieces collects them in its sink:

```ts
const pieces: Piece<{ source: string; data: string }>[] = [];
slice.render({
	text: text => pieces.push(text),
	range: (source, start, end, data, text) => pieces.push(text === undefined ? { source, start, end, data } : { source, start, end, data, text }),
});
```
