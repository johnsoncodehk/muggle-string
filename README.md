Rewrite a source text from several places at once, and map the result back to the source.

muggle-string comes from vuejs/language-tools. There, each Vue single-file component becomes TypeScript code for the language server. Plugins for props, emits, models, slots and refs all edit the same `<script setup>` block. The generator moves parts of it, such as the expression of the default export, and renders the block in several pieces around the template code. Every piece of the output keeps the editor features of the code it came from, such as hover, completion and rename. muggle-string is the model behind that, without Vue in it. It has no dependencies.

> 1.0 replaces the segment-array helpers of 0.4 (`replace`, `replaceSourceRange`, `toString`, ...). They are gone, not deprecated.

## Why

- **Edits stay correct.** The plugins do not know about each other. Removals add up, so no edit undoes another. Code at one position is ordered by the rank of its writer, so the order of the plugins decides it, not the order of the calls. The tests in `tests/` check both with random edits.
- **Maps are exact where tools read them.** The same pieces give the spans of a language server and a v3 source map for debuggers. In the source map, generated code maps to nothing, so a debugger never shows it as your code, even when it looks back across lines as V8 does. Kept code maps exactly at token starts in JavaScript, TypeScript, HTML and CSS, which is where breakpoints, stack traces and coverage read. The tests check every generated char of the map.
- **Performance first.** A language server generates the code again after each change to a file, so the model skips work it does not need. An insert or a replace is only appended to the list of its writer. No text is searched, split or copied when you edit. The first render sorts the edits once, or not at all when they arrived in order, and then freezes the rewrite, so later edits throw. A render passes kept text as ranges of the source and never copies it. Whether to build a string from the pieces is up to you. With Node 24 on an Apple M2, each edit costs about 200 ns however many came before, and a 1 MB text with 100,000 edits renders in 32 ms.

## Usage

1.0 is on the `next` tag: `npm install muggle-string@next`. It ships as ES modules only. CommonJS code can `require` it on Node 20.19 and later, or 22.12 and later.

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

## Coming from a mutable string editor

Offsets always point into the original text, also after other edits.

| To | Write |
|---|---|
| overwrite a range | `replace(start, end, text)`, or `replace(start, end, { source, start, end, text })` to map it to the range |
| remove a range | `replace(start, end, '')` |
| prepend or append to the text | `insertAfter(0, code)` or `insertBefore(source.content.length, code)` |
| insert at an offset | `insertBefore(offset, code)` or `insertAfter(offset, code)` |
| move a range | `insertBefore(to, rewrite.cut(start, end))` |
| read the result | `rewrite.render(0, source.content.length, piece => text += rewritePieceText(piece))` |
| get a source map | `renderWithSourceMap`, below |

## Editing

- `insertBefore(offset, code)` attaches code to the char at `offset`, and `insertAfter(offset, code)` to the char before it. The code moves with that char.
- `replace(start, end, code)` removes `start`..`end` and puts `code` in its place. An empty range throws.
- `rewrite.writer(rank)` gives a writer with its own rank. At one position, code of a higher rank goes outside code of a lower rank. The rewrite itself is the outermost writer. Code of one writer at one position keeps call order.
- `rewrite.cut(start, end, options)` takes a range out and returns a slice. The slice renders the range, with every edit inside it, where you place it, as `insertBefore(0, declaration)` does in the usage. `options.placeholder` renders where the range was.
- Cuts can be made in any order. A cut inside another moves with it. A cut that crosses another throws, naming both ranges.
- A slice renders exactly once. Rendering it again throws. A slice placed inside its own range throws at the first render. `rewrite.unrendered()` lists the slices that have not rendered yet.

## Rendering

`rewrite.render(start, end, sink, data)` passes the pieces of `start`..`end` to `sink`, in order. You can render several ranges, and they may overlap. Code inserted before all text (`insertAfter(0, …)`) renders with a range that starts at 0, and code after all text with a range that ends at the end.

## Pieces

```ts
type Piece<Origin = unknown> = string | (Origin & { start: number; end: number; text?: string });
```

- A string is new text.
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

- Kept text maps at the start of each line, word, run of whitespace, and every other char. A word is a run of Unicode letters, marks and digits. Chars like `_`, `$` and `-` map on their own, because languages disagree on whether they belong to a name. A position inside a word maps to the start of the word.
- The `text` of a range maps to the start of the range.
- The `name` of a range goes into `names`. Set it only when `text` renames the identifier at the range. A name on text that starts with another identifier, such as `__props.x` for `x`, makes a debugger show `__props` as `x`. muggle-string adds no names itself.

## Span mappings

Language tools map generated code by spans. A Verbatim span maps each offset to the same offset in the original range. An Atom span maps its ends to the ends of the original range, and every offset inside it to the original start. A kept range is a Verbatim span, and a range with `text` is an Atom span:

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

A `text` as long as its range, whose offsets line up, such as a rename to a name of the same length, can be a Verbatim span instead. vuejs/language-tools does this, so an edit inside the name maps back.
