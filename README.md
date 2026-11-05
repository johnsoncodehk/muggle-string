# muggle-string

I wrote muggle-string for [vuejs/language-tools](https://github.com/vuejs/language-tools), to turn Vue single-file components into TypeScript code for the language server. It rewrites a source text from several places at once, and maps the result back to the source, both as the spans of a language server and as a v3 source map. It has no dependencies.

> 1.0 replaces the segment-array helpers of 0.4 (`replace`, `replaceSourceRange`, `toString`, ...). They are gone, not deprecated.

## Background

In vuejs/language-tools, plugins for props, emits, models, slots and refs all edit the same `<script setup>` block. The generator moves parts of it, such as the expression of the default export, and renders the block in several pieces around the template code. Every piece of the output keeps the editor features of the code it came from, such as hover, completion and rename. muggle-string is the model behind that, without Vue in it. I wanted three things from it:

- **Edits stay correct.** The plugins do not know about each other. Removals add up, so no edit undoes another. Code at one position is ordered by the rank of its writer, so the order of the plugins decides it, not the order of the calls. The tests in `tests/` check both with random edits.
- **Maps are exact where tools read them.** The same pieces give the spans of a language server and a v3 source map for debuggers. In the source map, generated code maps to nothing, so a debugger never shows it as your code, even when it looks back across lines as V8 does. Kept code maps exactly at token starts in JavaScript, TypeScript, HTML and CSS, which is where breakpoints, stack traces and coverage read. The tests check every generated char of the map.
- **Performance first.** A language server generates the code again after each change to a file, so the model skips work it does not need. An insert or a replace is only appended to the list of its writer. No text is searched, split or copied when you edit. A render sorts the edits once, or not at all when they arrived in order, and the renders after it reuse that until the next edit. A render passes kept text as ranges of the source and never copies it. Whether to build a string from the pieces is up to you. With Node 24 on an Apple M2, for a 1 MB text with 100,000 inserts and replaces at random offsets from 4 writers, each edit costs about 115 ns in a fresh process and about 37 ns once warm, however many came before, and rendering the text to a string takes about 40 ms cold and 29 ms warm.

## Adoption

- [vuejs/language-tools](https://github.com/vuejs/language-tools): generates the TypeScript code of Vue single-file components. Its releases use 0.4; the move to 1.0 is in progress and not released.
- [muggle-pug](https://github.com/johnsoncodehk/muggle-pug): compiles Pug to HTML as `Piece` ranges.

## Install

`npm install muggle-string`. It ships as ES modules only. CommonJS code can `require` it on Node 20.19 and later, or 22.12 and later. `renderWithSourceMap` also needs the global `TextDecoder` of the WHATWG Encoding Standard, as Node and Bun define it; `renderWithDecodedSourceMap` does not.

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

A source is any object with `content`. A render after the content changed throws.

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

Kept text of a slice carries the data of its cut, also in a view with other data:

```ts
import { createSourceRewrite, rewritePieceText } from 'muggle-string';

const source = { content: 'f(a, b)' };
const rewrite = createSourceRewrite<typeof source, { from: string }>(source);
rewrite.insertBefore(2, rewrite.cut(5, 6, { from: 'cut' }));

const parts: string[] = [];
rewrite.render(0, 7, piece => {
	parts.push(typeof piece === 'string' ? piece : `${rewritePieceText(piece)}@${piece.from}`);
}, { from: 'view' });
console.log(parts.join(' '));
// f(@view b@cut a, @view )@view
```

To wrap a range where it is, insert around it instead of cutting it.

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

#### Inserts at the edges of a view

```ts
import { createSourceRewrite, rewritePieceText } from 'muggle-string';

const source = { content: 'a+b' };
const rewrite = createSourceRewrite(source);
rewrite.insertAfter(1, '>');
rewrite.insertBefore(1, '<');

for (const [start, end] of [[0, 1], [1, 3], [1, 1]] as const) {
	let text = '';
	rewrite.render(start, end, piece => text += rewritePieceText(piece));
	console.log(start, end, JSON.stringify(text));
}
// 0 1 "a>"
// 1 3 "<+b"
// 1 1 ""

const empty = { content: '' };
const emptyRewrite = createSourceRewrite(empty);
emptyRewrite.insertBefore(0, 'B');
emptyRewrite.insertAfter(0, 'A');
let text = '';
emptyRewrite.render(0, 0, piece => text += rewritePieceText(piece));
console.log(JSON.stringify(text));
// "AB"
```

An insert attaches to a side of a char: `insertBefore(offset, …)` to the char at `offset`, `insertAfter(offset, …)` to the char before it. A view renders the inserts of the chars it renders, so the view `a`..`b` renders `insertBefore(a, …)` and `insertAfter(b, …)`, but not `insertAfter(a, …)` or `insertBefore(b, …)`. An empty view inside the text, like `1`..`1`, renders no inserts. An empty view at 0 or at the end renders the code before or after all text, so in an empty source `render(0, 0)` renders both. Pick the side by the text the code belongs to: code at the end of an expression is `insertAfter(end, …)`, so it still renders when the expression becomes a view.

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

#### Nesting

```ts
import { createSourceRewrite, rewritePieceText } from 'muggle-string';

const source = { content: 'xy' };

function wrap(order: 'pre-order' | 'enter and leave' | 'pre-order with ranks') {
	const rewrite = createSourceRewrite(source);
	const outer = order === 'pre-order with ranks' ? rewrite.writer(1) : rewrite;
	const inner = order === 'pre-order with ranks' ? rewrite.writer(0) : rewrite;
	if (order === 'enter and leave') {
		rewrite.insertBefore(0, '(');
		rewrite.insertBefore(1, '[');
		rewrite.insertAfter(2, ']');
		rewrite.insertAfter(2, ')');
	}
	else {
		outer.insertBefore(0, '(');
		outer.insertAfter(2, ')');
		inner.insertBefore(1, '[');
		inner.insertAfter(2, ']');
	}
	let text = '';
	rewrite.render(0, 2, piece => text += rewritePieceText(piece));
	console.log(text, order);
}
wrap('pre-order');
// (x[y)] pre-order
wrap('enter and leave');
// (x[y]) enter and leave
wrap('pre-order with ranks');
// (x[y]) pre-order with ranks
```

To wrap nested nodes, write the open code when you enter a node and the close code when you leave it: the closes of nodes that end at one position then come inner first, in call order. If you write each open and close together, in pre-order, the closes come outer first; give each depth its own writer, with a higher rank further out.

#### Zero-width positions

```ts
import { createSourceRewrite, rewritePieceText } from 'muggle-string';

const source = { content: 'a +' };
const rewrite = createSourceRewrite(source);
const at = source.content.length;
rewrite.insertBefore(at, { source, start: at, end: at, text: ' missing' });

rewrite.render(0, at, piece => {
	if (typeof piece !== 'string') {
		console.log(piece.start, piece.end, JSON.stringify(rewritePieceText(piece)));
	}
});
// 0 3 "a +"
// 3 3 " missing"
```

To map code to a position rather than a range, such as a parse error, insert a range without width: `insertBefore(at, { source, start: at, end: at, text })`. A `replace` of an empty range, such as of a reference of no char, removes nothing and puts its code in the place of the char at `at`, inside the inserts there, so code that replaces a range needs no check for an empty one.

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
rewrite.insertBefore(0, '__ctx.');
rewrite.insertBefore(5, '__ctx.');

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
rewrite.insertBefore(2, { source: template, start: 3, end: 4 });

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

attempt(() => rewrite.insertBefore(20, 'x'));
// The offset 20 is out of 0..14.
attempt(() => rewrite.writer(-1));
// The rank -1 is not a non-negative integer below the rank of the rewrite.

const first = rewrite.cut(0, 6);
attempt(() => rewrite.cut(4, 9));
// The cut 4..9 crosses the cut 0..6.
attempt(() => rewrite.render(0, 14, () => rewrite.insertBefore(0, 'x')));
// The rewrite is rendering.
source.content = 'a = 2;\nb = 2;\n';
attempt(() => rewrite.render(0, 14, () => {}));
// The content of the source changed after the rewrite was made.
```

```ts
import { createSourceRewrite } from 'muggle-string';

const source = { content: 'a = 1;\nb = 2;\n' };
const rewrite = createSourceRewrite(source);
const slice = rewrite.cut(2, 6);
rewrite.insertBefore(2, slice);
try {
	rewrite.render(0, 14, () => {});
}
catch (error) {
	console.log((error as Error).message);
}
// The cut 2..6 is placed inside itself, so it never renders.
```

`insertBefore(2, …)` attaches to the first char of the cut, so a slice placed at its own start is inside itself.

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

`renderWithDecodedSourceMap(render, sourceName)` gives the same text and map with `mappings` decoded, for code that works on the segments instead of writing out the map. Each line of the generated text has an array of segments, `[column, source, line, column, name]` in zero-based numbers, without the source fields where the segment has no source and without `name` where it has none. It needs no `TextDecoder`.

```ts
import { createSourceRewrite, renderWithDecodedSourceMap } from 'muggle-string';

const source = { name: 'main.js', content: 'let a = 1;\n' };
const rewrite = createSourceRewrite<typeof source, { name?: string }>(source);
rewrite.replace(4, 5, { source, start: 4, end: 5, text: 'b', name: 'a' });

const { map } = renderWithDecodedSourceMap(
	sink => rewrite.render(0, source.content.length, sink),
	(from: typeof source) => from.name,
);
console.log(JSON.stringify(map.mappings));
// [[[0,0,0,0],[3,0,0,3],[4,0,0,4,0],[5,0,0,5],[6,0,0,6],[7,0,0,7],[8,0,0,8],[9,0,0,9]],[]]
```

`encodeMappings(mappings)` writes decoded mappings back as the v3 `mappings` string, as `renderWithSourceMap` writes them, for code that changes the segments before it writes out the map. A field that is not an integer from 0 to 2 ** 30 - 1 throws, and so does a call where the global `TextDecoder` is not defined.

```ts
import { encodeMappings } from 'muggle-string';

console.log(encodeMappings([[[0, 0, 0, 0], [4]], [], [[2, 0, 1, 3, 0]]]));
// AAAA,I;;EACGA
```

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
| prepend or append to the text | `insertAfter(0, code)` or `insertBefore(source.content.length, code)` |
| insert at an offset | `insertBefore(offset, code)` or `insertAfter(offset, code)` |
| move a range | `insertBefore(to, rewrite.cut(start, end))` |
| read the result | `rewrite.render(0, source.content.length, piece => text += rewritePieceText(piece))` |
| get a source map | `renderWithSourceMap`, above |
| get the segments of a source map | `renderWithDecodedSourceMap`, above |
## What the techniques save

Each technique in the table adds code. `npm run bench` builds the source and, for each technique, a variant with only that technique taken out (`bench/variants.mjs`), checks that all of them give the same output by hash, and times each in a fresh process on fixed inputs: about 1 MB of code-like text, and edits at distinct offsets from 4 writers. `bench/table.mjs` makes the tables below. Each figure is a single round, so differences of a few percent are near the noise. Node 24.15, Apple M2, in ms; cold is the first run in a process, warm the median of 20 runs after 20 more.

| Technique | Workload | Warm, with → without | Cold, with → without |
|---|---|---|---|
| Edits and removals appended, sorted once at a render | 100,000 edits in random order | 36.6 → 183 | 54.1 → 193 |
| No sort when edits arrive in order | 100,000 edits in source order | 14.6 → 16.9 | 32.7 → 37.2 |
| Writers merged in one pass | 100,000 edits in source order | 14.6 → 17.6 | 32.7 → 43.1 |
| A view finds where it starts by binary search | 5,000 views after 100,000 edits | 15.0 → 318 | 33.2 → 262 |
| Mappings written as bytes, decoded by chunk | source map after 100,000 edits in source order | 34.7 → 97.5 | 55.3 → 127 |
| ASCII chars classed without a regular expression | the same source map | 34.7 → 51.4 | 55.3 → 72.8 |
| A cut after all others of its level appended | 10,000 cuts in source order | 1.45 → 1.58 | 15.2 → 15.6 |
| Kept text passed as ranges, not copied | spans of 100,000 edits, by length | 21.0 → 22.1 | 38.9 → 42.3 |
| Keys and removals in `Int32Array` | 100,000 edits in random order | 36.6 → 39.8 | 54.1 → 57.9 |

Where a technique is not used, it makes no difference: the in-order shortcuts on random edits, the map techniques on text renders, the view search on whole renders, the cut shortcut without cuts. The last three rows save 9% or less.

The baselines are the 0.4 segment array, whose every edit scans and splits the segments, and a sorted array that splices each edit into place:

| Text render | muggle-string | sorted array, spliced | 0.4 segment array |
|---|---|---|---|
| 10,000 edits in random order, warm | 3.11 | 4.90 | 155 |
| 100,000 edits in random order, warm | 36.6 | 408 | 21,739 (cold, one run) |
| 100,000 edits in source order, warm | 14.6 | 18.1 | 35,232 (cold, one run) |

## Reference

<details>
<summary>Editing</summary>

- `insertBefore(offset, code)` attaches code to the char at `offset`, and `insertAfter(offset, code)` to the char before it. The code moves with that char.
- `replace(start, end, code)` removes `start`..`end` and puts `code` in its place. An empty range removes nothing and puts `code` in the place of the char at `start`, inside the inserts there, or at the end of the text; to map code to a position, write `{ source, start: at, end: at, text }`.
- Offsets of edits, cuts and views that are not integers in 0..the length of the content throw.
- `rewrite.writer(rank)` gives a writer with its own rank. At one position, code of a higher rank goes outside code of a lower rank. The rewrite itself is the outermost writer. Code of one writer at one position keeps call order.
- `rewrite.cut(start, end, options)` takes a range out and returns a slice. The slice renders the range, with every edit inside it, where you place it. `options.placeholder` renders where the range was.
- Cuts can be made in any order. A cut inside another moves with it. A cut that crosses another throws, naming both ranges.
- Kept text of a slice carries the data of its cut, wherever the slice renders.
- A slice renders wherever and as often as it is placed and rendered, as a view does. A slice placed inside its own range, also by `insertBefore` at its start, throws when it renders. `rewrite.unrendered()` lists the slices that have not rendered yet.
- A render renders the edits made before it, so an edit after a render shows in the next one. An edit while a render runs, such as from its sink, throws. A render after the content of the source changed throws.

</details>

<details>
<summary>Rendering</summary>

`rewrite.render(start, end, sink, data)` passes the pieces of `start`..`end` to `sink`, in order. You can render several ranges, and they may overlap. A range renders the code attached to its chars: `insertBefore(start, …)` and `insertAfter(end, …)`, not `insertAfter(start, …)` or `insertBefore(end, …)`. An empty range inside the text renders no code. Code inserted before all text (`insertAfter(0, …)`) renders with a range that starts at 0, and code after all text with a range that ends at the end, so `render(0, 0)` of an empty source renders both.

</details>

<details>
<summary>Pieces</summary>

```ts
type Piece<Origin = unknown> = string | (Origin & { start: number; end: number; text?: string });
```

- A string is new text.
- A range without `text` keeps the source text at `start`..`end`.
- A range with `text` is generated text that stands for `start`..`end`.
- `start` and `end` are integers, with 0 ≤ `start` ≤ `end` ≤ the length of the `content` of the source. `renderWithSourceMap` and `renderWithDecodedSourceMap` throw on a range that breaks this or has no source, when the range reaches their sink. `rewritePieceText` throws on such a range without `text`, as it reads the source only for kept text. A rewrite checks the offsets of its own edits, cuts and views when you call them, and passes the ranges you write as code on as they are.

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
- `renderWithDecodedSourceMap` gives the same map with its `mappings` decoded: encoded line by line as v3 mappings, they are the `mappings` of `renderWithSourceMap`, its empty last line included. It needs no `TextDecoder`.
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
