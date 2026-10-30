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

export interface RewriteSlice<Source, Data> {
	/** Appends the pieces of the slice to `out`, and returns `out`. A kept piece has no `text`. */
	pieces(out?: Piece<Source, Data>[]): Piece<Source, Data>[];
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

interface EditRecord<Source, Data> {
	at: number;
	side: Side;
	rank: number;
	order: number;
	seq: number;
	code: RewriteCode<Source, Data>;
}

// Before: outermost (highest rank) first; Slot and After: innermost first
function compareEdits<Source, Data>(a: EditRecord<Source, Data>, b: EditRecord<Source, Data>) {
	if (a.at !== b.at) {
		return a.at - b.at;
	}
	if (a.side !== b.side) {
		return a.side - b.side;
	}
	if (a.rank !== b.rank) {
		return a.side === Side.Before ? b.rank - a.rank : a.rank - b.rank;
	}
	if (a.order !== b.order) {
		return a.order < b.order ? -1 : 1;
	}
	return a.seq - b.seq;
}

class Edits<Source, Data> {
	records: EditRecord<Source, Data>[] = [];
	// the sorted records by column, filled when frozen
	at = new Int32Array(0);
	side = new Uint8Array(0);
	code: RewriteCode<Source, Data>[] = [];

	push(at: number, side: Side, rank: number, order: number, code: RewriteCode<Source, Data>) {
		this.records.push({ at, side, rank, order, seq: this.records.length, code });
	}

	freeze() {
		const records = this.records;
		// every writer's edits usually arrive in order; the sort is linear on such runs
		for (let i = 1; i < records.length; i++) {
			if (compareEdits(records[i - 1]!, records[i]!) > 0) {
				records.sort(compareEdits);
				break;
			}
		}
		const size = records.length;
		this.at = new Int32Array(size);
		this.side = new Uint8Array(size);
		this.code = new Array(size);
		for (let i = 0; i < size; i++) {
			const record = records[i]!;
			this.at[i] = record.at;
			this.side[i] = record.side;
			this.code[i] = record.code;
		}
		this.records = [];
	}

	/** The first index from `low` whose anchor is at or after `offset`. */
	lowerBound(offset: number, low: number) {
		const at = this.at;
		let high = at.length;
		while (low < high) {
			const mid = (low + high) >>> 1;
			if (at[mid]! < offset) {
				low = mid + 1;
			}
			else {
				high = mid;
			}
		}
		return low;
	}
}

class Rewrite<Source, Data> implements SourceRewrite<Source, Data> {
	readonly core: RewriteWriter<Source, Data>;
	edits = new Edits<Source, Data>();
	/** `insertAfter(0)`: before all text. */
	head = new Edits<Source, Data>();
	/** `insertBefore(length)`: after all text. */
	tail = new Edits<Source, Data>();
	/** Removed ranges as flat start, end pairs. */
	removalPairs: number[] = [];
	/** The removed ranges, sorted and merged, filled when frozen. */
	removals = new Int32Array(0);
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
		return this.createWriter(rank);
	}

	private createWriter(rank: number): RewriteWriter<Source, Data> {
		return {
			insertBefore: (offset, code, options) => {
				this.check(offset, offset);
				const order = getOrder(options);
				if (offset === this.text.length) {
					this.tail.push(offset, Side.After, rank, order, code);
				}
				else {
					this.edits.push(offset, Side.Before, rank, order, code);
				}
			},
			insertAfter: (offset, code, options) => {
				this.check(offset, offset);
				const order = getOrder(options);
				if (offset === 0) {
					this.head.push(0, Side.Before, rank, order, code);
				}
				else {
					this.edits.push(offset - 1, Side.After, rank, order, code);
				}
			},
			replace: (start, end, code, options) => {
				this.check(start, end);
				if (start === end) {
					throw new RangeError(`The replace at ${start}..${end} removes no char.`);
				}
				this.edits.push(start, Side.Slot, rank, getOrder(options), code);
				this.removalPairs.push(start, end);
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

	// A cut that crosses `cut` intersects it, so it lies inside every cut that contains `cut`: the descent only checks
	// the siblings that `cut` intersects, of the innermost cut that contains it.
	private insertCut(cut: Cut<Source, Data>) {
		const { start, end } = cut;
		const last = this.lastCut;
		let siblings = last && last.start <= start && end <= last.end ? last.children : this.roots;
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
				siblings = siblings[first]!.children;
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
		this.edits.freeze();
		this.head.freeze();
		this.tail.freeze();
		const removals = this.removalPairs;
		const pairs = removals.length >> 1;
		for (let pair = 1; pair < pairs; pair++) {
			if (removals[2 * pair - 2]! > removals[2 * pair]!) {
				const sorted = Array.from({ length: pairs }, (_, index) => [removals[2 * index]!, removals[2 * index + 1]!])
					.sort((a, b) => a[0]! - b[0]!);
				for (let index = 0; index < pairs; index++) {
					removals[2 * index] = sorted[index]![0]!;
					removals[2 * index + 1] = sorted[index]![1]!;
				}
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
		removals.length = merged;
		this.removals = Int32Array.from(removals);
		this.removalPairs = [];
		for (const root of this.roots) {
			root.isRoot = true;
		}
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
	/** The cuts directly inside, sorted and disjoint. */
	children: Cut<Source, Data>[] = [];
	isRoot = false;
	placed = false;

	constructor(
		readonly rewrite: Rewrite<Source, Data>,
		readonly start: number,
		readonly end: number,
		readonly data: Data,
		readonly placeholder: RewriteCode<Source, Data> | undefined,
	) {}

	pieces(out: Piece<Source, Data>[] = []) {
		if (this.placed) {
			throw new Error(`The cut ${this.start}..${this.end} is placed twice.`);
		}
		this.placed = true;
		const rewrite = this.rewrite;
		rewrite.freeze();
		const { edits, head, tail } = rewrite;
		const { start, end, children } = this;
		if (start === end) {
			if (this === rewrite.firstEmpty) {
				pushAll(head, out);
				pushAll(tail, out);
			}
			return out;
		}
		if (this.isRoot && start === 0) {
			pushAll(head, out);
		}
		const walker = new Walker(rewrite.removals, rewrite.source, this.data, out, start);
		const { at, side, code } = edits;
		const size = at.length;
		let edit = edits.lowerBound(start, 0);
		for (let index = 0;; index++) {
			const child = children[index];
			const until = child ? child.start : end;
			for (; edit < size && at[edit]! < until; edit++) {
				walker.keep(side[edit] === Side.After ? at[edit]! + 1 : at[edit]!);
				pushCode(code[edit]!, out);
			}
			if (!child) {
				break;
			}
			walker.keep(child.start);
			if (child.placeholder !== undefined) {
				pushCode(child.placeholder, out);
			}
			walker.skip(child.end);
			edit = edits.lowerBound(child.end, edit);
		}
		walker.keep(end);
		if (this.isRoot && end === rewrite.text.length) {
			pushAll(tail, out);
		}
		return out;
	}
}

/** Pushes the kept chars of one cut, as pieces between the removals. */
class Walker<Source, Data> {
	/** The first removal that ends after `pos`. */
	removal = 0;

	constructor(
		readonly removals: Int32Array,
		readonly source: Source,
		readonly data: Data,
		readonly out: Piece<Source, Data>[],
		public pos: number,
	) {
		this.seek();
	}

	/** The kept chars from `pos` to `to`. */
	keep(to: number) {
		const { removals, out } = this;
		const size = removals.length;
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
			out.push({ source: this.source, start: pos, end: stop, data: this.data });
			pos = stop;
		}
		this.pos = pos;
		this.removal = removal;
	}

	/** Moves past the chars up to `to`, which a child cut owns. */
	skip(to: number) {
		this.pos = to;
		this.seek();
	}

	private seek() {
		const removals = this.removals;
		let low = this.removal >> 1;
		let high = removals.length >> 1;
		while (low < high) {
			const mid = (low + high) >>> 1;
			if (removals[2 * mid + 1]! <= this.pos) {
				low = mid + 1;
			}
			else {
				high = mid;
			}
		}
		this.removal = low * 2;
	}
}

function pushAll<Source, Data>(edits: Edits<Source, Data>, out: Piece<Source, Data>[]) {
	for (const code of edits.code) {
		pushCode(code, out);
	}
}

function pushCode<Source, Data>(code: RewriteCode<Source, Data>, out: Piece<Source, Data>[]) {
	if (typeof code === 'string') {
		if (code) {
			out.push(code);
		}
	}
	else if (code instanceof Cut) {
		code.pieces(out);
	}
	else if (isCodeArray(code)) {
		for (let index = 0; index < code.length; index++) {
			pushCode(code[index]!, out);
		}
	}
	else {
		out.push(code as Exclude<Piece<Source, Data>, string>);
	}
}

function isCodeArray<Source, Data>(code: RewriteCode<Source, Data>): code is readonly RewriteCode<Source, Data>[] {
	return Array.isArray(code);
}
