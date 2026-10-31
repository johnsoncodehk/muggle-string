import type { Piece, RewriteSource } from './types';

/** Code written into a rewrite: pieces, slices, which render their cut in place, and arrays of code. */
export type RewriteCode<Source extends RewriteSource, Data> =
	| Piece<{ source: Source; data: Data }>
	| RewriteSlice<Source, Data>
	| readonly RewriteCode<Source, Data>[];

export interface RewriteCutOptions<Source extends RewriteSource, Data> {
	/** The data of the kept pieces of the cut. */
	data: Data;
	/** The code that takes the place of the cut in the cut that contains it. */
	placeholder?: RewriteCode<Source, Data>;
}

export interface RewriteWriter<Source extends RewriteSource, Data> {
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
	/**
	 * The text at `start`..`end`, with the edits of all writers in it, rendered where the returned slice is placed,
	 * exactly once. In the cut that contains it, `placeholder` takes its place. The cuts of all writers are nested or
	 * disjoint, which the first render checks, and of two cuts of one range the later is inside the earlier. A
	 * zero-width cut owns no char and has no placeholder; on an empty text, the first one renders the inserts.
	 *
	 * A slice that is placed in code that only its own render renders, as in its own range, throws at the first render.
	 * A rewrite has no last render, as any slice can render by itself at any time: the text of a cut that is never
	 * rendered, or placed in code that is never rendered, is not rendered, without an error.
	 */
	cut(start: number, end: number, options: RewriteCutOptions<Source, Data>): RewriteSlice<Source, Data>;
	/** A cut whose kept pieces have `undefined` as data, by a writer whose data can be `undefined`. */
	cut(
		this: { cut(start: number, end: number, options: RewriteCutOptions<Source, undefined>): unknown },
		start: number,
		end: number,
		options?: Omit<RewriteCutOptions<Source, Data>, 'data'>,
	): RewriteSlice<Source, Data>;
}

export interface RewriteSlice<Source extends RewriteSource, Data> {
	/** Passes the pieces of the slice to `sink`, in order: no string is empty, and kept text is a range without `text`. */
	render(sink: (piece: Piece<{ source: Source; data: Data }>) => void): void;
}

/**
 * Edits of one source text by ranked writers. Inserts attach to a side of a char, removals add up, and text moves
 * only by nested cuts, so edits never conflict. The rewrite is itself the outermost writer. The first render freezes
 * the edits.
 */
export interface SourceRewrite<Source extends RewriteSource, Data> extends RewriteWriter<Source, Data> {
	/**
	 * The writer of `rank`, a non-negative integer. A higher rank sits outside a lower one, and the rewrite outside
	 * all.
	 */
	writer(rank: number): RewriteWriter<Source, Data>;
}

/** A rewrite of the content of `source`, which must not change until the rewrite is rendered. */
export function createSourceRewrite<Source extends RewriteSource, Data>(source: Source): SourceRewrite<Source, Data> {
	const rewrite = new Rewrite<Source, Data>(source);
	return { ...rewrite.core, writer: rank => rewrite.writer(rank) };
}

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
	/** The cuts that own chars, in call order until frozen, then sorted by start, outer first. */
	cuts: Cut<Source, Data>[] = [];
	/** Whether the cuts arrived sorted. */
	cutsSorted = true;
	/** When frozen, the top-level cuts, sorted and disjoint. */
	roots: Cut<Source, Data>[] = [];
	/** On an empty text: the first zero-width cut, which renders the inserts. */
	firstEmpty: Cut<Source, Data> | undefined;
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
			cut: (start: number, end: number, options?: Partial<RewriteCutOptions<Source, Data>>) => {
				this.check(start, end);
				const placeholder = options?.placeholder;
				// `data` is left out only by a writer whose data can be `undefined`
				const cut = new Cut(this, start, end, options?.data as Data, placeholder);
				if (start === end) {
					if (placeholder !== undefined) {
						throw new RangeError(`The empty cut at ${start} cannot have a placeholder.`);
					}
					if (!this.source.content.length) {
						this.firstEmpty ??= cut;
					}
				}
				else {
					const last = this.cuts[this.cuts.length - 1];
					if (last && (start < last.start || (start === last.start && end > last.end))) {
						this.cutsSorted = false;
					}
					this.cuts.push(cut);
				}
				return cut;
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
		if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || end > this.source.content.length) {
			throw new RangeError(`${start === end ? `The offset ${start}` : `The range ${start}..${end}`} is out of 0..${this.source.content.length}.`);
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
			this.buildCuts();
			this.checkPlacements();
		}
		catch (error) {
			this.error = error;
			throw error;
		}
	}

	/**
	 * Nests the cuts. Sorted by start, outer first (of one range, the earlier), each cut lies in the innermost open cut
	 * that has not ended before it starts, or crosses it.
	 */
	private buildCuts() {
		const cuts = this.cuts;
		if (!this.cutsSorted) {
			const order = new Map(cuts.map((cut, index) => [cut, index]));
			cuts.sort((a, b) => a.start - b.start || b.end - a.end || order.get(a)! - order.get(b)!);
		}
		const open: Cut<Source, Data>[] = [];
		for (const cut of cuts) {
			while (open.length && open[open.length - 1]!.end <= cut.start) {
				open.pop();
			}
			const parent = open[open.length - 1];
			if (!parent) {
				this.roots.push(cut);
			}
			else if (cut.end > parent.end) {
				throw new RangeError(
					`The cuts ${parent.start}..${parent.end} and ${cut.start}..${cut.end} cross; cuts are nested or disjoint.`,
				);
			}
			else {
				cut.parent = parent;
				(parent.children ??= []).push(cut);
			}
			open.push(cut);
		}
	}

	/**
	 * Throws for a cut that only its own render would render: placed in code that it renders, directly or through the
	 * cuts placed in it. Code at a char renders in the innermost cut that owns the char, and a placeholder in the cut
	 * around its own.
	 */
	private checkPlacements() {
		if (!this.cuts.length && !this.firstEmpty) {
			return;
		}
		/** The cuts that render the code that each cut is placed in. */
		const renderers = new Map<Cut<Source, Data>, Cut<Source, Data>[]>();
		const held: Cut<Source, Data>[] = [];
		const collect = (code: RewriteCode<Source, Data>) => {
			if (typeof code === 'string') {
				return;
			}
			if (isCodeArray(code)) {
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
					const list = renderers.get(cut);
					if (list) {
						list.push(renderer);
					}
					else {
						renderers.set(cut, [renderer]);
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
		/** 1 while the renderers of a cut are walked, 2 once none of them leads back to it. */
		const visited = new Map<Cut<Source, Data>, 1 | 2>();
		for (const first of renderers.keys()) {
			if (visited.has(first)) {
				continue;
			}
			visited.set(first, 1);
			const path: [Cut<Source, Data>, number][] = [[first, 0]];
			while (path.length) {
				const top = path[path.length - 1]!;
				const list = renderers.get(top[0]);
				if (!list || top[1] === list.length) {
					visited.set(top[0], 2);
					path.pop();
					continue;
				}
				const renderer = list[top[1]++]!;
				const seen = visited.get(renderer);
				if (seen === 1) {
					throw new Error(`${nameCut(renderer)} is placed inside itself, so it never renders.`);
				}
				if (!seen) {
					visited.set(renderer, 1);
					path.push([renderer, 0]);
				}
			}
		}
	}

	/** The cut that renders the code at the char `at`: -1 is before all text, and the length after all text. */
	private ownerOf(at: number) {
		const roots = this.roots;
		if (!roots.length) {
			return this.source.content.length ? undefined : this.firstEmpty;
		}
		if (at === -1) {
			return roots[0]!.start === 0 ? roots[0] : undefined;
		}
		if (at === this.source.content.length) {
			return roots[roots.length - 1]!.end === at ? roots[roots.length - 1] : undefined;
		}
		let owner: Cut<Source, Data> | undefined;
		let siblings: Cut<Source, Data>[] | undefined = roots;
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

const enum CutState {
	Unrendered,
	Rendering,
	Placed,
	RenderedByItself,
}

/** How deep the current render is in the renders of slices placed in code, across rewrites; 0 outside renders. */
let renderDepth = 0;

function nameCut(cut: { start: number; end: number }) {
	return cut.start === cut.end ? `The cut at ${cut.start}` : `The cut ${cut.start}..${cut.end}`;
}

class Cut<Source extends RewriteSource, Data> implements RewriteSlice<Source, Data> {
	/** The cut that contains it directly, which renders its placeholder. */
	parent: Cut<Source, Data> | undefined;
	/** The cuts directly inside, sorted and disjoint. */
	children: Cut<Source, Data>[] | undefined;
	state = CutState.Unrendered;

	constructor(
		readonly rewrite: Rewrite<Source, Data>,
		readonly start: number,
		readonly end: number,
		readonly data: Data,
		readonly placeholder: RewriteCode<Source, Data> | undefined,
	) {}

	render(sink: (piece: Piece<{ source: Source; data: Data }>) => void) {
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
			renderCut(this, new Walker(this.rewrite, sink));
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

	constructor(rewrite: Rewrite<Source, Data>, readonly sink: (piece: Piece<{ source: Source; data: Data }>) => void) {
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

	/** The kept chars from `pos` to `to`, with `data`. */
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
			sink({ source, start: pos, end: stop, data });
			pos = stop;
		}
		this.pos = pos;
		this.removal = removal;
	}
}

function renderCut<Source extends RewriteSource, Data>(cut: Cut<Source, Data>, walker: Walker<Source, Data>) {
	const rewrite = cut.rewrite;
	const { writerEdits: writers, roots } = rewrite;
	const { start, end, children, data } = cut;
	/** The next edit of each writer. */
	const next: number[] = [];
	if (start === end) {
		if (cut === rewrite.firstEmpty) {
			for (let writer = 0; writer < writers.length; writer++) {
				next.push(0);
			}
			renderEdits(writers, next, Infinity, walker, cut.data, false);
		}
		return;
	}
	walker.seek(start);
	for (const edits of writers) {
		next.push(start === 0 && cut === roots[0] ? 0 : edits.lowerBound(start, 0));
	}
	for (let index = 0;; index++) {
		const child = children?.[index];
		renderEdits(writers, next, (child ? child.start : end) * 4, walker, data, true);
		if (!child) {
			break;
		}
		walker.keep(child.start, data);
		if (child.placeholder !== undefined) {
			renderCode(child.placeholder, walker.sink);
		}
		walker.seek(child.end);
		for (let writer = 0; writer < writers.length; writer++) {
			next[writer] = writers[writer]!.lowerBound(child.end, next[writer]!);
		}
	}
	walker.keep(end, data);
	if (end === rewrite.source.content.length && cut === roots[roots.length - 1]) {
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

function renderCode<Source extends RewriteSource, Data>(code: RewriteCode<Source, Data>, sink: (piece: Piece<{ source: Source; data: Data }>) => void) {
	if (typeof code === 'string') {
		if (code) {
			sink(code);
		}
	}
	else if (isCodeArray(code)) {
		for (let index = 0; index < code.length; index++) {
			renderCode(code[index]!, sink);
		}
	}
	else if (isSlice(code)) {
		code.render(sink);
	}
	else {
		sink(code as Piece<{ source: Source; data: Data }>);
	}
}

function isCodeArray<Source extends RewriteSource, Data>(code: RewriteCode<Source, Data>): code is readonly RewriteCode<Source, Data>[] {
	return Array.isArray(code);
}

function isSlice<Source extends RewriteSource, Data>(code: RewriteCode<Source, Data>): code is RewriteSlice<Source, Data> {
	return typeof (code as RewriteSlice<Source, Data>).render === 'function';
}
