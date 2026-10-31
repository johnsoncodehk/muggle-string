import type { Piece, RewriteSource } from './types';

/**
 * What a range of a rewrite carries beyond its offsets: its source, and the fields of the consumer that the view or the
 * slice that renders it gives, none by default.
 */
export type RewriteOrigin<Source extends RewriteSource, Data = {}> = Data & { source: Source };

/** Code written into a rewrite: pieces, slices, which render their cut in place, and arrays of code. */
export type RewriteCode<Source extends RewriteSource, Data = {}> =
	| Piece<RewriteOrigin<Source, Data>>
	| RewriteSlice<Source, Data>
	| readonly RewriteCode<Source, Data>[];

/** The fields of the kept pieces of the cut, and its placeholder. */
export type RewriteCutOptions<Source extends RewriteSource, Data = {}> = Data & {
	/** The code that takes the place of the cut in the cut that contains it. */
	placeholder?: RewriteCode<Source, Data>;
};

export interface RewriteWriter<Source extends RewriteSource, Data = {}> {
	/**
	 * `code` right before the text that starts at `offset`; it goes wherever that text goes. At the end of the text,
	 * no text starts there: the code stays after all text.
	 */
	insertBefore(offset: number, code: RewriteCode<Source, Data>): void;
	/**
	 * `code` right after the text that ends at `offset`; it goes wherever that text goes. At 0, no text ends there: the
	 * code stays before all text.
	 */
	insertAfter(offset: number, code: RewriteCode<Source, Data>): void;
	/** The text at `start`..`end` (not empty) is not rendered; `code` takes the place of its first char. */
	replace(start: number, end: number, code: RewriteCode<Source, Data>): void;
}

export interface RewriteSlice<Source extends RewriteSource, Data = {}> {
	/** Passes the pieces of the slice to `sink`, in order: no string is empty, and kept text is a range without `text`. */
	render(sink: (piece: Piece<RewriteOrigin<Source, Data>>) => void): void;
}

/**
 * Edits of one source text by ranked writers. Inserts attach to a side of a char, removals add up, and text moves
 * only by slices, which nest or are disjoint, so edits never conflict. The rewrite is itself the outermost writer.
 * The first render freezes the edits.
 */
export interface SourceRewrite<Source extends RewriteSource, Data = {}> extends RewriteWriter<Source, Data> {
	/** The source that the rewrite edits, which its kept pieces carry. */
	readonly source: Source;
	/**
	 * The writer of `rank`, a non-negative integer. A higher rank sits outside a lower one, and the rewrite outside
	 * all.
	 */
	writer(rank: number): RewriteWriter<Source, Data>;
	/**
	 * The slice of `start`..`end` (not empty): its text, with the edits of all writers in it, renders where the slice is
	 * placed, exactly once, kept text with the other fields of `options`, and `placeholder` takes its place where it is cut from. Cuts are made in any
	 * order: a cut inside another moves with it, of two cuts of one range the later is inside, and a cut that crosses
	 * another throws. Text that is not wanted is removed by `replace`; a slice is cut to be placed, and `unrendered`
	 * tells one that is not.
	 *
	 * A slice that is placed in code that only its own render renders, as in its own range, throws at the first render.
	 * A rewrite has no last render, as any slice can render by itself at any time: a slice placed in code that is never
	 * rendered is not rendered, without an error.
	 */
	cut(
		start: number,
		end: number,
		...options: {} extends RewriteCutOptions<Source, Data> ? [options?: RewriteCutOptions<Source, Data>]
			: [options: RewriteCutOptions<Source, Data>]
	): RewriteSlice<Source, Data>;
	/**
	 * Passes the pieces of the text at `start`..`end`, with the edits in it, to `sink`, kept text with the fields of
	 * `data`: a view, which owns no text, so views can overlap and render again. The text of a slice renders where the
	 * slice is placed, and its placeholder in the view of its start. The code before all text renders in a view from 0,
	 * and the code after all text in a view to the end of the text.
	 */
	render(
		start: number,
		end: number,
		sink: (piece: Piece<RewriteOrigin<Source, Data>>) => void,
		...data: {} extends Data ? [data?: Data] : [data: Data]
	): void;
	/**
	 * The slices that have not rendered, in cut order: after the last render of its consumer, those that it placed
	 * nowhere, or in code that it did not render.
	 */
	unrendered(): RewriteSlice<Source, Data>[];
}

/**
 * A rewrite of the content of `source`, which must not change until the rewrite is rendered. `Data` is the fields that
 * its kept pieces carry beyond their source and offsets, which the cuts and views give.
 */
export function createSourceRewrite<
	Source extends RewriteSource,
	Data extends object = {},
>(source: Source): SourceRewrite<Source, Data> {
	const rewrite = new Rewrite<Source, Data>(source);
	return {
		...rewrite.core,
		source,
		writer: rank => rewrite.writer(rank),
		cut: (start: number, end: number, options?: RewriteCutOptions<Source, Data>) =>
			rewrite.cut(start, end, (options ?? {}) as RewriteCutOptions<Source, Data>),
		render: (start: number, end: number, sink: Sink<Source, Data>, data?: Data) =>
			rewrite.render(start, end, data ?? {} as Data, sink),
		unrendered: () => rewrite.cuts.filter(cut => cut.state === CutState.Unrendered),
	};
}

type Sink<Source extends RewriteSource, Data> = (piece: Piece<RewriteOrigin<Source, Data>>) => void;

/** The generated text of `piece`: new text, the `text` of a range, or the content of its source that it keeps. */
export function rewritePieceText(piece: Piece<{ source: RewriteSource }>): string {
	return typeof piece === 'string' ? piece : piece.text ?? piece.source.content.slice(piece.start, piece.end);
}

const coreRank = 0x7fffffff;

// the sides of a char, in render order: code before the text that starts at the char, replacement code in the place
// of the char, code after the text that ends at the char
const enum Side {
	Before,
	Slot,
	After,
}

/**
 * The edits of one writer by column, in call order, which is the order of equal keys; its rank is the same for all.
 * An edit is anchored at a side of a char, as the key `at * 4 + side`, which sorts in render order; keys are below
 * 2 ** 31, as text is shorter than 2 ** 29. `insertAfter(0)` anchors before the char -1, so it renders before all
 * text, and `insertBefore(length)` after the char `length`, so it renders after all text.
 */
class Edits<Source extends RewriteSource, Data> {
	/** The keys of the edits, as many as `code`. */
	keys = new Int32Array(16);
	code: RewriteCode<Source, Data>[] = [];
	/** Whether the edits arrived in render order. */
	sorted = true;

	constructor(
		readonly rank: number,
		/** The writer that adds the edits. */
		readonly writer: RewriteWriter<Source, Data>,
	) {}

	add(at: number, side: Side, code: RewriteCode<Source, Data>) {
		let keys = this.keys;
		const size = this.code.length;
		const key = at * 4 + side;
		if (size && key < keys[size - 1]!) {
			this.sorted = false;
		}
		if (size === keys.length) {
			keys = new Int32Array(size * 2);
			keys.set(this.keys);
			this.keys = keys;
		}
		keys[size] = key;
		this.code.push(code);
	}

	/** The first index from `low` whose anchor is at or after the char `offset`. */
	lowerBound(offset: number, low: number) {
		const keys = this.keys;
		const key = offset * 4;
		let high = this.code.length;
		while (low < high) {
			const mid = (low + high) >>> 1;
			if (keys[mid]! < key) {
				low = mid + 1;
			}
			else {
				high = mid;
			}
		}
		return low;
	}

	/** Sorts the edits, which usually arrive in order. */
	sort() {
		if (this.sorted) {
			return;
		}
		const { keys, code } = this;
		const size = code.length;
		const sorted: number[] = [];
		for (let index = 0; index < size; index++) {
			sorted.push(index);
		}
		sorted.sort((a, b) => keys[a]! - keys[b]! || a - b);
		const sortedKeys = new Int32Array(size);
		const sortedCode: RewriteCode<Source, Data>[] = [];
		for (let index = 0; index < size; index++) {
			sortedKeys[index] = keys[sorted[index]!]!;
			sortedCode.push(code[sorted[index]!]!);
		}
		this.keys = sortedKeys;
		this.code = sortedCode;
	}
}

class Rewrite<Source extends RewriteSource, Data> {
	/** The writer of the outermost rank, which the rewrite is. */
	readonly core: RewriteWriter<Source, Data>;
	/** The edits of each writer, by rank. */
	edits = new Map<number, Edits<Source, Data>>();
	/** When frozen, the edits of each writer that has some, sorted. */
	writerEdits: Edits<Source, Data>[] = [];
	/** Removed ranges as flat start, end pairs; sorted and merged when frozen. */
	removals = new Int32Array(16);
	removalsSize = 0;
	/** Whether the removals arrived in order of start. */
	removalsSorted = true;
	/** The cuts, in call order. */
	cuts: Cut<Source, Data>[] = [];
	/** The outermost cuts, sorted and disjoint. */
	roots: Cut<Source, Data>[] = [];
	frozen = false;
	/** What the first render threw, which every render throws. */
	error: unknown;

	constructor(readonly source: Source) {
		this.core = this.createEdits(coreRank).writer;
	}

	writer(rank: number): RewriteWriter<Source, Data> {
		if (!Number.isInteger(rank) || rank < 0 || rank >= coreRank) {
			throw new RangeError(`The rank ${rank} is not a non-negative integer below the rank of the rewrite.`);
		}
		return (this.edits.get(rank) ?? this.createEdits(rank)).writer;
	}

	private createEdits(rank: number) {
		const writer: RewriteWriter<Source, Data> = {
			insertBefore: (offset, code) => {
				this.check(offset, offset);
				edits.add(offset, offset === this.source.content.length ? Side.After : Side.Before, code);
			},
			insertAfter: (offset, code) => {
				this.check(offset, offset);
				edits.add(offset ? offset - 1 : -1, offset ? Side.After : Side.Before, code);
			},
			replace: (start, end, code) => {
				this.check(start, end);
				if (start === end) {
					throw new RangeError(`The replace at ${start} removes no char.`);
				}
				edits.add(start, Side.Slot, code);
				this.addRemoval(start, end);
			},
		};
		const edits = new Edits(rank, writer);
		this.edits.set(rank, edits);
		return edits;
	}

	private check(start: number, end: number) {
		if (this.frozen) {
			throw new Error('The rewrite is already rendered.');
		}
		checkRange(start, end, 0, this.source.content.length, `${start === end ? `The offset ${start}` : `The range ${start}..${end}`} is out of 0..${this.source.content.length}.`);
	}

	/**
	 * The cut of `start`..`end`, inside the innermost cut that holds the range, around the cuts in the range; the cuts
	 * of each level stay sorted and disjoint.
	 */
	cut(start: number, end: number, { placeholder, ...data }: RewriteCutOptions<Source, Data>) {
		if (this.frozen) {
			throw new Error('The rewrite is already rendered.');
		}
		checkRange(start, end, 0, this.source.content.length, `The range ${start}..${end} is out of 0..${this.source.content.length}.`);
		if (start === end) {
			throw new RangeError(`The cut at ${start} moves no char.`);
		}
		let parent: Cut<Source, Data> | undefined;
		let siblings = this.roots;
		while (true) {
			let low = 0;
			let high = siblings.length;
			while (low < high) {
				const mid = (low + high) >>> 1;
				if (siblings[mid]!.end <= start) {
					low = mid + 1;
				}
				else {
					high = mid;
				}
			}
			const first = siblings[low];
			if (first && first.start <= start && end <= first.end) {
				parent = first;
				siblings = first.children ??= [];
				continue;
			}
			let last = low;
			for (; last < siblings.length && siblings[last]!.start < end; last++) {
				const inner = siblings[last]!;
				if (inner.start < start || inner.end > end) {
					throw new RangeError(`The cut ${start}..${end} crosses ${nameCut(inner).toLowerCase()}.`);
				}
			}
			const cut = new Cut<Source, Data>(this, parent, start, end, data as Data, placeholder);
			const held = siblings.splice(low, last - low, cut);
			if (held.length) {
				cut.children = held;
				for (const inner of held) {
					inner.parent = cut;
				}
			}
			this.cuts.push(cut);
			return cut;
		}
	}

	/** The view `start`..`end`. */
	render(start: number, end: number, data: Data, sink: (piece: Piece<RewriteOrigin<Source, Data>>) => void) {
		const { length } = this.source.content;
		checkRange(start, end, 0, length, `The range ${start}..${end} is out of 0..${length}.`);
		this.freeze();
		renderDepth++;
		try {
			renderRange(this, new Walker(this, sink), start, end, this.roots, data, start === 0, end === length);
		}
		finally {
			renderDepth--;
		}
	}

	private addRemoval(start: number, end: number) {
		const size = this.removalsSize;
		if (size && start < this.removals[size - 2]!) {
			this.removalsSorted = false;
		}
		if (size === this.removals.length) {
			const removals = new Int32Array(size * 2);
			removals.set(this.removals);
			this.removals = removals;
		}
		this.removals[size] = start;
		this.removals[size + 1] = end;
		this.removalsSize = size + 2;
	}

	freeze() {
		if (this.frozen) {
			if (this.error) {
				throw this.error;
			}
			return;
		}
		this.frozen = true;
		this.writerEdits = [...this.edits.values()].filter(edits => edits.code.length);
		for (const edits of this.writerEdits) {
			edits.sort();
		}
		this.mergeRemovals();
		try {
			this.checkPlacements();
		}
		catch (error) {
			this.error = error;
			throw error;
		}
	}

	/**
	 * Throws for a cut that only its own render would render: placed in code that it renders, directly or through the
	 * cuts placed in it. Code at a char renders in the innermost cut that owns the char, and a placeholder in the cut
	 * around its own.
	 */
	private checkPlacements() {
		if (!this.cuts.length) {
			return;
		}
		/** The cuts that have renderers. */
		const placed: Cut<Source, Data>[] = [];
		const held: Cut<Source, Data>[] = [];
		const collect = (code: RewriteCode<Source, Data>) => {
			if (typeof code === 'string') {
				return;
			}
			if (isCodeArray<Source, Data>(code)) {
				for (let index = 0; index < code.length; index++) {
					collect(code[index]!);
				}
			}
			else if (code instanceof Cut && code.rewrite === this) {
				held.push(code);
			}
		};
		const place = (renderer: Cut<Source, Data> | undefined) => {
			if (renderer) {
				for (const cut of held) {
					if (cut.renderers) {
						cut.renderers.push(renderer);
					}
					else {
						cut.renderers = [renderer];
						placed.push(cut);
					}
				}
			}
			held.length = 0;
		};
		for (const { keys, code } of this.writerEdits) {
			for (let index = 0; index < code.length; index++) {
				collect(code[index]!);
				if (held.length) {
					place(this.ownerOf(keys[index]! >> 2));
				}
			}
		}
		for (const cut of this.cuts) {
			if (cut.placeholder !== undefined) {
				collect(cut.placeholder);
				place(cut.parent);
			}
		}
		/** The walked cuts, each with the index of its next renderer. */
		const path: Cut<Source, Data>[] = [];
		const next: number[] = [];
		for (const first of placed) {
			if (first.visit) {
				continue;
			}
			first.visit = Visit.Walking;
			path.push(first);
			next.push(0);
			while (path.length) {
				const top = path.length - 1;
				const renderers = path[top]!.renderers;
				if (!renderers || next[top] === renderers.length) {
					path.pop()!.visit = Visit.Done;
					next.pop();
					continue;
				}
				const renderer = renderers[next[top]!++]!;
				if (renderer.visit === Visit.Walking) {
					throw new Error(`${nameCut(renderer)} is placed inside itself, so it never renders.`);
				}
				if (!renderer.visit) {
					renderer.visit = Visit.Walking;
					path.push(renderer);
					next.push(0);
				}
			}
		}
	}

	/**
	 * The cut that renders the code at the char `at`, none for a view: -1 is before all text, and the length after all
	 * text, which no cut owns.
	 */
	private ownerOf(at: number) {
		let owner: Cut<Source, Data> | undefined;
		let siblings: Cut<Source, Data>[] | undefined = at === -1 || at === this.source.content.length ? undefined : this.roots;
		while (siblings) {
			let low = 0;
			let high = siblings.length;
			while (low < high) {
				const mid = (low + high) >>> 1;
				if (siblings[mid]!.end <= at) {
					low = mid + 1;
				}
				else {
					high = mid;
				}
			}
			const sibling: Cut<Source, Data> | undefined = siblings[low];
			if (!sibling || sibling.start > at) {
				break;
			}
			owner = sibling;
			siblings = sibling.children;
		}
		return owner;
	}

	private mergeRemovals() {
		let removals = this.removals;
		const pairs = this.removalsSize >> 1;
		if (!this.removalsSorted) {
			const sorted: number[] = [];
			for (let pair = 0; pair < pairs; pair++) {
				sorted.push(pair);
			}
			sorted.sort((a, b) => removals[2 * a]! - removals[2 * b]!);
			const copy = new Int32Array(2 * pairs);
			for (let index = 0; index < pairs; index++) {
				copy[2 * index] = removals[2 * sorted[index]!]!;
				copy[2 * index + 1] = removals[2 * sorted[index]! + 1]!;
			}
			removals = copy;
		}
		let merged = 0;
		for (let pair = 0; pair < pairs; pair++) {
			const start = removals[2 * pair]!;
			const end = removals[2 * pair + 1]!;
			if (merged && start <= removals[merged - 1]!) {
				if (end > removals[merged - 1]!) {
					removals[merged - 1] = end;
				}
			}
			else {
				removals[merged++] = start;
				removals[merged++] = end;
			}
		}
		this.removals = removals;
		this.removalsSize = merged;
	}
}

// the walk of the renderers of the cuts, which finds a cut that leads back to itself
const enum Visit {
	Unvisited,
	Walking,
	Done,
}

const enum CutState {
	Unrendered,
	Rendering,
	Placed,
	RenderedByItself,
}

/** How deep the current render is in the renders of slices placed in code, across rewrites; 0 outside renders. */
let renderDepth = 0;

function nameCut(cut: { start: number; end: number }) {
	return `The cut ${cut.start}..${cut.end}`;
}

function checkRange(start: number, end: number, min: number, max: number, message: string) {
	if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || start > end || end > max) {
		throw new RangeError(message);
	}
}

class Cut<Source extends RewriteSource, Data> implements RewriteSlice<Source, Data> {
	/** The cuts directly inside, sorted and disjoint. */
	children: Cut<Source, Data>[] | undefined;
	/** The cuts whose render renders code that it is placed in. */
	renderers: Cut<Source, Data>[] | undefined;
	visit = Visit.Unvisited;
	state = CutState.Unrendered;

	constructor(
		readonly rewrite: Rewrite<Source, Data>,
		/** The cut that contains it directly, which renders its placeholder; none for a view. */
		public parent: Cut<Source, Data> | undefined,
		readonly start: number,
		readonly end: number,
		readonly data: Data,
		readonly placeholder: RewriteCode<Source, Data> | undefined,
	) {}

	render(sink: (piece: Piece<RewriteOrigin<Source, Data>>) => void) {
		this.rewrite.freeze();
		const byItself = !renderDepth;
		if (this.state === CutState.Rendering) {
			throw new Error(`${nameCut(this)} is placed inside itself, so it never renders.`);
		}
		if (this.state === CutState.Placed && !byItself) {
			throw new Error(`${nameCut(this)} is placed twice.`);
		}
		if (this.state !== CutState.Unrendered) {
			throw new Error(`${nameCut(this)} is already rendered; a slice renders once.`);
		}
		this.state = CutState.Rendering;
		renderDepth++;
		try {
			renderRange(this.rewrite, new Walker(this.rewrite, sink), this.start, this.end, this.children ?? [], this.data, false, false);
		}
		finally {
			renderDepth--;
			this.state = byItself ? CutState.RenderedByItself : CutState.Placed;
		}
	}
}

/** The state of one render: the sink, and the position in the text and in the removals. */
class Walker<Source extends RewriteSource, Data> {
	readonly source: Source;
	readonly removals: Int32Array;
	readonly removalsSize: number;
	pos = 0;
	/** The first removal that ends after `pos`. */
	removal = 0;

	constructor(rewrite: Rewrite<Source, Data>, readonly sink: (piece: Piece<RewriteOrigin<Source, Data>>) => void) {
		this.source = rewrite.source;
		this.removals = rewrite.removals;
		this.removalsSize = rewrite.removalsSize;
	}

	/** Moves to `pos`, in a cut whose kept chars start there. */
	seek(pos: number) {
		const removals = this.removals;
		let low = 0;
		let high = this.removalsSize >> 1;
		while (low < high) {
			const mid = (low + high) >>> 1;
			if (removals[2 * mid + 1]! <= pos) {
				low = mid + 1;
			}
			else {
				high = mid;
			}
		}
		this.pos = pos;
		this.removal = low * 2;
	}

	/** The kept chars from `pos` to `to`, with the fields of `data`. */
	keep(to: number, data: Data) {
		const { removals, removalsSize: size, sink, source } = this;
		let { pos, removal } = this;
		while (pos < to) {
			while (removal < size && removals[removal + 1]! <= pos) {
				removal += 2;
			}
			if (removal < size && removals[removal]! <= pos) {
				pos = removals[removal + 1]! < to ? removals[removal + 1]! : to;
				continue;
			}
			const stop = removal < size && removals[removal]! < to ? removals[removal]! : to;
			sink({ ...data, source, start: pos, end: stop });
			pos = stop;
		}
		this.pos = pos;
		this.removal = removal;
	}
}

/**
 * The text at `start`..`end` with the edits in it, but for the text of `children`, the cuts in it, sorted and
 * disjoint, of which a view skips the one that it starts inside; their placeholders render in their place. `head` and
 * `tail` render the code before and after all text.
 */
function renderRange<Source extends RewriteSource, Data>(
	rewrite: Rewrite<Source, Data>,
	walker: Walker<Source, Data>,
	start: number,
	end: number,
	children: readonly Cut<Source, Data>[],
	data: Data,
	head: boolean,
	tail: boolean,
) {
	const writers = rewrite.writerEdits;
	let index = 0;
	let high = children.length;
	while (index < high) {
		const mid = (index + high) >>> 1;
		if (children[mid]!.end <= start) {
			index = mid + 1;
		}
		else {
			high = mid;
		}
	}
	let pos = start;
	const first = children[index];
	if (first && first.start < start) {
		pos = first.end < end ? first.end : end;
		index++;
	}
	walker.seek(pos);
	/** The next edit of each writer. */
	const next: number[] = [];
	for (const edits of writers) {
		next.push(head ? 0 : edits.lowerBound(pos, 0));
	}
	for (;; index++) {
		const child = children[index];
		const stop = child && child.start < end ? child.start : end;
		renderEdits(writers, next, stop * 4, walker, data, true);
		walker.keep(stop, data);
		if (stop === end) {
			break;
		}
		if (child!.placeholder !== undefined) {
			renderCode(child!.placeholder, walker.sink);
		}
		pos = child!.end < end ? child!.end : end;
		walker.seek(pos);
		for (let writer = 0; writer < writers.length; writer++) {
			next[writer] = writers[writer]!.lowerBound(pos, next[writer]!);
		}
	}
	if (tail) {
		renderEdits(writers, next, Infinity, walker, data, false);
	}
}

/**
 * The edits of all writers from `next` to the key `last`, in render order: at one side of one char, the code before
 * the text goes outermost (highest rank) first, and the code in the place of the char and after the text innermost
 * first. With `keep`, the kept text up to the anchor of each, with `data`, before it.
 */
function renderEdits<Source extends RewriteSource, Data>(
	writers: Edits<Source, Data>[],
	next: number[],
	last: number,
	walker: Walker<Source, Data>,
	data: Data,
	keep: boolean,
) {
	while (true) {
		let best = -1;
		let bestKey = last;
		// the first key of the other writers, up to which the best one renders its run
		let bound = last;
		for (let writer = 0; writer < writers.length; writer++) {
			const { keys, code, rank } = writers[writer]!;
			const edit = next[writer]!;
			if (edit < code.length) {
				const key = keys[edit]!;
				if (
					key < bestKey || (key === bestKey && best !== -1 && (
						(key & 3) === Side.Before ? rank > writers[best]!.rank : rank < writers[best]!.rank
					))
				) {
					if (best !== -1) {
						bound = bestKey;
					}
					best = writer;
					bestKey = key;
				}
				else if (key < bound) {
					bound = key;
				}
			}
		}
		if (best === -1) {
			return;
		}
		const { keys, code } = writers[best]!;
		let edit = next[best]!;
		// an edit at `bound` itself may lose to the other writer there: it is chosen again
		do {
			const key = keys[edit]!;
			if (keep) {
				walker.keep((key >> 2) + ((key & 3) === Side.After ? 1 : 0), data);
			}
			renderCode(code[edit++]!, walker.sink);
		}
		while (edit < code.length && keys[edit]! < bound);
		next[best] = edit;
	}
}

function renderCode<Source extends RewriteSource, Data>(code: RewriteCode<Source, Data>, sink: (piece: Piece<RewriteOrigin<Source, Data>>) => void) {
	if (typeof code === 'string') {
		if (code) {
			sink(code);
		}
	}
	else if (isCodeArray<Source, Data>(code)) {
		for (let index = 0; index < code.length; index++) {
			renderCode(code[index]!, sink);
		}
	}
	else if (isSlice<Source, Data>(code)) {
		code.render(sink);
	}
	else {
		sink(code as Piece<RewriteOrigin<Source, Data>>);
	}
}

function isCodeArray<Source extends RewriteSource, Data>(code: RewriteCode<Source, Data>): code is readonly RewriteCode<Source, Data>[] {
	return Array.isArray(code);
}

function isSlice<Source extends RewriteSource, Data>(code: RewriteCode<Source, Data>): code is RewriteSlice<Source, Data> {
	return typeof (code as RewriteSlice<Source, Data>).render === 'function';
}
