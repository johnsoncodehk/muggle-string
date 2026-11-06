// Micro cases: each times one cost of the library through its public API, so a change to that cost moves its case
// and few others. Text grows with the count of edits, 10 chars an edit, so the time of one edit stays comparable
// across sizes and a size where it grows shows a cost that is not linear.
import { distinctOffsets, makeSource, random, rewriteText } from './inputs.mjs';

// cuts take 20 chars each, by sourceFor(2 * cuts)
const sourceFor = size => makeSource(Math.max(1000, size * 10));
const ranged = (source, start, end, text) => ({ source, start, end, text });

/** A rewrite with `size` edits in source order from 4 writers: 40% insertBefore, 40% insertAfter, 20% replace. */
function mixedEdits(M, source, size, sorted) {
	const offsets = distinctOffsets(size, source.content.length, 5, sorted);
	const next = random(11);
	const rewrite = M.createSourceRewrite(source);
	const writers = [rewrite, rewrite.writer(1), rewrite.writer(2), rewrite.writer(3)];
	for (const at of offsets) {
		const kind = next();
		const writer = writers[Math.floor(next() * 4)];
		if (kind < 0.4) {
			writer.insertBefore(at, 'a');
		}
		else if (kind < 0.8) {
			writer.insertAfter(at, 'b');
		}
		else {
			const end = at + 1 + Math.floor(next() * 4);
			writer.replace(at, end, ranged(source, at, end, 'x'));
		}
	}
	return rewrite;
}

/** `size` replaces of 1 to 4 chars, each with a range that maps its text, as Vue's `ctx.replace` writes them. */
function smallReplaces(M, source, offsets, lengths) {
	const rewrite = M.createSourceRewrite(source);
	for (let index = 0; index < offsets.length; index++) {
		const start = offsets[index];
		const end = start + lengths[index];
		rewrite.replace(start, end, ranged(source, start, end, '__props.x'));
	}
	return rewrite;
}

function replaceInputs(size, sorted) {
	const source = sourceFor(size);
	const offsets = distinctOffsets(size, source.content.length, 5, sorted);
	const next = random(5);
	const lengths = offsets.map(() => 1 + Math.floor(next() * 4));
	return { source, offsets, lengths };
}

export const micro = [
	{
		name: 'create',
		description: 'createSourceRewrite and a render of the untouched text, per rewrite: the fixed cost of one file',
		sizes: [1000],
		smoke: 10,
		unit: 'rewrite',
		setup(M, size) {
			const sources = Array.from({ length: size }, (_, index) => ({ content: `const a${index} = 1;\n` }));
			return {
				run() {
					let length = 0;
					for (const source of sources) {
						const rewrite = M.createSourceRewrite(source);
						rewrite.render(0, source.content.length, piece => length += M.rewritePieceText(piece).length);
					}
					return length;
				},
			};
		},
	},
	{
		name: 'insert/same-offset',
		description: 'insertBefore at one offset, many times, then a render to text',
		sizes: [1000, 100_000],
		smoke: 100,
		unit: 'edit',
		setup(M, size) {
			const source = sourceFor(size);
			const at = source.content.length >> 1;
			return {
				run() {
					const rewrite = M.createSourceRewrite(source);
					for (let index = 0; index < size; index++) {
						rewrite.insertBefore(at, 'a');
					}
					return rewriteText(M, rewrite);
				},
			};
		},
	},
	{
		name: 'insert/ordered',
		description: 'insertBefore and insertAfter at distinct offsets in source order, then a render to text',
		sizes: [1000, 100_000],
		smoke: 100,
		unit: 'edit',
		setup(M, size) {
			const source = sourceFor(size);
			const offsets = distinctOffsets(size, source.content.length, 5, true);
			return {
				run() {
					const rewrite = M.createSourceRewrite(source);
					for (let index = 0; index < offsets.length; index++) {
						if (index & 1) {
							rewrite.insertAfter(offsets[index], 'b');
						}
						else {
							rewrite.insertBefore(offsets[index], 'a');
						}
					}
					return rewriteText(M, rewrite);
				},
			};
		},
	},
	{
		name: 'insert/random',
		description: 'the inserts of insert/ordered in random order, so the first render sorts them',
		sizes: [1000, 100_000],
		smoke: 100,
		unit: 'edit',
		setup(M, size) {
			const source = sourceFor(size);
			const offsets = distinctOffsets(size, source.content.length, 5, false);
			return {
				run() {
					const rewrite = M.createSourceRewrite(source);
					for (let index = 0; index < offsets.length; index++) {
						if (offsets[index] % 10 === 6) {
							rewrite.insertAfter(offsets[index], 'b');
						}
						else {
							rewrite.insertBefore(offsets[index], 'a');
						}
					}
					return rewriteText(M, rewrite);
				},
			};
		},
	},
	{
		name: 'replace/ordered',
		description: 'replaces of 1 to 4 chars with mapped text, in source order, then a render to text',
		sizes: [1000, 100_000],
		smoke: 100,
		unit: 'edit',
		setup(M, size) {
			const { source, offsets, lengths } = replaceInputs(size, true);
			return { run: () => rewriteText(M, smallReplaces(M, source, offsets, lengths)) };
		},
	},
	{
		name: 'replace/random',
		description: 'the replaces of replace/ordered in random order, so the first render sorts edits and removals',
		sizes: [1000, 100_000],
		smoke: 100,
		unit: 'edit',
		setup(M, size) {
			const { source, offsets, lengths } = replaceInputs(size, false);
			return { run: () => rewriteText(M, smallReplaces(M, source, offsets, lengths)) };
		},
	},
	{
		name: 'replace/ordered:edits',
		description: 'only the calls of replace/ordered, without a render: the cost of an edit as it is made',
		sizes: [100_000],
		smoke: 100,
		unit: 'edit',
		setup(M, size) {
			const { source, offsets, lengths } = replaceInputs(size, true);
			return {
				run: () => smallReplaces(M, source, offsets, lengths),
				output: rewrite => rewriteText(M, rewrite),
			};
		},
	},
	{
		name: 'replace/ordered:first-render',
		description: 'only the first render of replace/ordered, which sorts and compiles the edits, to text',
		sizes: [100_000],
		smoke: 100,
		unit: 'edit',
		setup(M, size) {
			const { source, offsets, lengths } = replaceInputs(size, true);
			return {
				prepare: () => smallReplaces(M, source, offsets, lengths),
				run: rewrite => rewriteText(M, rewrite),
			};
		},
	},
	{
		name: 'replace/ordered:render-again',
		description: 'a later render of replace/ordered, which reuses the compiled edits, to text',
		sizes: [100_000],
		smoke: 100,
		unit: 'edit',
		setup(M, size) {
			const { source, offsets, lengths } = replaceInputs(size, true);
			const rewrite = smallReplaces(M, source, offsets, lengths);
			rewriteText(M, rewrite);
			return { run: () => rewriteText(M, rewrite) };
		},
	},
	{
		name: 'replace/overlapping-removals',
		description:
			"replace(start, end, '') of ranges that overlap their neighbours and nest in wider ones, as Vue removes import specifiers and then their whole import",
		sizes: [1000, 100_000],
		smoke: 100,
		unit: 'edit',
		setup(M, size) {
			const source = sourceFor(size);
			const { length } = source.content;
			const groups = Math.ceil(size / 4);
			const span = Math.floor(length / groups);
			const ranges = [];
			for (let group = 0; group < groups && ranges.length < size; group++) {
				const at = group * span;
				// three specifiers, each removed up to the start of the next, then the statement around them
				ranges.push([at + 2, at + 5], [at + 4, at + 7], [at + 6, at + 8], [at + 1, at + 9]);
			}
			ranges.length = size;
			return {
				run() {
					const rewrite = M.createSourceRewrite(source);
					for (const [start, end] of ranges) {
						rewrite.replace(start, end, '');
					}
					return rewriteText(M, rewrite);
				},
			};
		},
	},
	{
		name: 'writers/stacked-insert-after',
		description:
			'insertAfter at one end by writers of rising rank, 4 deep, at many ends, as Vue closes nested awaits',
		sizes: [1000, 100_000],
		smoke: 100,
		unit: 'edit',
		setup(M, size) {
			const source = sourceFor(size);
			const ends = distinctOffsets(Math.ceil(size / 4), source.content.length, 5, true);
			return {
				run() {
					const rewrite = M.createSourceRewrite(source);
					const writers = [rewrite.writer(0), rewrite.writer(1), rewrite.writer(2), rewrite.writer(3)];
					let count = 0;
					for (const end of ends) {
						// inner awaits are left first, so the ranks rise in call order
						for (let rank = 0; rank < 4 && count < size; rank++, count++) {
							writers[rank].insertAfter(end, ')');
						}
					}
					return rewriteText(M, rewrite);
				},
			};
		},
	},
	{
		name: 'writers/mixed-ordered',
		description: 'inserts and replaces from 4 writers at distinct offsets in source order, then a render to text',
		sizes: [10_000, 100_000],
		smoke: 100,
		unit: 'edit',
		setup(M, size) {
			const source = sourceFor(size);
			return { run: () => rewriteText(M, mixedEdits(M, source, size, true)) };
		},
	},
	{
		name: 'writers/mixed-random',
		description: 'the edits of writers/mixed-ordered in random order',
		sizes: [10_000, 100_000],
		smoke: 100,
		unit: 'edit',
		setup(M, size) {
			const source = sourceFor(size);
			return { run: () => rewriteText(M, mixedEdits(M, source, size, false)) };
		},
	},
	{
		name: 'cut/move-ordered',
		description:
			'cuts of disjoint ranges in source order, each placed at once by insertBefore(0, cut), as Vue hoists imports',
		sizes: [1000, 10_000],
		smoke: 50,
		unit: 'cut',
		setup(M, size) {
			const source = sourceFor(size * 2);
			const ranges = distinctOffsets(size, source.content.length, 10, true).map(at => [at, at + 6]);
			return {
				run() {
					const rewrite = M.createSourceRewrite(source);
					for (const [start, end] of ranges) {
						rewrite.insertBefore(0, rewrite.cut(start, end));
					}
					return rewriteText(M, rewrite);
				},
			};
		},
	},
	{
		name: 'cut/move-random',
		description: 'the cuts of cut/move-ordered made in random order, so each finds its place by a search',
		sizes: [1000, 10_000],
		smoke: 50,
		unit: 'cut',
		setup(M, size) {
			const source = sourceFor(size * 2);
			const ranges = distinctOffsets(size, source.content.length, 10, false).map(at => [at, at + 6]);
			return {
				run() {
					const rewrite = M.createSourceRewrite(source);
					for (const [start, end] of ranges) {
						rewrite.insertBefore(0, rewrite.cut(start, end));
					}
					return rewriteText(M, rewrite);
				},
			};
		},
	},
	{
		name: 'cut/placed-twice',
		description: 'each cut of cut/move-ordered placed both at the start and at the end',
		sizes: [1000, 10_000],
		smoke: 50,
		unit: 'cut',
		setup(M, size) {
			const source = sourceFor(size * 2);
			const { length } = source.content;
			const ranges = distinctOffsets(size, length, 10, true).map(at => [at, at + 6]);
			return {
				run() {
					const rewrite = M.createSourceRewrite(source);
					for (const [start, end] of ranges) {
						const slice = rewrite.cut(start, end);
						rewrite.insertBefore(0, slice);
						rewrite.insertBefore(length, slice);
					}
					return rewriteText(M, rewrite);
				},
			};
		},
	},
	{
		name: 'copy/ranges-twice',
		description:
			'the ranges of cut/placed-twice inserted twice as kept ranges, as Vue copies macro arguments: the text stays where it is too',
		sizes: [1000, 10_000],
		smoke: 50,
		unit: 'range',
		setup(M, size) {
			const source = sourceFor(size * 2);
			const { length } = source.content;
			const ranges = distinctOffsets(size, length, 10, true).map(at => [at, at + 6]);
			return {
				run() {
					const rewrite = M.createSourceRewrite(source);
					for (const [start, end] of ranges) {
						rewrite.insertBefore(0, { source, start, end });
						rewrite.insertBefore(length, { source, start, end });
					}
					return rewriteText(M, rewrite);
				},
			};
		},
	},
	{
		name: 'cut/nested',
		description:
			'cuts each inside the one before, each placed at the start of the cut around it, so a render recurses through all',
		sizes: [100, 1000],
		smoke: 20,
		unit: 'cut',
		setup(M, size) {
			const source = sourceFor(size * 4);
			const { length } = source.content;
			return {
				run() {
					const rewrite = M.createSourceRewrite(source);
					let parent = 0;
					for (let depth = 0; depth < size; depth++) {
						const start = 1 + depth * 2;
						const slice = rewrite.cut(start, length - 1 - depth * 2);
						rewrite.insertBefore(parent, slice);
						parent = start;
					}
					return rewriteText(M, rewrite);
				},
			};
		},
	},
	{
		name: 'render/sink-only',
		description: 'a later render of writers/mixed-ordered to a sink that only counts lengths: the render without strings',
		sizes: [100_000],
		smoke: 100,
		unit: 'edit',
		setup(M, size) {
			const rewrite = mixedEdits(M, sourceFor(size), size, true);
			rewriteText(M, rewrite);
			const { length } = rewrite.source.content;
			return {
				run() {
					let total = 0;
					rewrite.render(0, length, piece => {
						total += typeof piece === 'string' ? piece.length : piece.end - piece.start;
					});
					return total;
				},
			};
		},
	},
	{
		name: 'render/views',
		description: '5,000 views of 200 chars of writers/mixed-ordered, rendered to text, as a language server renders blocks',
		sizes: [100_000],
		smoke: 100,
		unit: 'view',
		units: () => 5000,
		setup(M, size) {
			const rewrite = mixedEdits(M, sourceFor(size), size, true);
			rewriteText(M, rewrite);
			const { length } = rewrite.source.content;
			const next = random(3);
			const starts = Array.from({ length: 5000 }, () => Math.floor(next() * (length - 200)));
			return {
				run() {
					let text = '';
					for (const start of starts) {
						rewrite.render(start, start + 200, piece => text += M.rewritePieceText(piece));
					}
					return text;
				},
			};
		},
	},
	{
		name: 'map/rewrite',
		description:
			'renderWithSourceMap of a later render of writers/mixed-ordered: the map writer on top of render/sink-only',
		sizes: [100_000],
		smoke: 100,
		unit: 'edit',
		setup(M, size) {
			const rewrite = mixedEdits(M, sourceFor(size), size, true);
			rewriteText(M, rewrite);
			const { length } = rewrite.source.content;
			return { run: () => M.renderWithSourceMap(sink => rewrite.render(0, length, sink), source => source.name) };
		},
		output: ({ text, map }) => `${text}\n${map.mappings}\n${map.names.join()}`,
	},
	{
		name: 'map/rewrite-non-ascii',
		description: 'map/rewrite on mostly non-ASCII text, which takes the slower char classes',
		sizes: [100_000],
		smoke: 100,
		unit: 'edit',
		setup(M, size) {
			const rewrite = mixedEdits(M, makeSource(size * 10, false), size, true);
			rewriteText(M, rewrite);
			const { length } = rewrite.source.content;
			return { run: () => M.renderWithSourceMap(sink => rewrite.render(0, length, sink), source => source.name) };
		},
		output: ({ text, map }) => `${text}\n${map.mappings}`,
	},
	{
		name: 'map/decoded',
		description: 'renderWithDecodedSourceMap of map/rewrite: the segments without the v3 encoding',
		sizes: [100_000],
		smoke: 100,
		unit: 'edit',
		setup(M, size) {
			const rewrite = mixedEdits(M, sourceFor(size), size, true);
			rewriteText(M, rewrite);
			const { length } = rewrite.source.content;
			return {
				run: () => M.renderWithDecodedSourceMap(sink => rewrite.render(0, length, sink), source => source.name),
			};
		},
		output: ({ text, map }) => `${text}\n${JSON.stringify(map.mappings)}`,
	},
	{
		name: 'map/encode',
		description: 'encodeMappings of the decoded mappings of map/decoded',
		sizes: [100_000],
		smoke: 100,
		unit: 'edit',
		setup(M, size) {
			const rewrite = mixedEdits(M, sourceFor(size), size, true);
			const { length } = rewrite.source.content;
			const { mappings } = M
				.renderWithDecodedSourceMap(sink => rewrite.render(0, length, sink), source => source.name)
				.map;
			return { run: () => M.encodeMappings(mappings) };
		},
	},
	{
		name: 'map/decode',
		description: 'decodeMappings of the v3 mappings of map/rewrite',
		sizes: [100_000],
		smoke: 100,
		unit: 'edit',
		setup(M, size) {
			const rewrite = mixedEdits(M, sourceFor(size), size, true);
			const { length } = rewrite.source.content;
			const { mappings } = M.renderWithSourceMap(sink => rewrite.render(0, length, sink), source => source.name).map;
			return { run: () => M.decodeMappings(mappings) };
		},
		output: mappings => JSON.stringify(mappings),
	},
	{
		name: 'map/pieces',
		description:
			'renderWithSourceMap of a fixed array of pieces, without a rewrite, as Vue maps the code of a template',
		sizes: [10_000, 100_000],
		smoke: 100,
		unit: 'piece',
		setup(M, size) {
			const source = sourceFor(size);
			const next = random(13);
			const pieces = [];
			for (const at of distinctOffsets(size >> 1, source.content.length, 8, true)) {
				pieces.push(next() < 0.2 ? ',\n  ' : '_createVNode(');
				pieces.push(ranged(source, at, at + 3, next() < 0.5 ? '_ctx.foo' : '"div"'));
			}
			return { run: () => M.renderWithSourceMap(sink => pieces.forEach(sink), from => from.name) };
		},
		output: ({ text, map }) => `${text}\n${map.mappings}`,
	},
];
