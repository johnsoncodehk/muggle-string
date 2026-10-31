Ranked, conflict-free rewrites of a source text, rendered as format-neutral pieces.

muggle-string has no dependencies. A rewrite renders to pieces, new text and ranges of the source, which a consumer turns into whatever its tooling maps with, or `renderWithSourceMap` turns into a v3 source map.

> 1.0 replaces the segment-array helpers of 0.4 (`replace`, `replaceSourceRange`, `toString`, ...). They are gone, not deprecated.

## Why

A compiler that rewrites a source text often has several passes, or several features, that edit the same text, move parts of it, and need the result mapped back for tooling and debuggers. muggle-string is built for that case, on three properties.

### Edits that compose

- Edits of different writers never conflict. Removals add up as a union of ranges, and inserts attach to a side of a char, so no edit can be refused because of another. The tests render random edits of several writers and check that every kept char renders once, in order and verbatim, and every code once.
- Order is explicit. Code at one place renders by the rank of its writer, then by call order within a writer, so the result does not depend on which feature ran first. The tests check that random edits render the same whatever order the writers register in.
- Moves are structural. Text moves only by cuts, which nest by range in any order; a cut that crosses another is an error that names both ranges, and so is a slice that renders twice; a slice placed nowhere is reported by `rewrite.unrendered()`. The tests cover each of these, and random nested cuts that render every kept char once.
- Output is format-neutral. A render passes pieces, new text and ranges of the source with the fields of the consumer, so one rewrite feeds a v3 source map, the span mappings of a language server, or any other mapping a tool keeps, without the rewrite knowing either.

### Maps for debuggers

- New text maps nowhere, also by consumers that look back across lines as V8 does: a segment without a source ends the mapping before it. The tests read every generated char both on its line and across lines, as Node's `SourceMap` does.
- Kept text is exact at token boundaries. It maps at the start of each piece, line, word, run of whitespace and other char, with no syntax built in, so a position that a debugger, a stack trace or coverage reads maps to its own original position in any syntax whose tokens do not start inside a word. The tests check every generated char against that rule.
- The `text` of a range maps as a whole to the start of the range, and a range can carry the original name of the symbol it renames into `names`. muggle-string adds no name of its own.

### Cost

- An edit appends to a typed array of its writer; the edits are sorted once, at the first render, which keeps them as they are when they arrived in order. A cut finds its place by binary search, and a render walks the edits and removals once and passes kept text as ranges, without copying it.
- Measured with Node 24 on an Apple M2, on a 1 MB text with random inserts and replaces by 4 writers and nested cuts: 1,000 edits take 0.2 ms to make and 0.2 ms to render as text, and 100,000 edits 19 ms (about 190 ns each) and 32 ms. A v3 map of the 1 MB text takes 30 to 96 ms over that range, as it reads each kept char.
- In the script compiler of Vue single-file components, on 400 real components, muggle-string takes about 8 µs per component, about four fifths of it in the source map.

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
const rewrite = createSourceRewrite<typeof source, { data: string; name?: string }>(source);

for (const { index: start } of source.content.matchAll(/\bname\b/g)) {
	const end = start + 'name'.length;
	rewrite.replace(start, end, { source, start, end, text: 'user', name: 'name', data: 'rename' });
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

const pieces: Piece<RewriteOrigin<typeof source, { data: string; name?: string }>>[] = [];
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
// {"version":3,"sources":["main.js"],"sourcesContent":["log(name);\nconst name = \"Ada\";\n"],"names":["name"],"mappings":"AACA,KAAK,CAACA,IAAI,CAAC,CAAC,CAAC,CAAC,GAAG,CAAC;AADlB,GAAG,CAACA,IAAI,CAAC;"}
```

Kept text maps to itself at the start of each piece, line, word, run of whitespace and other char. A word is a run of Unicode letters, marks and digits, and each other char, as `_`, `$` or `-`, maps on its own, since syntaxes differ on joining them into names; so the map knows no syntax, and is precise at the token boundaries of any syntax whose tokens do not start inside such a word, as JavaScript, TypeScript, HTML and CSS, the positions that debuggers, stack traces and coverage read. A position inside a word maps to its start. The `text` of a range maps as a whole to the start of the range, at the start of each of its lines. New text maps nowhere: where it starts a line or follows mapped text on one, a segment without a source ends the mapping before it, so a lookup in it finds no original position, also by a consumer that looks back across lines.

The `name` of a range, as in the usage above, is the original name of the symbol that its generated text starts with, and goes in `names` at the first segment of the range on a char. Debuggers show a generated binding under it and evaluate the original name as that binding, and Node names a stack frame by the name at the start of its function. Only the consumer knows which range renames a symbol, so a range has a name only where it gives one: one on generated text that starts with another binding, as `__props.x` in place of `x`, would show `__props` as `x`.

## Span mappings

Language tools map a generated text to its source by spans: a generated range, the original range it stands for, and a kind. A Verbatim span maps each offset to the same offset from the original start, and an Atom span maps its ends to the ends of the original range and every offset inside it to the original start. Vue language-tools builds its span mappings this way from the pieces of a render: a kept range is the same text as its range, so it is a Verbatim span, and the `text` of a range stands for the range as a whole, so it is an Atom span; new text has no span, so it maps nowhere. In place of the render of the usage above:

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

A consumer that knows more of a `text` can map it closer: where it is as long as its range and keeps its offsets, as a rename of the same length, language-tools maps it as Verbatim, so that an edit inside the name maps back. The fields of the pieces carry what the spans need beyond their ranges, as the language features of each span in language-tools.
