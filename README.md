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
import { createSourceRewrite, rewritePieceText } from 'muggle-string';

const source = { name: 'main.js', content: 'log(name);\nconst name = "Ada";\n' };
const rewrite = createSourceRewrite<typeof source, string>(source);

for (const { index } of source.content.matchAll(/\bname\b/g)) {
	rewrite.replace(index, index + 'name'.length, 'user');
}

const file = rewrite.cut(0, source.content.length, { data: 'file' });
const declaration = rewrite.cut(source.content.indexOf('const'), source.content.length, { data: 'declaration' });
rewrite.insertBefore(0, declaration);

let output = '';
file.render(piece => output += rewritePieceText(piece));
// const user = "Ada";
// log(user);
```

A source is any object with the `content` that it rewrites, and the ranges of its pieces carry it as their `source`, so a consumer reads their text there. The content must not change until the rewrite is rendered.

## Pieces

```ts
type Piece<Origin = unknown> = string | (Origin & { start: number; end: number; text?: string });
```

A string is new text, which maps nowhere. An object is the range `start`..`end` of a source text: without `text` it copies the text there, and with `text` it is generated text that stands for the range, mapped as the consumer of the pieces decides.

`Origin` is what a range carries beyond its offsets. A producer of one source and no data, such as [muggle-pug](https://github.com/johnsoncodehk/muggle-pug), emits `Piece`, whose ranges are only offsets: its consumer knows the source. The code of a rewrite can mix sources, so its pieces are `Piece<{ source: Source; data: Data }>`, where `Source` is a `RewriteSource`, and its kept text renders as ranges without `text`, with the data of the cut that owns them. `rewritePieceText(piece)` gives the generated text of such a piece: a string, the `text` of a range, or the content of its source that it keeps.

Code is a piece of a rewrite, a slice, which renders its cut in place, or an array of code.

## Rendering

`slice.render(sink)` passes the pieces of the slice to `sink`, a function of one piece, in order: no string is empty, a piece of code passes through as it is, and kept text is a range without `text`. A consumer that wants an array of pieces pushes them:

```ts
const pieces: Piece<{ source: string; data: string }>[] = [];
slice.render(piece => pieces.push(piece));
```

## Source maps

muggle-string builds no source map, but a sink can. In place of the sink of the usage above, this one tracks the line and column of the generated text and adds v3 segments with [`@jridgewell/gen-mapping`](https://github.com/jridgewell/sourcemaps/tree/main/packages/gen-mapping): new text maps nowhere, the `text` of a range maps as a whole to its start, and kept text maps at the start of each of its lines, so every column of it maps. The line starts of each source are computed once, by the source that a range carries.

```ts
import { addMapping, GenMapping, toEncodedMap } from '@jridgewell/gen-mapping';

const lineStarts = new WeakMap<typeof source, number[]>();
const toOriginal = (from: typeof source, offset: number) => {
	let starts = lineStarts.get(from);
	if (!starts) {
		starts = [0, ...Array.from(from.content.matchAll(/\n/g), match => match.index + 1)];
		lineStarts.set(from, starts);
	}
	let line = starts.length - 1;
	while (starts[line] > offset) line--;
	return { line: line + 1, column: offset - starts[line] };
};

const map = new GenMapping({ file: 'main.out.js' });
let output = '';
let line = 1;
let column = 0;
file.render(piece => {
	const value = rewritePieceText(piece);
	const kept = typeof piece !== 'string' && piece.text === undefined;
	let offset = 0;
	value.split('\n').forEach((part, i) => {
		if (i) {
			line++;
			column = 0;
		}
		if (part && typeof piece === 'string' && i === 0) {
			addMapping(map, { generated: { line, column } });
		}
		else if (part && typeof piece !== 'string' && (i === 0 || kept)) {
			const original = toOriginal(piece.source, piece.start + (kept ? offset : 0));
			addMapping(map, { generated: { line, column }, source: piece.source.name, original });
		}
		offset += part.length + 1;
		column += part.length;
	});
	output += value;
});
const sourceMap = toEncodedMap(map);
// {"version":3,"file":"main.out.js","sources":["main.js"],"mappings":"AACA,M,IAAU;AADV,I,IAAQ",...}
```
