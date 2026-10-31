Rewrite a source text from several places at once, and map the result back to the source.

muggle-string is for compilers where several features edit and move the same text, and where the output must map back precisely for debuggers and language tools. It has no dependencies.

> 1.0 replaces the segment-array helpers of 0.4 (`replace`, `replaceSourceRange`, `toString`, ...). They are gone, not deprecated.

## Usage

```ts
import { createSourceRewrite, rewritePieceText } from 'muggle-string';

const source = { name: 'main.js', content: 'log(name);\nconst name = "Ada";\n' };
const rewrite = createSourceRewrite<typeof source, { data: string; name?: string }>(source);

for (const { index: start } of source.content.matchAll(/\bname\b/g)) {
	const end = start + 'name'.length;
	rewrite.replace(start, end, { source, start, end, text: 'user', name: 'name', data: 'rename' });
}

const declaration = rewrite.cut(source.content.indexOf('const'), source.content.length, { data: 'declaration' });
rewrite.insertBefore(0, declaration);
```

Render the whole text:

```ts
let output = '';
rewrite.render(0, source.content.length, piece => output += rewritePieceText(piece), { data: 'file' });
// const user = "Ada";
// log(user);
```

A source is any object with `content`. Do not change the content until the rewrite is rendered.

## Editing

- `insertBefore(offset, code)` attaches code to the char at `offset`, and `insertAfter(offset, code)` to the char before it. The code moves with that char.
- `replace(start, end, code)` removes `start`..`end` and puts `code` in its place. An empty range throws.
- Removals add up. Two writers can remove overlapping text, or replace the same range, and both edits apply.
- `rewrite.writer(rank)` gives a writer with its own rank. At one position, code of a higher rank goes outside code of a lower rank, whatever order the writers ran in. The rewrite itself is the outermost writer. Code of one writer at one position keeps call order.
- `rewrite.cut(start, end, options)` takes a range out and returns a slice. The slice renders the range, with every edit inside it, where you place it, as `insertBefore(0, declaration)` does in the usage. `options.placeholder` renders where the range was.
- Cuts can be made in any order. A cut inside another moves with it. A cut that crosses another throws, naming both ranges.
- A slice renders exactly once. Rendering it again throws. A slice placed inside its own range throws at the first render. `rewrite.unrendered()` lists the slices that have not rendered yet.
- The first render freezes the rewrite. Later edits throw.

The tests in `tests/` check these rules with random edits, and check every generated char of the source maps.

## Rendering

`rewrite.render(start, end, sink, data)` passes the pieces of `start`..`end` to `sink`, in order. You can render several ranges, and they may overlap. Code inserted before all text (`insertAfter(0, …)`) renders with a range that starts at 0, and code after all text with a range that ends at the end.

## Pieces

```ts
type Piece<Origin = unknown> = string | (Origin & { start: number; end: number; text?: string });
```

- A string is new text. It maps nowhere.
- A range without `text` keeps the source text at `start`..`end`.
- A range with `text` is generated text that stands for `start`..`end`.

The ranges of a rewrite also carry their `source` and the fields of `Data`. Kept text gets the `data` passed to `render` or `cut`. The ranges you write carry what you put on them, like `name` and `data` in the usage. `rewritePieceText(piece)` gives the text of any piece. A producer of one source, such as [muggle-pug](https://github.com/johnsoncodehk/muggle-pug), can emit plain `Piece` ranges without a `source`.

To collect the pieces:

```ts
import type { Piece, RewriteOrigin } from 'muggle-string';

const pieces: Piece<RewriteOrigin<typeof source, { data: string; name?: string }>>[] = [];
rewrite.render(0, source.content.length, piece => pieces.push(piece), { data: 'file' });
```

## Source maps

```ts
import { renderWithSourceMap } from 'muggle-string';

const { text: output, map: sourceMap } = renderWithSourceMap(
	sink => rewrite.render(0, source.content.length, sink, { data: 'file' }),
	(from: typeof source) => from.name,
);
// {"version":3,"sources":["main.js"],"sourcesContent":["log(name);\nconst name = \"Ada\";\n"],"names":["name"],"mappings":"AACA,KAAK,CAACA,IAAI,CAAC,CAAC,CAAC,CAAC,GAAG,CAAC;AADlB,GAAG,CAACA,IAAI,CAAC;"}
```

- Kept text maps at the start of each line, word, run of whitespace, and every other char. A word is a run of Unicode letters, marks and digits. Chars like `_`, `$` and `-` map on their own, because languages disagree on whether they belong to a name.
- So positions at token starts map exactly in JavaScript, TypeScript, HTML and CSS. Breakpoints, stack traces and coverage read those positions. A position inside a word maps to the start of the word.
- The `text` of a range maps to the start of the range.
- New text maps nowhere, also for tools that look back across lines, as V8 does.
- The `name` of a range goes into `names`. Set it only when `text` renames the identifier at the range. A name on text that starts with another identifier, such as `__props.x` for `x`, makes a debugger show `__props` as `x`. muggle-string adds no names itself.

## Span mappings

Language tools, such as Vue language-tools, map generated code by spans. A Verbatim span maps each offset to the same offset in the original range. An Atom span maps its ends to the ends of the original range, and every offset inside it to the original start. A kept range is a Verbatim span, and a range with `text` is an Atom span:

```ts
type Span = { virtualStart: number; virtualEnd: number; originalStart: number; originalEnd: number; kind: 'Verbatim' | 'Atom' };

const spans: Span[] = [];
let virtualStart = 0;
rewrite.render(0, source.content.length, piece => {
	const { length } = rewritePieceText(piece);
	if (typeof piece !== 'string') {
		const kind = piece.text === undefined ? 'Verbatim' : 'Atom';
		spans.push({ virtualStart, virtualEnd: virtualStart + length, originalStart: piece.start, originalEnd: piece.end, kind });
	}
	virtualStart += length;
}, { data: 'file' });
// {"virtualStart":0,"virtualEnd":6,"originalStart":11,"originalEnd":17,"kind":"Verbatim"}
// {"virtualStart":6,"virtualEnd":10,"originalStart":17,"originalEnd":21,"kind":"Atom"}
// {"virtualStart":10,"virtualEnd":20,"originalStart":21,"originalEnd":31,"kind":"Verbatim"}
// {"virtualStart":20,"virtualEnd":24,"originalStart":0,"originalEnd":4,"kind":"Verbatim"}
// {"virtualStart":24,"virtualEnd":28,"originalStart":4,"originalEnd":8,"kind":"Atom"}
// {"virtualStart":28,"virtualEnd":31,"originalStart":8,"originalEnd":11,"kind":"Verbatim"}
```

A `text` as long as its range, whose offsets line up, such as a rename to a name of the same length, can be a Verbatim span instead. Vue language-tools does this, so an edit inside the name maps back.

## Performance

Measured with Node 24 on an Apple M2:

- A 1 MB text with 100,000 edits takes 19 ms to edit, 32 ms to render, and 96 ms to render with a source map.
- Edit time is linear: about 200 ns per edit, from 1,000 to 100,000 edits.
- In the script compiler of Vue single-file components, on 400 real components, muggle-string takes about 8 µs per component, most of it for the source map.
