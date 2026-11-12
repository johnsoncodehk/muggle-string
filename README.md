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

An empty `replace(start, end, code)` where `start === end` inserts `code` at that position without removing anything.

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

## Coming from a mutable string editor

All offsets point into the original text, even after edits.

| To | Write |
|---|---|
| overwrite a range | `replace(start, end, text)`, or `replace(start, end, { source, start, end, text })` to map it |
| remove a range | `replace(start, end, '')` |
| prepend or append | `insertAfter(0, code)` or `insertBefore(source.content.length, code)` |
| insert at an offset | `insertBefore(offset, code)` or `insertAfter(offset, code)` |
| move a range | `insertBefore(to, rewrite.cut(start, end))` |
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
- **Cut placed inside itself** — a slice is placed within its own range (including `insertBefore` at its start)
- **Editing while rendering** — you called an edit method from inside a `render` sink
- **Content changed** — the source content was modified after creating the rewrite

## Adoption

- [vuejs/language-tools](https://github.com/vuejs/language-tools): generates TypeScript code from Vue single-file components. Currently uses 0.4; migration to 1.0 is in progress.
- [muggle-pug](https://github.com/johnsoncodehk/muggle-pug): compiles Pug to HTML as `Piece` ranges.
