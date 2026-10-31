Ranked, conflict-free rewrites of a source text, rendered as format-neutral pieces.

muggle-string has no dependencies and knows no mapping format: a rewrite renders to pieces, new text and ranges of the source, and the consumer turns them into whatever its tooling maps with.

> 1.0 replaces the segment-array helpers of 0.4 (`replace`, `replaceSourceRange`, `toString`, ...). They are gone, not deprecated.

## Model

- The rewrite is itself a writer, and `rewrite.writer(rank)` gives the writer of a rank. A higher rank sits outside a lower one, and the rewrite sits outside all.
- `insertBefore(offset, code)` and `insertAfter(offset, code)` attach code to a side of a char, so it goes wherever that char goes. `replace(start, end, code)` removes the text and puts `code` in the place of its first char.
- Removals add up, so edits of different writers never conflict.
- `rewrite.render(start, end, data, sink)` renders a view of the text: its chars and the edits at them, kept text with `data`. A view owns no text, so views can overlap and render again; a consumer renders the text in the places it chooses by views.
- Text moves only by cuts of parts. `rewrite.root` is the whole text, and `part.cut(start, end, { data, placeholder })` splits a part into `{ before, slice, after }`, which further cuts cut; the part is used up, so cuts nest or are disjoint by construction. A slice renders its text, with the edits of all writers in it, wherever it is placed, exactly once; where it is cut from, `placeholder` renders instead. A slice is a part too, so a cut inside a slice moves with it.
- Text that is not wanted is removed by `replace`. A slice is cut to be placed, and `rewrite.unrendered()` gives the slices that have not rendered, which, after the last render of a consumer, are those that it placed nowhere: a rewrite has no last render, as a slice renders where it is placed or by itself, in any order. A slice placed in code that only its own render renders, as in its own range, is an error at the first render, and a slice that renders a second time is an error then.
- Code before all text (`insertAfter(0, …)`) renders in a view from 0, and code after all text (`insertBefore(length, …)`) in a view to the end of the text.
- The entries of one writer at one side of one char keep call order; code that must go outside them comes from a writer of a higher rank.
- The first render freezes the rewrite.

## Usage

```ts
import { createSourceRewrite, rewritePieceText } from 'muggle-string';

const source = { name: 'main.js', content: 'log(name);\nconst name = "Ada";\n' };
const rewrite = createSourceRewrite<typeof source, string>(source);

for (const { index } of source.content.matchAll(/\bname\b/g)) {
	rewrite.replace(index, index + 'name'.length, 'user');
}

const { slice: declaration } = rewrite.root.cut(source.content.indexOf('const'), source.content.length, {
	data: 'declaration',
});
rewrite.insertBefore(0, declaration);
```

A view of the whole text renders the generated text:

```ts
let output = '';
rewrite.render(0, source.content.length, 'file', piece => output += rewritePieceText(piece));
// const user = "Ada";
// log(user);
```

A source is any object with the `content` that it rewrites, which `rewrite.source` gives, and the ranges of its pieces carry it as their `source`, so a consumer reads their text there. The content must not change until the rewrite is rendered.

## Pieces

```ts
type Piece<Origin = unknown> = string | (Origin & { start: number; end: number; text?: string });
```

A string is new text, which maps nowhere. An object is the range `start`..`end` of a source text: without `text` it copies the text there, and with `text` it is generated text that stands for the range, mapped as the consumer of the pieces decides.

`Origin` is what a range carries beyond its offsets. A producer of one source and no data, such as [muggle-pug](https://github.com/johnsoncodehk/muggle-pug), emits `Piece`, whose ranges are only offsets: its consumer knows the source. The code of a rewrite can mix sources, so its pieces are `Piece<{ source: Source; data: Data }>`, where `Source` is a `RewriteSource`, and its kept text renders as ranges without `text`, with the data of the view or the slice that renders them. `rewritePieceText(piece)` gives the generated text of such a piece: a string, the `text` of a range, or the content of its source that it keeps.

Code is a piece of a rewrite, a slice, which renders its cut in place, or an array of code.

## Rendering

`rewrite.render(start, end, data, sink)` and `slice.render(sink)` pass the pieces of the view or the slice to `sink`, a function of one piece, in order: no string is empty, a piece of code passes through as it is, and kept text is a range without `text`. A consumer that wants an array of pieces pushes them, in place of the render of the usage above:

```ts
import type { Piece } from 'muggle-string';

const pieces: Piece<{ source: typeof source; data: string }>[] = [];
rewrite.render(0, source.content.length, 'file', piece => pieces.push(piece));
```

## Source maps

muggle-string builds no source map, but a sink can. In place of the render of the usage above, this sink tracks the line and column of the generated text and adds v3 segments with [`@jridgewell/gen-mapping`](https://github.com/jridgewell/sourcemaps/tree/main/packages/gen-mapping): new text maps nowhere, the `text` of a range maps as a whole to its start, and kept text maps at the start of each word and each other non-space char: every token maps, not every column. The first range of each source adds its content to the map and computes its line starts, which a binary search reads.

```ts
import { addMapping, GenMapping, setSourceContent, toEncodedMap } from '@jridgewell/gen-mapping';

const map = new GenMapping({ file: 'main.out.js' });
const lineStarts = new WeakMap<typeof source, number[]>();
const toOriginal = (from: typeof source, offset: number) => {
	let starts = lineStarts.get(from);
	if (!starts) {
		starts = [0, ...Array.from(from.content.matchAll(/\n/g), match => match.index + 1)];
		lineStarts.set(from, starts);
		setSourceContent(map, from.name, from.content);
	}
	let low = 0;
	let high = starts.length - 1;
	while (low < high) {
		const mid = (low + high + 1) >> 1;
		if (starts[mid] <= offset) low = mid;
		else high = mid - 1;
	}
	return { line: low + 1, column: offset - starts[low] };
};

let output = '';
let line = 1;
let column = 0;
const advance = (text: string) => {
	const lines = text.split('\n');
	line += lines.length - 1;
	column = (lines.length > 1 ? 0 : column) + lines[lines.length - 1].length;
};
rewrite.render(0, source.content.length, 'file', piece => {
	const value = rewritePieceText(piece);
	const kept = typeof piece !== 'string' && piece.text === undefined;
	let done = 0;
	for (const { index } of kept ? value.matchAll(/\w+|\S/g) : value ? [{ index: 0 }] : []) {
		advance(value.slice(done, index));
		done = index;
		if (typeof piece === 'string') {
			addMapping(map, { generated: { line, column } });
		}
		else {
			const original = toOriginal(piece.source, piece.start + (kept ? index : 0));
			addMapping(map, { generated: { line, column }, source: piece.source.name, original });
		}
	}
	advance(value.slice(done));
	output += value;
});
const sourceMap = toEncodedMap(map);
// {"version":3,"file":"main.out.js","names":[],"sources":["main.js"],"sourcesContent":["log(name);\nconst name = \"Ada\";\n"],"mappings":"AACA,M,KAAW,EAAE,CAAC,GAAG,CAAC;AADlB,GAAG,C,IAAK,CAAC","ignoreList":[]}
```
