# muggle-string

I wrote muggle-string for [vuejs/language-tools](https://github.com/vuejs/language-tools), to turn Vue single-file components into TypeScript code for the language server. It lets you rewrite source text from several places at once, and then map the result back — both as language-server spans and as a v3 source map. No dependencies.

> **Note:** Version 1.0 replaced the 0.4 segment-array helpers (`replace`, `replaceSourceRange`, `toString`, ...). Those APIs are gone, not deprecated.

## Install

`npm install muggle-string`

Ships as both ES modules and CommonJS, so `import` and `require` both work, on Node 12 and later. `renderWithSourceMap` needs the global `TextDecoder` (available in Node and Bun); `renderWithDecodedSourceMap` does not.

## Quick example

```ts
import { createSourceRewrite, rewritePieceText } from 'muggle-string';

const source = { content: 'log(name);\nconst name = "Ada";\n' };
const rewrite = createSourceRewrite(source);

for (const { index: start } of source.content.matchAll(/\bname\b/g)) {
	rewrite.replace(start, start + 'name'.length, 'user');
}
rewrite.insertAfter(0, rewrite.cut(source.content.indexOf('const'), source.content.length));

let text = '';
rewrite.render(0, source.content.length, piece => text += rewritePieceText(piece));
console.log(text);
// const user = "Ada";
// log(user);
```

A source is any object with a `content` string. All offsets point into the original text, even after other edits. Rendering after the source content changed throws an error.

## Core concepts

### Offsets stay stable

Every offset you pass — to `insertBefore`, `insertAfter`, `replace`, `cut`, or `render` — refers to the original source text. Even after you make a hundred edits, offset 5 still means position 5 in the original string.

### Inserts attach to characters

`insertBefore(offset, code)` attaches code to the character at that offset. `insertAfter(offset, code)` attaches to the character before it. When you move or render that character, the attached code moves with it.

Two offsets have no character to attach to: `insertAfter(0, code)` puts code before all text, and `insertBefore(source.content.length, code)` puts code after all text. That code stays at the top and the bottom, whatever moves.

An empty `replace(start, end, code)` where `start === end` inserts `code` at that position without removing anything.

Code attached to a character still renders when `replace` removes that character. This is on purpose: it lets one plugin wrap a range that another plugin replaces.

### Writers and ranks

Several plugins can edit the same position. Use writers with different ranks to control nesting order:

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

Higher ranks wrap lower ranks, no matter the call order. The rewrite itself has the highest rank. Within one writer at one position, call order is preserved.

### Moving code with cut

`cut(start, end)` removes a range and returns a slice. Place that slice somewhere else, and it renders the range with all edits inside it:

```ts
import { createSourceRewrite, rewritePieceText } from 'muggle-string';

const source = { content: 'export default { a: 1 };\n' };
const rewrite = createSourceRewrite(source);

const object = rewrite.cut(15, 23, { placeholder: '__options' });
rewrite.replace(20, 21, '2');
console.log(rewrite.unrendered().length);
// 1

rewrite.insertAfter(0, ['const __options = ', object, ';\n']);
let text = '';
rewrite.render(0, source.content.length, piece => text += rewritePieceText(piece));
console.log(text);
// const __options = { a: 2 };
// export default __options;
console.log(rewrite.unrendered().length);
// 0
```

The `placeholder` option renders where the cut was made. Kept text from a slice carries the data you pass to `cut`.

Only `cut` creates a slice. Any other object you pass is a piece and is handed through as-is.

To move a range up, use `insertAfter(to, slice)`. To move it down, use `insertBefore(to, slice)`. To move it to the very top or bottom, use `insertAfter(0, slice)` or `insertBefore(source.content.length, slice)`. A slice placed inside its own range can never render, because code inside the range moves with the slice. That includes `insertBefore` at its first character and `insertAfter` at its last one. Rendering then throws.

### Rendering and pieces

`render(start, end, sink)` calls your sink function with each piece in order. A piece is either:

- A `string` — new text you inserted
- A range without `text` — kept source text from `start` to `end`
- A range with `text` — generated text that maps back to the source range

Whether to join pieces into a string is your choice. `rewritePieceText(piece)` extracts the text from any piece.

Views can overlap. You can render the same range multiple times, or render several ranges that cover the same source positions.

Kept text picks up the data you pass to `render`:

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

### Source maps

Generate a v3 source map with `renderWithSourceMap` or `renderWithDecodedSourceMap`:

```ts
import { createSourceRewrite, renderWithSourceMap } from 'muggle-string';

const source = { name: 'main.js', content: 'log(name);\nconst name = "Ada";\n' };
const rewrite = createSourceRewrite<typeof source, { name?: string }>(source);

for (const { index: start } of source.content.matchAll(/\bname\b/g)) {
	const end = start + 'name'.length;
	rewrite.replace(start, end, { source, start, end, text: 'user', name: 'name' });
}
rewrite.insertAfter(0, rewrite.cut(source.content.indexOf('const'), source.content.length));

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

Mapping rules:
- Kept text maps at token boundaries (line starts, word starts, whitespace runs, individual punctuation)
- Generated text (ranges with `text`) maps to the start of the source range
- New strings map to nothing

`renderWithDecodedSourceMap` gives you the decoded segments instead of the encoded `mappings` string. Use `encodeMappings` and `decodeMappings` to convert between formats.

## Things that may surprise you

These are choices, not bugs.

- **Ranks order code for wrapping.** Before a character, the highest rank comes first; after it, the highest rank comes last. So a pair of inserts from a high rank encloses a pair from a low rank. The code before all text and the code after all text are such a pair around the whole text: with `insertAfter(0, code)` the highest rank comes first, although `insertAfter` at any other offset puts it last.
- **One writer does not nest its own wraps.** A writer keeps call order on both sides, so wrapping `x` in `(` and `)` and then in `[` and `]` with one writer gives `([x)]`, not `[(x)]`. Give each nesting level its own rank.
- **Removals add up and cannot be undone, and two replaces at one place both render.** No edit can cancel another, so edits of different writers can be made in any order.
- **A view renders cut text only where its slice is placed.** The text of a cut belongs to its slice. `render(start, end, sink)` of a range inside a cut gives none of that text. At most it gives the placeholder of the cut, when the range starts where the cut starts. To get the text, render the slice, or a view that contains the place of the slice.
- **A slice of a whole text leaves out the code at the top and bottom.** `cut(0, source.content.length)` takes the text and the code attached to its characters. Code from `insertAfter(0, code)` and `insertBefore(source.content.length, code)` is attached to no character. To put one rewrite into another, render it and insert the pieces: `inner.render(0, length, piece => outer.insertBefore(offset, piece));`
- **Placing a slice at its own first or last character is an error.** `insertBefore(offset, code)` attaches code to the character at `offset`. If that character is the first one of the slice, the code is inside the slice. Giving this one case another meaning would make an insert depend on what it inserts. To place a slice right before or after its own range, use the other insert: `insertAfter(start, slice)` or `insertBefore(end, slice)`.
- **Source maps tell sources apart by object.** Two source objects with the same name are two entries in `sources`. Pass the same object for the same file.
- **When the last line of the text ends in new text, `mappings` has one more line than the text.** The map would otherwise end with a segment without a source, and Node's source map reader treats such a segment as mapped to the source position before it. The extra empty line avoids that.

## Coming from a mutable string editor

All offsets point into the original text, even after edits.

| To | Write |
|---|---|
| overwrite a range | `replace(start, end, text)`, or `replace(start, end, { source, start, end, text })` to map it |
| remove a range | `replace(start, end, '')` |
| prepend or append | `insertAfter(0, code)` or `insertBefore(source.content.length, code)` |
| insert at an offset | `insertBefore(offset, code)` or `insertAfter(offset, code)` |
| move a range up | `insertAfter(to, rewrite.cut(start, end))` |
| move a range down | `insertBefore(to, rewrite.cut(start, end))` |
| read the result | `rewrite.render(0, source.content.length, piece => text += rewritePieceText(piece))` |
| get a source map | `renderWithSourceMap` (see above) |
| get decoded segments | `renderWithDecodedSourceMap` |
| read segments from a map | `decodeMappings(mappings)` |

## Reference

### Creating and editing

- `createSourceRewrite<S, Data>(source)` — create a rewrite for a source object
- `rewrite.writer(rank)` — create a writer with its own rank (lower ranks nest inside higher)
- `insertBefore(offset, code)` — attach code before the character at `offset`
- `insertAfter(offset, code)` — attach code after the character before `offset`
- `replace(start, end, code)` — remove the range and insert `code` in its place
- `cut(start, end, options?)` — remove a range and return a slice you can place elsewhere
  - `options.placeholder` — code that renders where the cut was made
- `unrendered()` — list slices that haven't been rendered yet

### Rendering

- `render(start, end, sink, data?)` — call `sink(piece)` for each piece in the range
- `slice.render(sink)` — call `sink(piece)` for each piece of a slice
- `rewritePieceText(piece)` — extract the text from a piece (string or range)

### Pieces

Pieces are either strings or ranges:

```ts
type Piece<Origin = unknown> = string | (Origin & { start: number; end: number; text?: string });
```

- String: new text with no source mapping
- Range without `text`: kept source text from `start` to `end`
- Range with `text`: generated text that maps to the source range

### Source maps

- `renderWithSourceMap(render, sourceName)` — render and generate a v3 source map
- `renderWithDecodedSourceMap(render, sourceName)` — like above, but with decoded `mappings`
- `encodeMappings(segments)` — encode decoded segments into a v3 `mappings` string
- `decodeMappings(mappings)` — decode a v3 `mappings` string into segments

The `name` field on a range with `text` goes into the map's `names` array. Use it only when renaming an identifier.

### Errors

Common errors:

- **Offset out of range** — offset is not within `0..content.length`
- **Invalid rank** — rank is negative or not an integer
- **Crossing cuts** — a cut overlaps another cut (cuts can nest but not cross)
- **Cut placed inside itself** — a slice is placed within its own range (including `insertBefore` at its start and `insertAfter` at its end), or within a slice that it renders
- **Editing while rendering** — you called an edit method from inside a `render` sink
- **Content changed** — the source content was modified after creating the rewrite

## Adoption

- [vuejs/language-tools](https://github.com/vuejs/language-tools): generates TypeScript code from Vue single-file components. Currently uses 0.4; migration to 1.0 is in progress.
- [muggle-pug](https://github.com/johnsoncodehk/muggle-pug): compiles Pug to HTML as `Piece` ranges.
