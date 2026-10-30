import type { Piece } from './types';

/** Generated code: text, pieces, and slices, which render their cut in place. */
export type RewriteCode<Source, Data> =
	| Piece<Source, Data>
	| RewriteSlice<Source, Data>
	| readonly RewriteCode<Source, Data>[];

export interface InsertOptions {
	/** Ascending among the entries of one writer at one side of one char; equal keys keep call order. Default 0. */
	order?: number;
}

export interface CutOptions<Source, Data> {
	/** The data of the kept pieces of the cut. */
	data: Data;
	/** The code that takes the place of the cut in the cut that contains it. */
	placeholder?: RewriteCode<Source, Data>;
}

export interface RewriteWriter<Source, Data> {
	/**
	 * `code` right before the text that starts at `offset`; it goes wherever that text goes. At the end of the text,
	 * no text starts there: the code stays after all text.
	 */
	insertBefore(offset: number, code: RewriteCode<Source, Data>, options?: InsertOptions): void;
	/**
	 * `code` right after the text that ends at `offset`; it goes wherever that text goes. At 0, no text ends there: the
	 * code stays before all text.
	 */
	insertAfter(offset: number, code: RewriteCode<Source, Data>, options?: InsertOptions): void;
	/** The text at `start`..`end` (not empty) is not rendered; `code` takes the place of its first char. */
	replace(start: number, end: number, code: RewriteCode<Source, Data>, options?: InsertOptions): void;
	/**
	 * The text at `start`..`end`, with the edits of all writers in it, rendered where the returned slice is placed,
	 * exactly once. In the cut that contains it, `placeholder` takes its place. The cuts of all writers are nested or
	 * disjoint, and of two cuts of one range the later is inside the earlier. A zero-width cut owns no char and has no
	 * placeholder; on an empty text, the first one renders the inserts.
	 */
	cut(start: number, end: number, options: CutOptions<Source, Data>): RewriteSlice<Source, Data>;
}

/** Receives the pieces of a render, in order: the same two shapes as `Piece`, as arguments. */
export interface PieceSink<Source, Data> {
	/** New text, not empty, which maps nowhere. */
	text(text: string): void;
	/** The range `start`..`end` of the text of `source`. `text` is undefined for kept text, which copies the range. */
	range(source: Source, start: number, end: number, data: Data, text: string | undefined): void;
}

export interface RewriteSlice<Source, Data> {
	/** Renders the pieces of the slice into `sink`, in order. */
	render(sink: PieceSink<Source, Data>): void;
}

/**
 * Edits of one source text by ranked writers. Inserts attach to a side of a char, removals add up, and text moves
 * only by nested cuts, so edits never conflict. The first render freezes the edits.
 */
export interface SourceRewrite<Source, Data> {
	readonly source: Source;
	readonly text: string;
	readonly core: RewriteWriter<Source, Data>;
	/** The writer of `rank`, a non-negative integer. A higher rank sits outside a lower one, and core outside all. */
	writer(rank: number): RewriteWriter<Source, Data>;
}

export function createSourceRewrite<Source, Data>(source: Source, text: string): SourceRewrite<Source, Data> {
	return new Rewrite<Source, Data>(source, text);
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
class Edits<Source, Data> {
	keys: number[] = [];
	code: RewriteCode<Source, Data>[] = [];
	/** The orders that are not 0, by edit. */
	orders: Map<number, number> | undefined;

	constructor(readonly rank: number) {}

	add(at: number, side: Side, order: number, code: RewriteCode<Source, Data>) {
		if (order !== 0) {
			(this.orders ??= new Map()).set(this.keys.length, order);
		}
		this.keys.push(at * 4 + side);
		this.code.push(code);
	}

	/** The first index from `low` whose anchor is at or after the char `offset`. */
	lowerBound(offset: number, low: number) {
		const keys = this.keys;
		const key = offset * 4;
		let high = keys.length;
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
		const { keys, code, orders } = this;
		const size = keys.length;
		let index = 1;
		while (
			index < size
			&& (keys[index - 1]! < keys[index]! || keys[index - 1] === keys[index] && !(orders && compareOrders(orders, index - 1, index) > 0))
		) {
			index++;
		}
		if (index >= size) {
			return;
		}
		const sorted: number[] = [];
		for (let index = 0; index < size; index++) {
			sorted.push(index);
		}
		sorted.sort((a, b) => keys[a]! - keys[b]! || (orders ? compareOrders(orders, a, b) : 0) || a - b);
		const sortedKeys: number[] = [];
		const sortedCode: RewriteCode<Source, Data>[] = [];
		for (let index = 0; index < size; index++) {
			sortedKeys.push(keys[sorted[index]!]!);
			sortedCode.push(code[sorted[index]!]!);
		}
		this.keys = sortedKeys;
		this.code = sortedCode;
		this.orders = undefined;
	}
}

function compareOrders(orders: Map<number, number>, a: number, b: number) {
	const orderA = orders.get(a) ?? 0;
	const orderB = orders.get(b) ?? 0;
	return orderA < orderB ? -1 : orderA > orderB ? 1 : 0;
}

class Rewrite<Source, Data> implements SourceRewrite<Source, Data> {
	readonly core: RewriteWriter<Source, Data>;
	writers = new Map<number, RewriteWriter<Source, Data>>();
	/** The edits of each writer; when frozen, of each writer that has some, sorted. */
	writerEdits: Edits<Source, Data>[] = [];
	/** Removed ranges as flat start, end pairs; sorted and merged when frozen. */
	removals = new Int32Array(16);
	removalsSize = 0;
	/** The top-level cuts, sorted and disjoint. */
	roots: Cut<Source, Data>[] = [];
	/** The last inserted cut, where the descent of the next one starts if it contains it. */
	lastCut: Cut<Source, Data> | undefined;
	/** On an empty text: the first zero-width cut, which renders the inserts. */
	firstEmpty: Cut<Source, Data> | undefined;
	frozen = false;

	constructor(readonly source: Source, readonly text: string) {
		this.core = this.createWriter(coreRank);
	}

	writer(rank: number): RewriteWriter<Source, Data> {
		if (!Number.isInteger(rank) || rank < 0 || rank >= coreRank) {
			throw new RangeError(`The rank ${rank} is not a non-negative integer below the rank of core.`);
		}
		let writer = this.writers.get(rank);
		if (!writer) {
			this.writers.set(rank, writer = this.createWriter(rank));
		}
		return writer;
	}

	private createWriter(rank: number): RewriteWriter<Source, Data> {
		const edits = new Edits<Source, Data>(rank);
		this.writerEdits.push(edits);
		return {
			insertBefore: (offset, code, options) => {
				this.check(offset, offset);
				edits.add(offset, offset === this.text.length ? Side.After : Side.Before, getOrder(options), code);
			},
			insertAfter: (offset, code, options) => {
				this.check(offset, offset);
				edits.add(offset ? offset - 1 : -1, offset ? Side.After : Side.Before, getOrder(options), code);
			},
			replace: (start, end, code, options) => {
				this.check(start, end);
				if (start === end) {
					throw new RangeError(`The replace at ${start}..${end} removes no char.`);
				}
				edits.add(start, Side.Slot, getOrder(options), code);
				this.addRemoval(start, end);
			},
			cut: (start, end, { data, placeholder }) => {
				this.check(start, end);
				const cut = new Cut(this, start, end, data, placeholder);
				if (start === end) {
					if (placeholder !== undefined) {
						throw new RangeError(`The empty cut ${start}..${end} cannot have a placeholder.`);
					}
					if (!this.text.length) {
						this.firstEmpty ??= cut;
					}
				}
				else {
					this.insertCut(cut);
				}
				return cut;
			},
		};
	}

	private check(start: number, end: number) {
		if (this.frozen) {
			throw new Error('The rewrite is already rendered.');
		}
		if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || end > this.text.length) {
			throw new RangeError(`${start}..${end} is out of 0..${this.text.length}.`);
		}
	}

	private addRemoval(start: number, end: number) {
		const size = this.removalsSize;
		if (size === this.removals.length) {
			const removals = new Int32Array(size * 2);
			removals.set(this.removals);
			this.removals = removals;
		}
		this.removals[size] = start;
		this.removals[size + 1] = end;
		this.removalsSize = size + 2;
	}

	// A cut that crosses `cut` intersects it, so it lies inside every cut that contains `cut`: the descent only checks
	// the siblings that `cut` intersects, of the innermost cut that contains it.
	private insertCut(cut: Cut<Source, Data>) {
		const { start, end } = cut;
		const last = this.lastCut;
		let siblings = last && last.start <= start && end <= last.end ? (last.children ??= []) : this.roots;
		while (true) {
			let first = 0;
			let after = siblings.length;
			for (let high = after; first < high;) {
				const mid = (first + high) >>> 1;
				if (siblings[mid]!.end <= start) {
					first = mid + 1;
				}
				else {
					high = mid;
				}
			}
			for (let low = first; low < after;) {
				const mid = (low + after) >>> 1;
				if (siblings[mid]!.start < end) {
					low = mid + 1;
				}
				else {
					after = mid;
				}
			}
			if (after - first === 1 && siblings[first]!.start <= start && end <= siblings[first]!.end) {
				siblings = siblings[first]!.children ??= [];
				continue;
			}
			if (after > first) {
				// the siblings in between lie strictly inside `cut`
				for (const sibling of [siblings[first]!, siblings[after - 1]!]) {
					if (sibling.start < start || sibling.end > end) {
						throw new RangeError(
							`The cut ${start}..${end} crosses the cut ${sibling.start}..${sibling.end}; cuts are nested or disjoint.`,
						);
					}
				}
				cut.children = siblings.splice(first, after - first, cut);
			}
			else {
				siblings.splice(first, 0, cut);
			}
			this.lastCut = cut;
			return;
		}
	}

	freeze() {
		if (this.frozen) {
			return;
		}
		this.frozen = true;
		this.writerEdits = this.writerEdits.filter(edits => edits.keys.length);
		for (const edits of this.writerEdits) {
			edits.sort();
		}
		this.mergeRemovals();
		for (const root of this.roots) {
			root.isRoot = true;
		}
	}

	private mergeRemovals() {
		let removals = this.removals;
		const pairs = this.removalsSize >> 1;
		for (let pair = 1; pair < pairs; pair++) {
			if (removals[2 * pair - 2]! > removals[2 * pair]!) {
				const sorted = Array.from({ length: pairs }, (_, index) => index)
					.sort((a, b) => removals[2 * a]! - removals[2 * b]!);
				const copy = new Int32Array(2 * pairs);
				for (let index = 0; index < pairs; index++) {
					copy[2 * index] = removals[2 * sorted[index]!]!;
					copy[2 * index + 1] = removals[2 * sorted[index]! + 1]!;
				}
				removals = copy;
				break;
			}
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

function getOrder(options: InsertOptions | undefined) {
	const order = options?.order ?? 0;
	if (typeof order !== 'number' || Number.isNaN(order)) {
		throw new TypeError(`The order ${order} is not a number.`);
	}
	return order;
}

class Cut<Source, Data> implements RewriteSlice<Source, Data> {
	declare readonly isSlice: true;
	/** The cuts directly inside, sorted and disjoint. */
	children: Cut<Source, Data>[] | undefined;
	isRoot = false;
	placed = false;

	constructor(
		readonly rewrite: Rewrite<Source, Data>,
		readonly start: number,
		readonly end: number,
		readonly data: Data,
		readonly placeholder: RewriteCode<Source, Data> | undefined,
	) {}

	render(sink: PieceSink<Source, Data>) {
		this.rewrite.freeze();
		renderCut(this, new Walker(this.rewrite, sink));
	}
}
(Cut.prototype as { isSlice: true }).isSlice = true;

/** The state of one render: the sink, and the position in the text and in the removals. */
class Walker<Source, Data> {
	readonly source: Source;
	readonly removals: Int32Array;
	readonly removalsSize: number;
	pos = 0;
	/** The first removal that ends after `pos`. */
	removal = 0;

	constructor(rewrite: Rewrite<Source, Data>, readonly sink: PieceSink<Source, Data>) {
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
			sink.range(source, pos, stop, data, undefined);
			pos = stop;
		}
		this.pos = pos;
		this.removal = removal;
	}
}

function renderCut<Source, Data>(cut: Cut<Source, Data>, walker: Walker<Source, Data>) {
	if (cut.placed) {
		throw new Error(`The cut ${cut.start}..${cut.end} is placed twice.`);
	}
	cut.placed = true;
	const rewrite = cut.rewrite;
	const writers = rewrite.writerEdits;
	const { start, end, children, data, isRoot } = cut;
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
	const { pos, removal } = walker;
	walker.seek(start);
	for (const edits of writers) {
		next.push(isRoot && start === 0 ? 0 : edits.lowerBound(start, 0));
	}
	for (let index = 0;; index++) {
		const child = children?.[index];
		renderEdits(writers, next, (child ? child.start : end) * 4, walker, data, true);
		if (!child) {
			break;
		}
		walker.keep(child.start, data);
		if (child.placeholder !== undefined) {
			renderCode(child.placeholder, walker);
		}
		walker.seek(child.end);
		for (let writer = 0; writer < writers.length; writer++) {
			next[writer] = writers[writer]!.lowerBound(child.end, next[writer]!);
		}
	}
	walker.keep(end, data);
	if (isRoot && end === rewrite.text.length) {
		renderEdits(writers, next, Infinity, walker, data, false);
	}
	walker.pos = pos;
	walker.removal = removal;
}

/**
 * The edits of all writers from `next` to the key `last`, in render order: at one side of one char, the code before
 * the text goes outermost (highest rank) first, and the code in the place of the char and after the text innermost
 * first. With `keep`, the kept text up to the anchor of each, with `data`, before it.
 */
function renderEdits<Source, Data>(
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
			const { keys, rank } = writers[writer]!;
			const edit = next[writer]!;
			if (edit < keys.length) {
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
			renderCode(code[edit++]!, walker);
		}
		while (edit < keys.length && keys[edit]! < bound);
		next[best] = edit;
	}
}

function renderCode<Source, Data>(code: RewriteCode<Source, Data>, walker: Walker<Source, Data>) {
	if (typeof code === 'string') {
		if (code) {
			walker.sink.text(code);
		}
	}
	else if (isCodeArray(code)) {
		for (let index = 0; index < code.length; index++) {
			renderCode(code[index]!, walker);
		}
	}
	else if ((code as Cut<Source, Data>).isSlice) {
		renderCut(code as Cut<Source, Data>, walker);
	}
	else {
		const piece = code as Exclude<Piece<Source, Data>, string>;
		walker.sink.range(piece.source, piece.start, piece.end, piece.data, piece.text);
	}
}

function isCodeArray<Source, Data>(code: RewriteCode<Source, Data>): code is readonly RewriteCode<Source, Data>[] {
	return Array.isArray(code);
}
