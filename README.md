# muggle-string

I wrote muggle-string for [vuejs/language-tools](https://github.com/vuejs/language-tools), to turn Vue single-file components into TypeScript code for the language server. It rewrites a source text from several places at once, and maps the result back to the source, both as the spans of a language server and as a v3 source map. It has no dependencies.

> 1.0 replaces the segment-array helpers of 0.4 (`replace`, `replaceSourceRange`, `toString`, ...). They are gone, not deprecated.

## Background

In vuejs/language-tools, plugins for props, emits, models, slots and refs all edit the same `<script setup>` block. The generator moves parts of it, such as the expression of the default export, and renders the block in several pieces around the template code. Every piece of the output keeps the editor features of the code it came from, such as hover, completion and rename. muggle-string is the model behind that, without Vue in it. I wanted three things from it:

- **Edits stay correct.** The plugins do not know about each other. Removals add up, so no edit undoes another. Code at one position is ordered by the rank of its writer, so the order of the plugins decides it, not the order of the calls. The tests in `tests/` check both with random edits.
- **Maps are exact where tools read them.** The same pieces give the spans of a language server and a v3 source map for debuggers. In the source map, generated code maps to nothing, so a debugger never shows it as your code, even when it looks back across lines as V8 does. Kept code maps exactly at token starts in JavaScript, TypeScript, HTML and CSS, which is where breakpoints, stack traces and coverage read. The tests check every generated char of the map.
- **Performance first.** A language server generates the code again after each change to a file, so the model skips work it does not need. An insert or a replace is only appended to the list of its writer. No text is searched, split or copied when you edit. The first render sorts the edits once, or not at all when they arrived in order, and then freezes the rewrite, so later edits throw. A render passes kept text as ranges of the source and never copies it. Whether to build a string from the pieces is up to you. With Node 24 on an Apple M2, for a 1 MB text with 100,000 inserts and replaces at random offsets from 4 writers, each edit costs about 115 ns in a fresh process and about 37 ns once warm, however many came before, and rendering the text to a string takes about 40 ms cold and 29 ms warm.

## Adoption

- [vuejs/language-tools](https://github.com/vuejs/language-tools): generates the TypeScript code of Vue single-file components. Its releases use 0.4; the move to 1.0 is in progress and not released.
- [muggle-pug](https://github.com/johnsoncodehk/muggle-pug): compiles Pug to HTML as `Piece` ranges.

## Install

1.0 is on the `next` tag: `npm install muggle-string@next`. It ships as ES modules only. CommonJS code can `require` it on Node 20.19 and later, or 22.12 and later. `renderWithSourceMap` also needs the global `TextDecoder` of the WHATWG Encoding Standard, as Node and Bun define it.

## Usage

#### Edit and render

```ts
import { createSourceRewrite, rewritePieceText } from 'muggle-string';

const source = { content: 'log(name);\nconst name = "Ada";\n' };
const rewrite = createSourceRewrite(source);

for (const { index: start } of source.content.matchAll(/\bname\b/g)) {
	rewrite.replace(start, start + 'name'.length, 'user');
}
rewrite.insertBefore(0, rewrite.cut(source.content.indexOf('const'), source.content.length));

let text = '';
rewrite.render(0, source.content.length, piece => text += rewritePieceText(piece));
console.log(text);
// const user = "Ada";
// log(user);
```

A source is any object with `content`. Do not change the content until the rewrite is rendered.

#### Writers and ranks

```ts
import { createSourceRewrite, rewritePieceText } from 'muggle-string';

const source = { content: 'f(x)' };
const rewrite = createSourceRewrite(source);
const inner = rewrite.writer(0);
const outer = rewrite.writer(1);

inner.insertBefore(2, '(');
outer.insertBefore(2, '[');
rewrite.insertBefore(2, '{');
inner.insertAfter(3, ')');
outer.insertAfter(3, ']');
rewrite.insertAfter(3, '}');
inner.insertAfter(3, '!');

let text = '';
rewrite.render(0, source.content.length, piece => text += rewritePieceText(piece));
console.log(text);
// f({[(x)!]})
```

At one position, code of a higher rank goes outside code of a lower rank, whatever the order of the calls. The rewrite itself is the outermost writer. Code of one writer at one position keeps call order.

#### Move with a cut

```ts
import { createSourceRewrite, rewritePieceText } from 'muggle-string';

const source = { content: 'export default { a: 1 };\n' };
const rewrite = createSourceRewrite(source);

const object = rewrite.cut(15, 23, { placeholder: '__options' });
rewrite.replace(20, 21, '2');
console.log(rewrite.unrendered().length);
// 1

rewrite.insertBefore(0, ['const __options = ', object, ';\n']);
let text = '';
rewrite.render(0, source.content.length, piece => text += rewritePieceText(piece));
console.log(text);
// const __options = { a: 2 };
// export default __options;
console.log(rewrite.unrendered().length);
// 0
```

The slice renders the range, with every edit inside it, where you place it. The placeholder renders where the range was.

#### Views

```ts
import { createSourceRewrite, rewritePieceText } from 'muggle-string';

const source = { content: 'let a = 1;\nlet b = 2;\n' };
const rewrite = createSourceRewrite<typeof source, { view: string }>(source);
rewrite.insertAfter(0, '// start\n');
rewrite.replace(4, 5, 'x');

function view(start: number, end: number, name: string) {
	const kept: string[] = [];
	let text = '';
	rewrite.render(start, end, piece => {
		text += rewritePieceText(piece);
		if (typeof piece !== 'string' && piece.text === undefined) {
			kept.push(piece.view);
		}
	}, { view: name });
	console.log(JSON.stringify(text), kept.join());
}

view(0, 10, 'first');
// "// start\nlet x = 1;" first,first
view(4, 22, 'second');
// "x = 1;\nlet b = 2;\n" second
```

A view owns no text, so views can overlap and render again. Kept text gets the data passed to `render`. Code inserted before all text (`insertAfter(0, …)`) renders with a view that starts at 0, and code after all text with a view that ends at the end.

#### Errors

```ts
import { createSourceRewrite } from 'muggle-string';

function attempt(edit: () => void) {
	try {
		edit();
	}
	catch (error) {
		console.log((error as Error).message);
	}
}

const source = { content: 'a = 1;\nb = 2;\n' };
const rewrite = createSourceRewrite(source);

attempt(() => rewrite.replace(2, 2, 'x'));
// The replace at 2 removes no char.
attempt(() => rewrite.insertBefore(20, 'x'));
// The offset 20 is out of 0..14.
attempt(() => rewrite.writer(-1));
// The rank -1 is not a non-negative integer below the rank of the rewrite.

const first = rewrite.cut(0, 6);
attempt(() => rewrite.cut(4, 9));
// The cut 4..9 crosses the cut 0..6.
rewrite.insertBefore(14, first);
rewrite.render(0, 14, () => {});
attempt(() => rewrite.insertBefore(0, 'x'));
// The rewrite is already rendered.
attempt(() => first.render(() => {}));
// The cut 0..6 is already rendered; a slice renders once.
```

```ts
import { createSourceRewrite } from 'muggle-string';

const source = { content: 'a = 1;\nb = 2;\n' };
const rewrite = createSourceRewrite(source);
const slice = rewrite.cut(0, 6);
rewrite.insertBefore(2, slice);
try {
	rewrite.render(0, 14, () => {});
}
catch (error) {
	console.log((error as Error).message);
}
// The cut 0..6 is placed inside itself, so it never renders.
```

#### Source maps

```ts
import { createSourceRewrite, renderWithSourceMap } from 'muggle-string';

const source = { name: 'main.js', content: 'log(name);\nconst name = "Ada";\n' };
const rewrite = createSourceRewrite<typeof source, { name?: string }>(source);

for (const { index: start } of source.content.matchAll(/\bname\b/g)) {
	const end = start + 'name'.length;
	rewrite.replace(start, end, { source, start, end, text: 'user', name: 'name' });
}
rewrite.insertBefore(0, rewrite.cut(source.content.indexOf('const'), source.content.length));

const { text, map } = renderWithSourceMap(
	sink => rewrite.render(0, source.content.length, sink),
	(from: typeof source) => from.name,
);
console.log(text);
// const user = "Ada";
// log(user);
console.log(JSON.stringify(map));
// {"version":3,"sources":["main.js"],"sourcesContent":["log(name);\nconst name = \"Ada\";\n"],"names":["name"],"mappings":"AACA,KAAK,CAACA,IAAI,CAAC,CAAC,CAAC,CAAC,GAAG,CAAC;AADlB,GAAG,CAACA,IAAI,CAAC;"}
```

`renderWithSourceMap(render, sourceName)` passes a sink to `render`, and `sourceName` gives the entry of each source in `sources`. Where the global `TextDecoder` is not defined, the first call throws before it renders.

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
| get a source map | `renderWithSourceMap`, above |

## Reference

<details>
<summary>Editing</summary>

- `insertBefore(offset, code)` attaches code to the char at `offset`, and `insertAfter(offset, code)` to the char before it. The code moves with that char.
- `replace(start, end, code)` removes `start`..`end` and puts `code` in its place. An empty range throws.
- `rewrite.writer(rank)` gives a writer with its own rank. At one position, code of a higher rank goes outside code of a lower rank. The rewrite itself is the outermost writer. Code of one writer at one position keeps call order.
- `rewrite.cut(start, end, options)` takes a range out and returns a slice. The slice renders the range, with every edit inside it, where you place it. `options.placeholder` renders where the range was.
- Cuts can be made in any order. A cut inside another moves with it. A cut that crosses another throws, naming both ranges.
- A slice renders exactly once. Rendering it again throws. A slice placed inside its own range throws at the first render. `rewrite.unrendered()` lists the slices that have not rendered yet.
- The first render freezes the rewrite, so later edits throw.

</details>

<details>
<summary>Rendering</summary>

`rewrite.render(start, end, sink, data)` passes the pieces of `start`..`end` to `sink`, in order. You can render several ranges, and they may overlap. Code inserted before all text (`insertAfter(0, …)`) renders with a range that starts at 0, and code after all text with a range that ends at the end.

</details>

<details>
<summary>Pieces</summary>

```ts
type Piece<Origin = unknown> = string | (Origin & { start: number; end: number; text?: string });
```

- A string is new text.
- A range without `text` keeps the source text at `start`..`end`.
- A range with `text` is generated text that stands for `start`..`end`.

The ranges of a rewrite also carry their `source` and the fields of `Data`. Kept text gets the `data` passed to `render` or `cut`. The ranges you write carry what you put on them, like `name` in the source map example. `rewritePieceText(piece)` gives the text of any piece. A producer of one source, such as [muggle-pug](https://github.com/johnsoncodehk/muggle-pug), can emit plain `Piece` ranges without a `source`.

To collect the pieces:

```ts
import { createSourceRewrite, rewritePieceText, type Piece, type RewriteOrigin } from 'muggle-string';

const source = { content: 'log(name);\n' };
const rewrite = createSourceRewrite<typeof source, { data: string }>(source);
rewrite.replace(4, 8, { source, start: 4, end: 8, text: 'user', data: 'rename' });

const pieces: Piece<RewriteOrigin<typeof source, { data: string }>>[] = [];
rewrite.render(0, source.content.length, piece => pieces.push(piece), { data: 'file' });
for (const piece of pieces) {
	console.log(JSON.stringify(rewritePieceText(piece)), typeof piece === 'string' ? 'new' : piece.data);
}
// "log(" file
// "user" rename
// ");\n" file
```

</details>

<details>
<summary>Source maps</summary>

- Kept text maps at the start of each line, word, run of whitespace, and every other char. A word is a run of Unicode letters, marks and digits. Chars like `_`, `$` and `-` map on their own, because languages disagree on whether they belong to a name. A position inside a word maps to the start of the word.
- The `text` of a range maps to the start of the range.
- New text maps to nothing.
- `renderWithSourceMap` needs the global `TextDecoder` of the WHATWG Encoding Standard, as Node and Bun define it. Where it is not defined, the first call throws before it renders.
- The `name` of a range with `text` goes into `names`. Set it only when `text` renames the identifier at the range. Kept text maps to itself, so the `name` of a range without `text`, such as a `name` field of the `data` of a view, goes nowhere. A name on text that starts with another identifier, such as `__props.x` for `x`, makes a debugger show `__props` as `x`. muggle-string adds no names itself.

</details>

<details>
<summary>Span mappings</summary>

Language tools map generated code by spans. A Verbatim span maps each offset to the same offset in the original range. An Atom span maps its ends to the ends of the original range, and every offset inside it to the original start. A kept range is a Verbatim span, and a range with `text` is an Atom span:

```ts
import { createSourceRewrite, rewritePieceText } from 'muggle-string';

const source = { content: 'log(name);\nconst name = "Ada";\n' };
const rewrite = createSourceRewrite(source);
for (const { index: start } of source.content.matchAll(/\bname\b/g)) {
	const end = start + 'name'.length;
	rewrite.replace(start, end, { source, start, end, text: 'user' });
}
rewrite.insertBefore(0, rewrite.cut(source.content.indexOf('const'), source.content.length));

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
});
for (const span of spans) {
	console.log(JSON.stringify(span));
}
// {"virtualStart":0,"virtualEnd":6,"originalStart":11,"originalEnd":17,"kind":"Verbatim"}
// {"virtualStart":6,"virtualEnd":10,"originalStart":17,"originalEnd":21,"kind":"Atom"}
// {"virtualStart":10,"virtualEnd":20,"originalStart":21,"originalEnd":31,"kind":"Verbatim"}
// {"virtualStart":20,"virtualEnd":24,"originalStart":0,"originalEnd":4,"kind":"Verbatim"}
// {"virtualStart":24,"virtualEnd":28,"originalStart":4,"originalEnd":8,"kind":"Atom"}
// {"virtualStart":28,"virtualEnd":31,"originalStart":8,"originalEnd":11,"kind":"Verbatim"}
```

A `text` as long as its range, whose offsets line up, such as a rename to a name of the same length, can be a Verbatim span instead. vuejs/language-tools does this, so an edit inside the name maps back.

</details>
