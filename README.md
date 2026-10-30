Ranked, conflict-free rewrites of a source text, rendered as format-neutral segments.

muggle-string has no dependencies and knows no mapping format: a rewrite renders text and source runs to a sink, and the consumer turns them into whatever its tooling maps with.

> 1.0 replaces the segment-array helpers of 0.4 (`replace`, `replaceSourceRange`, `toString`, ...). They are gone, not deprecated.

## Model

- Writers have ranks. A higher rank sits outside a lower one, and `core` sits outside all.
- `insertBefore(offset, code)` and `insertAfter(offset, code)` attach code to a side of a char, so it goes wherever that char goes. `replace(start, end, code)` removes the text and puts `code` in the place of its first char.
- Removals add up, so edits of different writers never conflict.
- Only `core` moves text, with `cut(start, end, { data, placeholder })`. Cuts are nested or disjoint. A cut renders its text, with the edits of all writers in it, wherever its slice is placed, exactly once; the cut around it renders `placeholder` instead.
- Code at the head or tail of a cut belongs to the outermost cut that has that edge.
- `order` sorts the entries of one writer at one side of one char; equal keys keep call order.
- The first render freezes the rewrite.

## Usage

```ts
import { createSourceRewrite, type MappedSegment, type Segment } from 'muggle-string';

const text = 'const props = defineProps<{ a: string }>();';
const rewrite = createSourceRewrite<string, string>('setup', text);
const { core } = rewrite;

const body = core.cut(0, text.length, { data: 'body' });
const typeArg = core.cut(text.indexOf('{'), text.lastIndexOf('}') + 1, { data: 'alias', placeholder: '__VLS_Props' });
core.insertBefore(0, () => ['type __VLS_Props = ', typeArg, ';\n']);

const segments: Segment<string, string>[] = [];
body.render({
	text: text => segments.push(text),
	source: (rewrite, start, end, data) => segments.push([rewrite.text.slice(start, end), rewrite.source, start, data]),
	segment: (segment: MappedSegment<string, string>) => segments.push(segment),
});
// type __VLS_Props = { a: string };
// const props = defineProps<__VLS_Props>();
```

Code is a string, or a function, called at most once and only if the code renders, that yields strings, mapped segments, and slices.
