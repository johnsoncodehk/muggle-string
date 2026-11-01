# muggle-string

I wrote muggle-string for [vuejs/language-tools](https://github.com/vuejs/language-tools), to turn Vue single-file components into TypeScript code for the language server. It rewrites a source text from several places at once, and maps the result back to the source, both as the spans of a language server and as a v3 source map. It has no dependencies.

> 1.0 replaces the segment-array helpers of 0.4 (`replace`, `replaceSourceRange`, `toString`, ...). They are gone, not deprecated.

## Background

In vuejs/language-tools, plugins for props, emits, models, slots and refs all edit the same `<script setup>` block. The generator moves parts of it, such as the expression of the default export, and renders the block in several pieces around the template code. Every piece of the output keeps the editor features of the code it came from, such as hover, completion and rename. muggle-string is the model behind that, without Vue in it. I wanted three things from it:

- **Edits stay correct.** The plugins do not know about each other. Removals add up, so no edit undoes another. Code belongs to a range of the text and nests by ranges, so the code of two plugins around the same expression nests the same way whatever order they run in. The tests in `tests/` check both with random edits.
- **Maps are exact where tools read them.** The same pieces give the spans of a language server and a v3 source map for debuggers. In the source map, generated code maps to nothing, so a debugger never shows it as your code, even when it looks back across lines as V8 does. Kept code maps exactly at token starts in JavaScript, TypeScript, HTML and CSS, which is where breakpoints, stack traces and coverage read. The tests check every generated char of the map.
- **Performance first.** A language server generates the code again after each change to a file, so the model skips work it does not need. A wrap or a replace is only appended to a list. No text is searched, split or copied when you edit. A render sorts the edits once, or not at all when they arrived in order, and the renders after it reuse that until the next edit. A render passes kept text as ranges of the source and never copies it. Whether to build a string from the pieces is up to you. With Node 24 on an Apple M2, for a 1 MB text with 100,000 wraps and replaces at random offsets, each edit costs about 115 ns in a fresh process and about 37 ns once warm, however many came before, and rendering the text to a string takes about 40 ms cold and 29 ms warm.

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
const at = source.content.indexOf('const');
rewrite.wrap(0, at, rewrite.cut(at, source.content.length), '');

let text = '';
rewrite.render(0, source.content.length, piece => text += rewritePieceText(piece));
console.log(text);
// const user = "Ada";
// log(user);
```

A source is any object with `content`. A render after the content changed throws.

#### Wraps

```ts
import { createSourceRewrite, rewritePieceText } from 'muggle-string';

const source = { content: 'f(x, y)' };
const rewrite = createSourceRewrite(source);

rewrite.wrap(2, 3, '(', ')');
rewrite.wrap(2, 6, '[', ']');
rewrite.wrap(2, 3, '{', '}');
rewrite.replace(5, 6, 'z');

let text = '';
rewrite.render(0, source.content.length, piece => text += rewritePieceText(piece));
console.log(text);
// f([{(x)}, z])
```

Wraps nest by their ranges, whatever the order of the calls, so a visitor can wrap each node when it enters it, when it leaves it, or both at once. Of one range, a later wrap goes outside. A `replace` goes inside the wraps of its range.

#### Move with a cut

```ts
import { createSourceRewrite, rewritePieceText } from 'muggle-string';

const source = { content: 'export default { a: 1 };\n' };
const rewrite = createSourceRewrite(source);

const object = rewrite.cut(15, 23, { placeholder: '__options' });
rewrite.replace(20, 21, '2');
console.log(rewrite.unrendered().length);
// 1

rewrite.wrap(0, source.content.length, ['const __options = ', object, ';\n'], '');
let text = '';
rewrite.render(0, source.content.length, piece => text += rewritePieceText(piece));
console.log(text);
// const __options = { a: 2 };
// export default __options;
console.log(rewrite.unrendered().length);
// 0
```

The slice renders the range, with every edit inside it, where you place it. The placeholder renders where the range was.

Kept text of a slice gets the data of the code it renders in, with the fields given to its cut over it:

```ts
import { createSourceRewrite, rewritePieceText } from 'muggle-string';

const source = { content: 'f(a, b)' };
const rewrite = createSourceRewrite<typeof source, { view: string; moved: boolean }>(source);
rewrite.wrap(2, 3, rewrite.cut(5, 6, { moved: true }), '');

const parts: string[] = [];
rewrite.render(0, 7, piece => {
	parts.push(typeof piece === 'string' ? piece : `${rewritePieceText(piece)}@${piece.view}${piece.moved ? '+moved' : ''}`);
}, { view: 'main', moved: false });
console.log(parts.join(' '));
// f(@main b@main+moved a, @main )@main
```

To wrap a range where it is, wrap it instead of cutting it.

#### Views

```ts
import { createSourceRewrite, rewritePieceText } from 'muggle-string';

const source = { content: 'let a = 1;\nlet b = 2;\n' };
const rewrite = createSourceRewrite<typeof source, { view: string }>(source);
rewrite.wrap(0, source.content.length, '// start\n', '');
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

A view owns no text, so views can overlap and render again. Kept text gets the data passed to `render`. Code before all text, `wrap(0, length, code, '')`, renders with the first char, so with a view that starts at 0.

#### Code at the edges of a view

```ts
import { createSourceRewrite, rewritePieceText } from 'muggle-string';

const source = { content: 'a+b' };
const rewrite = createSourceRewrite(source);
rewrite.wrap(0, 1, '(', ')');
rewrite.replace(1, 1, '|');
rewrite.replace(3, 3, '!');

for (const [start, end] of [[0, 1], [1, 3], [1, 1], [3, 3]] as const) {
	let text = '';
	rewrite.render(start, end, piece => text += rewritePieceText(piece));
	console.log(start, end, JSON.stringify(text));
}
// 0 1 "(a)"
// 1 3 "|+b!"
// 1 1 ""
// 3 3 "!"
```

The before of a wrap renders with the first char of its range and the after with its last, so a view renders the code of the text it renders. Code at an empty range sits between two chars, and renders with the char after it, or at the end of the text with a view that ends there, so consecutive views render it once. An empty view inside the text renders nothing.

#### Data on part of the kept text

```ts
import { createSourceRewrite, rewritePieceText, type Piece, type RewriteOrigin } from 'muggle-string';

const source = { content: 'a + b' };
const rewrite = createSourceRewrite<typeof source, { complete: boolean }>(source);
rewrite.replace(2, 3, '&&');

const parts: string[] = [];
const sink = (piece: Piece<RewriteOrigin<typeof source, { complete: boolean }>>) => {
	parts.push(typeof piece === 'string' ? piece : `${rewritePieceText(piece)}:${piece.complete}`);
};
rewrite.render(0, 4, sink, { complete: true });
rewrite.render(4, 5, sink, { complete: false });
console.log(parts.join('|'));
// a :true|&&| :true|b:false
```

Kept text gets its data from the view, so render consecutive views to give parts of a range different data.

#### Zero-width positions

```ts
import { createSourceRewrite, rewritePieceText } from 'muggle-string';

const source = { content: 'a +' };
const rewrite = createSourceRewrite(source);
const at = source.content.length;
rewrite.replace(at, at, { source, start: at, end: at, text: ' missing' });

rewrite.render(0, at, piece => {
	if (typeof piece !== 'string') {
		console.log(piece.start, piece.end, JSON.stringify(rewritePieceText(piece)));
	}
});
// 0 3 "a +"
// 3 3 " missing"
```

To map code to a position rather than a range, such as a parse error, replace the empty range at it with a range without width: `replace(at, at, { source, start: at, end: at, text })`. An empty `replace` removes nothing.

#### Code that differs from the source

```ts
import { createSourceRewrite, rewritePieceText, type Piece } from 'muggle-string';

const block = { content: '{{ a &amp;&amp; b }}' };
type BlockPiece = Exclude<Piece<{ source: typeof block }>, string>;

const decoded: BlockPiece[] = [
	{ source: block, start: 3, end: 5 },
	{ source: block, start: 5, end: 15, text: '&&' },
	{ source: block, start: 15, end: 17 },
];
function toBlock(start: number, end: number, sink: (piece: BlockPiece) => void) {
	let at = 0;
	for (const piece of decoded) {
		const length = rewritePieceText(piece).length;
		const from = Math.max(start, at);
		const to = Math.min(end, at + length);
		if (from < to) {
			sink(piece.text === undefined
				? { source: block, start: piece.start + from - at, end: piece.start + to - at }
				: piece);
		}
		at += length;
	}
}

const code = { content: decoded.map(rewritePieceText).join('') };
const rewrite = createSourceRewrite(code);
rewrite.wrap(0, 1, '__ctx.', '');
rewrite.wrap(5, 6, '__ctx.', '');

let text = '';
const ranges: string[] = [];
rewrite.render(0, code.content.length, piece => {
	if (typeof piece === 'string') {
		text += piece;
		return;
	}
	toBlock(piece.start, piece.end, blockPiece => {
		text += rewritePieceText(blockPiece);
		ranges.push(`${blockPiece.start}..${blockPiece.end}`);
	});
});
console.log(text);
// __ctx.a && __ctx.b
console.log(ranges.join(' '));
// 3..5 5..15 15..16 16..17
```

Where the code is the text of the block, rewrite the block and render the range of the code as a view. Where it differs, such as after decoding entities, rewrite the code as its own source, and let the layer that makes the code give it as pieces in block offsets, through which kept ranges map back.

#### Several sources

```ts
import { createSourceRewrite, rewritePieceText } from 'muggle-string';

const script = { lang: 'ts', content: 'f();\n' };
const template = { tag: 'template', content: '{{ a }}' };
const rewrite = createSourceRewrite<typeof script | typeof template>(script);
rewrite.replace(2, 2, { source: template, start: 3, end: 4 });

rewrite.render(0, script.content.length, piece => {
	if (typeof piece !== 'string') {
		console.log(JSON.stringify(rewritePieceText(piece)), 'lang' in piece.source ? 'script' : 'template');
	}
});
// "f(" script
// "a" template
// ");\n" script
```

`S` of `createSourceRewrite<S, Data>` is every source that appears in the code, not only the one it edits. Pass their union or a common type.

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

attempt(() => rewrite.wrap(20, 20, 'x', ''));
// The offset 20 is out of 0..14.
const first = rewrite.cut(0, 6);
attempt(() => rewrite.cut(4, 9));
// The cut 4..9 crosses the cut 0..6.
attempt(() => rewrite.render(0, 14, () => rewrite.wrap(0, 1, 'x', '')));
// The rewrite is rendering.
```

Some errors depend on all edits, so a render throws them:

```ts
import { createSourceRewrite, type SourceRewrite } from 'muggle-string';

const source = { content: 'a = 1;\nb = 2;\n' };
function attempt(edit: (rewrite: SourceRewrite<typeof source>) => void) {
	const rewrite = createSourceRewrite(source);
	edit(rewrite);
	try {
		rewrite.render(0, 14, () => {});
	}
	catch (error) {
		console.log((error as Error).message);
	}
}

attempt(rewrite => rewrite.wrap(2, 3, rewrite.cut(2, 6), ''));
// The cut 2..6 is placed inside itself, so it never renders.
attempt(rewrite => {
	rewrite.cut(0, 6);
	rewrite.wrap(4, 9, '(', ')');
});
// The wrap 4..9 crosses the cut 0..6.
attempt(() => source.content = 'a = 2;\nb = 2;\n');
// The content of the source changed after the rewrite was made.
```

The before of `wrap(2, 3, …)` renders with the first char of the cut, so a slice placed there is inside itself. A wrap that crosses a cut would render one side with the slice and the other where the slice was cut from.

An edit that throws changes nothing. An error that a render throws comes from edits that stay, so every later render throws it too.

#### Source maps

```ts
import { createSourceRewrite, renderWithSourceMap } from 'muggle-string';

const source = { name: 'main.js', content: 'log(name);\nconst name = "Ada";\n' };
const rewrite = createSourceRewrite<typeof source, { name?: string }>(source);

for (const { index: start } of source.content.matchAll(/\bname\b/g)) {
	const end = start + 'name'.length;
	rewrite.replace(start, end, { source, start, end, text: 'user', name: 'name' });
}
const at = source.content.indexOf('const');
rewrite.wrap(0, at, rewrite.cut(at, source.content.length), '');

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

A range that has no source, or whose offsets are not integers within the content of its source, throws when it reaches the sink:

```ts
import { renderWithSourceMap } from 'muggle-string';

const source = { name: 'main.js', content: 'a = 1;\n' };
try {
	renderWithSourceMap(sink => sink({ source, start: 0, end: 9, text: 'b' }), (from: typeof source) => from.name);
}
catch (error) {
	console.log((error as Error).message);
}
// The range 0..9 of main.js is out of 0..7.
```

## Coming from a mutable string editor

Offsets always point into the original text, also after other edits.

| To | Write |
|---|---|
| overwrite a range | `replace(start, end, text)`, or `replace(start, end, { source, start, end, text })` to map it to the range |
| remove a range | `replace(start, end, '')` |
| prepend or append to the text | `wrap(0, source.content.length, code, '')` or `wrap(0, source.content.length, '', code)` |
| insert around a range | `wrap(start, end, before, after)`, with `''` for a side without code |
| insert at an offset | `replace(offset, offset, code)` |
| move a range | `replace(to, to, rewrite.cut(start, end))` |
| read the result | `rewrite.render(0, source.content.length, piece => text += rewritePieceText(piece))` |
| get a source map | `renderWithSourceMap`, above |

## What the techniques save

Each technique in the table adds code. `npm run bench` builds the source and, for each technique, a variant with only that technique taken out (`bench/variants.mjs`), checks that all of them give the same output by hash, and times each in a fresh process on fixed inputs: about 1 MB of code-like text, and edits at distinct offsets. `bench/table.mjs` makes the tables below. Each figure is a single round, so differences of a few percent are near the noise. Node 24.15, Apple M2, in ms; cold is the first run in a process, warm the median of 20 runs after 20 more.

| Technique | Workload | Warm, with → without | Cold, with → without |
|---|---|---|---|
| Edits and removals appended, sorted once at a render | 100,000 edits in random order | 36.5 → 783 | 49.1 → 2,139 |
| No sort when edits arrive in order | 100,000 edits in source order | 12.0 → 14.2 | 26.1 → 31.2 |
| A view finds where it starts by binary search | 5,000 views after 100,000 edits | 12.2 → 317 | 29.9 → 252 |
| Mappings written as bytes, decoded by chunk | source map after 100,000 edits in source order | 32.7 → 114 | 49.4 → 119 |
| ASCII chars classed without a regular expression | the same source map | 32.7 → 51.4 | 49.4 → 66.8 |
| A cut after all others of its level appended | 10,000 cuts in source order | 1.65 → 1.80 | 14.8 → 15.4 |
| Kept text passed as ranges, not copied | spans of 100,000 edits, by length | 18.3 → 19.4 | 29.9 → 39.6 |
| Keys and removals in `Int32Array` | 100,000 edits in random order | 36.5 → 39.9 | 49.1 → 52.4 |

Where a technique is not used, it makes no difference: the in-order shortcuts on random edits, the map techniques on text renders, the view search on whole renders, the cut shortcut without cuts. The last three rows save 10% or less, and `Int32Array` is slightly slower than plain arrays for edits in source order (12.0 against 11.4).

The baselines are the 0.4 segment array, whose every edit scans and splits the segments, and a sorted array that splices each edit into place:

| Text render | muggle-string | sorted array, spliced | 0.4 segment array |
|---|---|---|---|
| 10,000 edits in random order, warm | 2.96 | 4.86 | 155 |
| 100,000 edits in random order, warm | 36.5 | 403 | 18,396 (cold, one run) |
| 100,000 edits in source order, warm | 12.0 | 16.2 | 33,966 (cold, one run) |

## Reference

<details>
<summary>Editing</summary>

- `wrap(start, end, before, after)` puts `before` before the text of the range and `after` after it. Wraps nest by their ranges, whatever the order of the calls. Of one range, a later wrap goes outside. `before` renders with the first char of the range and `after` with its last, so code moves with that text. An empty range is at the char at `start`, or at the end of the text. A side that is `''` adds nothing.
- `replace(start, end, code)` removes `start`..`end` and puts `code` in its place, inside the wraps of the range. An empty range removes nothing; to map the code to the position, write `{ source, start: at, end: at, text }`.
- Offsets of edits, cuts and views that are not integers in 0..the length of the content throw.
- `rewrite.cut(start, end, options)` takes a range out and returns a slice. The slice renders the range, with every edit inside it, where you place it. `options.placeholder` renders where the range was.
- Cuts can be made in any order. A cut inside another moves with it. A cut that crosses another throws, naming both ranges. A wrap that crosses a cut throws when it renders.
- Kept text of a slice gets the data of the code it renders in, with the other fields of `options` over it.
- A slice renders wherever and as often as it is placed and rendered, as a view does. A slice placed inside its own range, also by a wrap that starts at its start, throws when it renders. `rewrite.unrendered()` lists the slices that have not rendered yet.
- A render renders the edits made before it, so an edit after a render shows in the next one. An edit while a render runs, such as from its sink, throws. A render after the content of the source changed throws.

</details>

<details>
<summary>Rendering</summary>

`rewrite.render(start, end, sink, data)` passes the pieces of `start`..`end` to `sink`, in order. You can render several ranges, and they may overlap. A range renders the code of its chars: the before of each wrap that starts in it, the after of each wrap that ends in it, and the code at an empty range at one of its chars. A range that ends at the end of the text also renders the code at the end, so `render(0, 0)` of an empty source renders all its code. An empty range inside the text renders no code.

</details>

<details>
<summary>Pieces</summary>

```ts
type Piece<Origin = unknown> = string | (Origin & { start: number; end: number; text?: string });
```

- A string is new text.
- A range without `text` keeps the source text at `start`..`end`.
- A range with `text` is generated text that stands for `start`..`end`.
- `start` and `end` are integers, with 0 ≤ `start` ≤ `end` ≤ the length of the `content` of the source. `renderWithSourceMap` throws on a range that breaks this or has no source, when the range reaches its sink. `rewritePieceText` throws on such a range without `text`, as it reads the source only for kept text. A rewrite checks the offsets of its own edits, cuts and views when you call them, and passes the ranges you write as code on as they are.

The ranges of a rewrite also carry their `source` and the fields of `Data`. Kept text gets the `data` passed to `render`, with the fields of its cut over it. The ranges you write carry what you put on them, like `name` in the source map example. `rewritePieceText(piece)` gives the text of any piece. A producer of one source, such as [muggle-pug](https://github.com/johnsoncodehk/muggle-pug), can emit plain `Piece` ranges without a `source`.

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
const at = source.content.indexOf('const');
rewrite.wrap(0, at, rewrite.cut(at, source.content.length), '');

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
