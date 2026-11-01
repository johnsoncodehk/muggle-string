import type { Piece, RewriteSource } from './types.js';

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
		cut: (start: number, end: number, options?: RewriteCutOptions<Source, Data>) => rewrite.cut(start, end, options),
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
	/** When frozen, the keys and code of the edits of all writers, in render order. */
	keys: Int32Array = new Int32Array(0);
	code: RewriteCode<Source, Data>[] = [];

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
		const { length } = this.source.content;
		if (!isRange(start, end, length)) {
			throw new RangeError(`${start === end ? `The offset ${start}` : `The range ${start}..${end}`} is out of 0..${length}.`);
		}
	}

	/**
	 * The cut of `start`..`end`, inside the innermost cut that holds the range, around the cuts in the range; the cuts
	 * of each level stay sorted and disjoint.
	 */
	cut(start: number, end: number, options: RewriteCutOptions<Source, Data> | undefined) {
		if (this.frozen) {
			throw new Error('The rewrite is already rendered.');
		}
		const { length } = this.source.content;
		if (!isRange(start, end, length)) {
			throw new RangeError(`The range ${start}..${end} is out of 0..${length}.`);
		}
		if (start === end) {
			throw new RangeError(`The cut at ${start} moves no char.`);
		}
		let placeholder: RewriteCode<Source, Data> | undefined;
		let data = {} as Data;
		if (options) {
			({ placeholder, ...data as {} } = options);
		}
		let parent: Cut<Source, Data> | undefined;
		let siblings = this.roots;
		while (true) {
			let low = siblings.length;
			// cuts usually come in order, after all of their level
			if (low && siblings[low - 1]!.end > start) {
				low = 0;
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
			const cut = new Cut<Source, Data>(this, parent, start, end, data, placeholder);
			if (last === siblings.length && low === last) {
				siblings.push(cut);
			}
			else {
				const held = siblings.splice(low, last - low, cut);
				if (held.length) {
					cut.children = held;
					for (const inner of held) {
						inner.parent = cut;
					}
				}
			}
			this.cuts.push(cut);
			return cut;
		}
	}

	/** The view `start`..`end`. */
	render(start: number, end: number, data: Data, sink: (piece: Piece<RewriteOrigin<Source, Data>>) => void) {
		const { length } = this.source.content;
		if (!isRange(start, end, length)) {
			throw new RangeError(`The range ${start}..${end} is out of 0..${length}.`);
		}
		this.freeze();
		const { roots, keys, removals } = this;
		let index = 0;
		let high = roots.length;
		while (index < high) {
			const mid = (index + high) >>> 1;
			if (roots[mid]!.end <= start) {
				index = mid + 1;
			}
			else {
				high = mid;
			}
		}
		let pos = start;
		// a view skips the cut that it starts inside
		const first = roots[index];
		if (first && first.start < start) {
			pos = first.end < end ? first.end : end;
			index++;
		}
		let edit = 0;
		if (start) {
			high = this.code.length;
			while (edit < high) {
				const mid = (edit + high) >>> 1;
				if (keys[mid]! < pos * 4) {
					edit = mid + 1;
				}
				else {
					high = mid;
				}
			}
		}
		let removal = 0;
		high = this.removalsSize >> 1;
		while (removal < high) {
			const mid = (removal + high) >>> 1;
			if (removals[2 * mid + 1]! <= pos) {
				removal = mid + 1;
			}
			else {
				high = mid;
			}
		}
		renderDepth++;
		try {
			this.renderSpan(pos, end, edit, removal * 2, roots, index, data, sink, end === length);
		}
		finally {
			renderDepth--;
		}
	}

	/**
	 * The text from `pos` to `end` with the edits in it, from the edit `edit` and the removal `removal` on, but for the
	 * text of `children`, the cuts in it from `index`, sorted and disjoint: their placeholders render in their place.
	 * Kept text has the fields of `data`, and `tail` renders the code after all text.
	 */
	renderSpan(
		pos: number,
		end: number,
		edit: number,
		removal: number,
		children: readonly Cut<Source, Data>[] | undefined,
		index: number,
		data: Data,
		sink: (piece: Piece<RewriteOrigin<Source, Data>>) => void,
		tail: boolean,
	) {
		const { keys, code, removals, removalsSize, source } = this;
		const count = code.length;
		while (true) {
			const child = children?.[index];
			const stop = child && child.start < end ? child.start : end;
			const last = stop * 4;
			while (true) {
				// no key is below -4, the key of the code before all text
				const key = edit < count && keys[edit]! < last ? keys[edit]! : -8;
				const to = key === -8 ? stop : (key >> 2) + ((key & 3) === Side.After ? 1 : 0);
				while (pos < to) {
					while (removal < removalsSize && removals[removal + 1]! <= pos) {
						removal += 2;
					}
					if (removal < removalsSize && removals[removal]! <= pos) {
						pos = removals[removal + 1]! < to ? removals[removal + 1]! : to;
						continue;
					}
					const runEnd = removal < removalsSize && removals[removal]! < to ? removals[removal]! : to;
					sink({ ...data, source, start: pos, end: runEnd });
					pos = runEnd;
				}
				if (key === -8) {
					break;
				}
				renderCode(code[edit++]!, sink);
			}
			if (stop === end) {
				break;
			}
			if (child!.placeholder !== undefined) {
				renderCode(child!.placeholder, sink);
			}
			if (child!.end > end) {
				return;
			}
			pos = child!.end;
			edit = child!.endEdit;
			removal = child!.endRemoval;
			index++;
		}
		if (tail) {
			while (edit < count) {
				renderCode(code[edit++]!, sink);
			}
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
		const writers = [...this.edits.values()].filter(edits => edits.code.length);
		for (const edits of writers) {
			edits.sort();
		}
		this.mergeRemovals();
		try {
			this.compile(writers);
		}
		catch (error) {
			this.error = error;
			throw error;
		}
	}

	/**
	 * Merges the edits of all writers in render order, and finds where the edits and the removals of each cut start and
	 * end, and the cut that owns each edit, in one walk of the cuts in the order of their starts and ends. Then checks
	 * the placements of the cuts.
	 */
	private compile(writers: Edits<Source, Data>[]) {
		const [keys, code, positions] = mergeEdits(writers);
		this.keys = keys;
		this.code = code;
		if (!this.cuts.length) {
			return;
		}
		const count = code.length;
		const { removals, removalsSize } = this;
		/** The cut that owns each edit, by its index in `code`. */
		const owners: (Cut<Source, Data> | undefined)[] = [];
		let edit = 0;
		let removal = 0;
		/** The cuts entered and not left but the innermost, `owner`, each with the index of its next child. */
		const path: (Cut<Source, Data> | undefined)[] = [];
		const nextChild: number[] = [];
		let owner: Cut<Source, Data> | undefined;
		let children: Cut<Source, Data>[] | undefined = this.roots;
		let index = 0;
		while (true) {
			const child: Cut<Source, Data> | undefined = children?.[index];
			// enters the next child, or leaves the cut
			const at = child ? child.start : owner ? owner.end : Infinity;
			for (; edit < count && keys[edit]! < at * 4; edit++) {
				owners.push(owner);
			}
			for (; removal < removalsSize && removals[removal + 1]! <= at; removal += 2);
			if (child) {
				child.firstEdit = edit;
				child.firstRemoval = removal;
				path.push(owner);
				nextChild.push(index + 1);
				owner = child;
				children = child.children;
				index = 0;
				continue;
			}
			if (!owner) {
				break;
			}
			owner.endEdit = edit;
			owner.endRemoval = removal;
			owner = path.pop();
			index = nextChild.pop()!;
			children = owner ? owner.children : this.roots;
		}
		/** The cuts that have renderers. */
		const placed: Cut<Source, Data>[] = [];
		// by writer and in the order of each, which decides the cut that the error of a cycle names
		for (let writer = 0; writer < writers.length; writer++) {
			const edits = writers[writer]!;
			for (let index = 0; index < edits.code.length; index++) {
				const owner = owners[positions ? positions[writer]![index]! : index];
				if (owner) {
					place(this, placed, edits.code[index]!, owner);
				}
			}
		}
		for (const cut of this.cuts) {
			if (cut.placeholder !== undefined && cut.parent) {
				place(this, placed, cut.placeholder, cut.parent);
			}
		}
		checkRenderers(placed);
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

/**
 * The keys and code of all writers, in render order: at one side of one char, the code before the text goes outermost
 * (highest rank) first, and the code in the place of the char and after the text innermost first. With more than one
 * writer, also the merged index of each edit of each writer.
 */
function mergeEdits<Source extends RewriteSource, Data>(
	writers: Edits<Source, Data>[],
): [Int32Array, RewriteCode<Source, Data>[], Int32Array[]?] {
	if (writers.length < 2) {
		return writers.length ? [writers[0]!.keys, writers[0]!.code] : [new Int32Array(0), []];
	}
	let total = 0;
	for (const edits of writers) {
		total += edits.code.length;
	}
	const keys = new Int32Array(total);
	const merged: RewriteCode<Source, Data>[] = [];
	const positions = writers.map(edits => new Int32Array(edits.code.length));
	const next = writers.map(() => 0);
	while (true) {
		let best = -1;
		let bestKey = Infinity;
		// the first key of the other writers, up to which the best one adds its run
		let bound = Infinity;
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
			return [keys, merged, positions];
		}
		const edits = writers[best]!;
		const position = positions[best]!;
		let edit = next[best]!;
		// an edit at `bound` itself may lose to the other writer there: it is chosen again
		do {
			position[edit] = merged.length;
			keys[merged.length] = edits.keys[edit]!;
			merged.push(edits.code[edit++]!);
		}
		while (edit < edits.code.length && edits.keys[edit]! < bound);
		next[best] = edit;
	}
}

/**
 * Records the cuts of `rewrite` placed in `code` as rendered by `renderer`, and adds each to `placed` the first time;
 * a view is no renderer. Not a closure in `compile`: a new closure at each freeze makes V8 deoptimize the call.
 */
function place<Source extends RewriteSource, Data>(
	rewrite: Rewrite<Source, Data>,
	placed: Cut<Source, Data>[],
	code: RewriteCode<Source, Data>,
	renderer: Cut<Source, Data>,
) {
	if (typeof code === 'string') {
		return;
	}
	if (isCodeArray<Source, Data>(code)) {
		for (let index = 0; index < code.length; index++) {
			place(rewrite, placed, code[index]!, renderer);
		}
	}
	else if (code instanceof Cut && code.rewrite === rewrite) {
		if (code.renderers) {
			code.renderers.push(renderer);
		}
		else {
			code.renderers = [renderer];
			placed.push(code);
		}
	}
}

/**
 * Throws for a cut that only its own render would render: placed in code that it renders, directly or through the
 * cuts placed in it. Code at a char renders in the innermost cut that owns the char, and a placeholder in the cut
 * around its own.
 */
function checkRenderers<Source extends RewriteSource, Data>(placed: Cut<Source, Data>[]) {
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

function isRange(start: number, end: number, length: number) {
	return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start <= end && end <= length;
}

class Cut<Source extends RewriteSource, Data> implements RewriteSlice<Source, Data> {
	/** The cuts directly inside, sorted and disjoint. */
	children: Cut<Source, Data>[] | undefined;
	/** The cuts whose render renders code that it is placed in. */
	renderers: Cut<Source, Data>[] | undefined;
	visit = Visit.Unvisited;
	state = CutState.Unrendered;
	/** When frozen, the indexes of the edits and removals of the rewrite at its start and at its end. */
	firstEdit = 0;
	firstRemoval = 0;
	endEdit = 0;
	endRemoval = 0;

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
			const { start, end, firstEdit, firstRemoval, children, data } = this;
			this.rewrite.renderSpan(start, end, firstEdit, firstRemoval, children, 0, data, sink, false);
		}
		finally {
			renderDepth--;
			this.state = byItself ? CutState.RenderedByItself : CutState.Placed;
		}
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
