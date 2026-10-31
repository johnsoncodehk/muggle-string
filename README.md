Ranked, conflict-free rewrites of a source text, rendered as format-neutral pieces.

muggle-string has no dependencies and knows no mapping format: a rewrite renders to pieces, new text and ranges of the source, and the consumer turns them into whatever its tooling maps with.

> 1.0 replaces the segment-array helpers of 0.4 (`replace`, `replaceSourceRange`, `toString`, ...). They are gone, not deprecated.

## Model

- The rewrite is itself a writer, and `rewrite.writer(rank)` gives the writer of a rank. A higher rank sits outside a lower one, and the rewrite sits outside all.
- `insertBefore(offset, code)` and `insertAfter(offset, code)` attach code to a side of a char, so it goes wherever that char goes. `replace(start, end, code)` removes the text and puts `code` in the place of its first char.
- Removals add up, so edits of different writers never conflict.
- `rewrite.render(start, end, sink, data)` renders a view of the text: its chars and the edits at them, kept text with the fields of `data`. A view owns no text, so views can overlap and render again; a consumer renders the text in the places it chooses by views.
- Text moves only by cuts. `rewrite.cut(start, end, { ...data, placeholder })` gives the slice of a range, which renders its text, with the edits of all writers in it, wherever it is placed, exactly once, kept text with the fields of `data`; where it is cut from, `placeholder` renders instead. Cuts are made in any order and nest by range: a cut inside another moves with it, of two cuts of one range the later is inside, and a cut that crosses another is an error.
- Text that is not wanted is removed by `replace`. A slice is cut to be placed, and `rewrite.unrendered()` gives the slices that have not rendered, which, after the last render of a consumer, are those that it placed nowhere: a rewrite has no last render, as a slice renders where it is placed or by itself, in any order. A slice placed in code that only its own render renders, as in its own range, is an error at the first render, and a slice that renders a second time is an error then.
- Code before all text (`insertAfter(0, …)`) renders in a view from 0, and code after all text (`insertBefore(length, …)`) in a view to the end of the text.
- The entries of one writer at one side of one char keep call order; code that must go outside them comes from a writer of a higher rank.
- The first render freezes the rewrite.

## Usage

```ts
import { createSourceRewrite, rewritePieceText } from 'muggle-string';

const source = { name: 'main.js', content: 'log(name);\nconst name = "Ada";\n' };
const rewrite = createSourceRewrite<typeof source, { data: string }>(source);

for (const { index } of source.content.matchAll(/\bname\b/g)) {
	rewrite.replace(index, index + 'name'.length, 'user');
}

const declaration = rewrite.cut(source.content.indexOf('const'), source.content.length, { data: 'declaration' });
rewrite.insertBefore(0, declaration);
```

A view of the whole text renders the generated text:

```ts
let output = '';
rewrite.render(0, source.content.length, piece => output += rewritePieceText(piece), { data: 'file' });
// const user = "Ada";
// log(user);
```

A source is any object with the `content` that it rewrites, which `rewrite.source` gives, and the ranges of its pieces carry it as their `source`, so a consumer reads their text there. The content must not change until the rewrite is rendered.

## Pieces

```ts
type Piece<Origin = unknown> = string | (Origin & { start: number; end: number; text?: string });
```

A string is new text, which maps nowhere. An object is the range `start`..`end` of a source text: without `text` it copies the text there, and with `text` it is generated text that stands for the range, mapped as the consumer of the pieces decides.

`Origin` is what a range carries beyond its offsets. A producer of one source and no data, such as [muggle-pug](https://github.com/johnsoncodehk/muggle-pug), emits `Piece`, whose ranges are only offsets: its consumer knows the source. The code of a rewrite can mix sources, so its pieces are `Piece<RewriteOrigin<Source, Data>>`, `Data & { source: Source }`, where `Source` is a `RewriteSource` and `Data` is the fields of the consumer that its cuts and views give, none by default, so a rewrite that has none writes none; its kept text renders as ranges without `text`, with the fields of the view or the slice that renders them. `rewritePieceText(piece)` gives the generated text of such a piece: a string, the `text` of a range, or the content of its source that it keeps.

Code is a piece of a rewrite, a slice, which renders its cut in place, or an array of code.

## Rendering

`rewrite.render(start, end, sink, data)` and `slice.render(sink)` pass the pieces of the view or the slice to `sink`, a function of one piece, in order: no string is empty, a piece of code passes through as it is, and kept text is a range without `text`. A consumer that wants an array of pieces pushes them, in place of the render of the usage above:

```ts
import type { Piece, RewriteOrigin } from 'muggle-string';

const pieces: Piece<RewriteOrigin<typeof source, { data: string }>>[] = [];
rewrite.render(0, source.content.length, piece => pieces.push(piece), { data: 'file' });
```

## Source maps

`renderWithSourceMap(render, name)` gives the generated text of the pieces that `render` passes to its sink, and a v3 source map of it, with the content of each source under the name that `name` gives it. In place of the render of the usage above:

```ts
import { renderWithSourceMap } from 'muggle-string';

const { text: output, map: sourceMap } = renderWithSourceMap(
	sink => rewrite.render(0, source.content.length, sink, { data: 'file' }),
	(from: typeof source) => from.name,
);
// {"version":3,"sources":["main.js"],"sourcesContent":["log(name);\nconst name = \"Ada\";\n"],"names":[],"mappings":"AACA,CAAC,CAAC,CAAC,CAAC,CAAC,C,IAAK,CAAC,CAAC,CAAC,CAAC,CAAC,CAAC,CAAC,CAAC;AADlB,CAAC,CAAC,CAAC,C,IAAK,CAAC;"}
```

Each kept char maps to itself, so a position anywhere in kept text, as the end of a range, maps exactly. The `text` of a range maps as a whole to the start of the range, at the start of each of its lines. New text maps nowhere: where it follows mapped text on a line, a segment without a source ends that mapping, so a lookup in it finds no original position rather than the one of the text before it.
