import type { Piece, Source } from './types.js';

/**
 * What a range of a rewrite carries beyond its offsets: its source, and the fields of the consumer that the view or the
 * slice that renders it gives, none by default.
 */
export type RewriteOrigin<S extends Source, Data = {}> = Data & { source: S };

/** Code written into a rewrite: pieces, slices, which render their cut in place, and arrays of code. */
export type RewriteCode<S extends Source, Data = {}> =
	| Piece<RewriteOrigin<S, Data>>
	| RewriteSlice<S, Data>
	| readonly RewriteCode<S, Data>[];

/**
 * The fields that the kept pieces of the cut carry over those of the code that renders the slice, and its
 * placeholder.
 */
export type RewriteCutOptions<S extends Source, Data = {}> = Partial<Data> & {
	/** The code that takes the place of the cut in the cut that contains it. */
	placeholder?: RewriteCode<S, Data>;
};

/** A slice whose cut sets the fields `Given`, so rendering it by itself takes data only for the fields it leaves. */
export interface RewriteSlice<S extends Source, Data = {}, Given = {}> {
	/**
	 * Passes the pieces of the slice to `sink`, in order: no string is empty, and kept text is a range without `text`,
	 * with the fields of `data` and over them those of the cut. Placed in code, a slice renders with the data of the
	 * code.
	 */
	render(
		sink: (piece: Piece<RewriteOrigin<S, Data>>) => void,
		...data: {} extends Omit<Data, keyof Given> ? [data?: Data] : [data: Data]
	): void;
}

/**
 * Edits of one source text. Code belongs to a range of the text, and goes wherever that text goes; removals add up,
 * and text moves only by slices, which nest or are disjoint, so edits never conflict. A render renders the edits made
 * before it; an edit while a render runs throws.
 */
export interface SourceRewrite<S extends Source, Data = {}> {
	/** The source that the rewrite edits, which its kept pieces carry. */
	readonly source: S;
	/**
	 * `code` at the point `offset`, with the text after it: it renders with the char at `offset`, or at the end of the
	 * text after all text. At one point, it goes after the code of `insertAfter` and outside the wraps that start
	 * there; inserts at one point keep call order.
	 */
	insertBefore(offset: number, code: RewriteCode<S, Data>): void;
	/**
	 * `code` at the point `offset`, with the text before it: it renders with the char before `offset`, or at 0 before
	 * all text. At one point, it goes before the code of `insertBefore` and outside the wraps that end there; inserts
	 * at one point keep call order.
	 */
	insertAfter(offset: number, code: RewriteCode<S, Data>): void;
	/**
	 * `before` before the text at `start`..`end` and `after` after it, around the code already there: wraps nest by
	 * their ranges, and of one range, a later wrap goes outside. Before renders with the first char of the range,
	 * after with its last; an empty range wraps the code that replaces it, at the char at `start`, or at the end of
	 * the text after it.
	 */
	wrap(start: number, end: number, before: RewriteCode<S, Data>, after: RewriteCode<S, Data>): void;
	/**
	 * The text at `start`..`end` is not rendered, and `code` takes its place, inside the wraps of the range. An empty
	 * range removes nothing.
	 */
	replace(start: number, end: number, code: RewriteCode<S, Data>): void;
	/**
	 * The slice of `start`..`end` (not empty): its text, with the edits in it, renders where the slice is
	 * placed, kept text with the data of the code it renders in and over it the other fields of `options`, and
	 * `placeholder` takes its place where it is cut from. Cuts are made in any
	 * order: a cut inside another moves with it, of two cuts of one range the later is inside, and a cut that crosses
	 * another, or a wrap, throws. Text that is not wanted is removed by `replace`; a slice is cut to be placed, and `unrendered`
	 * tells one that is not.
	 *
	 * A slice that is placed in code that only its own render renders, as in its own range, throws when it renders.
	 */
	cut<const Options extends RewriteCutOptions<S, Data> = {}>(
		start: number,
		end: number,
		options?: Options,
	): RewriteSlice<S, Data, Omit<Options, 'placeholder'>>;
	/**
	 * Passes the pieces of the text at `start`..`end`, with the edits in it, to `sink`, kept text with the fields of
	 * `data`: a view, which owns no text, so views can overlap and render again. It renders the code of the chars in
	 * it, and at the end of the text the code there. The text of a slice renders where the slice is placed, and its
	 * placeholder in the view of its start.
	 */
	render(
		start: number,
		end: number,
		sink: (piece: Piece<RewriteOrigin<S, Data>>) => void,
		...data: {} extends Data ? [data?: Data] : [data: Data]
	): void;
	/**
	 * The slices that have not rendered, in cut order: after the last render of its consumer, those that it placed
	 * nowhere, or in code that it did not render.
	 */
	unrendered(): RewriteSlice<S, Data>[];
}

/**
 * A rewrite of the content of `source`; a render after the content changed throws. `Data` is the fields that its kept
 * pieces carry beyond their source and offsets, which the views give and the cuts override.
 */
export function createSourceRewrite<
	S extends Source,
	Data extends object = {},
>(source: S): SourceRewrite<S, Data> {
	const rewrite = new Rewrite<S, Data>(source);
	return {
		source,
		insertBefore: (offset, code) => rewrite.insertBefore(offset, code),
		insertAfter: (offset, code) => rewrite.insertAfter(offset, code),
		wrap: (start, end, before, after) => rewrite.wrap(start, end, before, after),
		replace: (start, end, code) => rewrite.replace(start, end, code),
		cut: (start, end, options) => rewrite.cut(start, end, options),
		render: (start: number, end: number, sink: Sink<S, Data>, data?: Data) =>
			rewrite.render(start, end, data ?? {} as Data, sink),
		unrendered: () => rewrite.cuts.filter(cut => cut.state === CutState.Unrendered),
	};
}

type Sink<S extends Source, Data> = (piece: Piece<RewriteOrigin<S, Data>>) => void;

/**
 * The generated text of `piece`: new text, the `text` of a range, or the content of its source that it keeps. A kept
 * range without a source, or whose `start` and `end` are not integers with 0 <= `start` <= `end` <= the length of the
 * content, throws.
 */
export function rewritePieceText(piece: Piece<{ source: Source }>): string {
	if (typeof piece === 'string') {
		return piece;
	}
	const { text } = piece;
	if (text != null) {
		return text;
	}
	const { start, end } = piece;
	const content = piece.source?.content;
	if (typeof content !== 'string') {
		throw new TypeError(`The range ${start}..${end} has no source.`);
	}
	if (!isRange(start, end, content.length)) {
		throw new RangeError(`The range ${start}..${end} is out of 0..${content.length}.`);
	}
	return content.slice(start, end);
}

// the sides of a char, in render order: code at the point before the char, code before the text that starts at the
// char, code in the place of the char, code after the text that ends at the char and then at the point after it
const enum Side {
	Point,
	Before,
	Slot,
	After,
}

/**
 * The edits, each at a side of a char, as the key `at * 4 + side`, which sorts in render order; keys are from -1, the
 * point before all text, and below 2 ** 31, as text is shorter than 2 ** 29. Of one key, the edits go by their nests:
 * before the text, the wrap with the greater end first; after the text, the wrap with the greater start first, then
 * the inserts at the point after the char (1); in the place of the char, the befores of empty wraps (0), the
 * replacements (1), and the afters of empty wraps (2). Of one nest, in call order, but the befores of wraps in
 * reverse, as a later wrap goes outside.
 */
class Edits<S extends Source, Data> {
	/** The keys of the edits, as many as `code`. */
	keys = new Int32Array(16);
	/** The nests of the edits, as many as `code`. */
	nests = new Int32Array(16);
	code: RewriteCode<S, Data>[] = [];
	/** Whether the edits arrived in render order. */
	sorted = true;

	add(at: number, side: Side, nest: number, code: RewriteCode<S, Data>) {
		let keys = this.keys;
		let nests = this.nests;
		const size = this.code.length;
		const key = at * 4 + side;
		if (size && (key < keys[size - 1]! || (key === keys[size - 1]! && compareNests(key, nests[size - 1]!, nest, -1) > 0))) {
			this.sorted = false;
		}
		if (size === keys.length) {
			keys = new Int32Array(size * 2);
			keys.set(this.keys);
			this.keys = keys;
			nests = new Int32Array(size * 2);
			nests.set(this.nests);
			this.nests = nests;
		}
		keys[size] = key;
		nests[size] = nest;
		this.code.push(code);
	}

	/** Sorts the edits, which usually arrive in order. */
	sort() {
		if (this.sorted) {
			return;
		}
		const { keys, nests, code } = this;
		const size = code.length;
		const sorted: number[] = [];
		for (let index = 0; index < size; index++) {
			sorted.push(index);
		}
		sorted.sort((a, b) => keys[a]! - keys[b]! || compareNests(keys[a]!, nests[a]!, nests[b]!, a - b));
		const sortedKeys = new Int32Array(size);
		const sortedNests = new Int32Array(size);
		const sortedCode: RewriteCode<S, Data>[] = [];
		for (let index = 0; index < size; index++) {
			sortedKeys[index] = keys[sorted[index]!]!;
			sortedNests[index] = nests[sorted[index]!]!;
			sortedCode.push(code[sorted[index]!]!);
		}
		this.keys = sortedKeys;
		this.nests = sortedNests;
		this.code = sortedCode;
		this.sorted = true;
	}
}

/** Of two edits at `key`, which goes first: by nest, then by `order`, the call order, reversed for befores of wraps. */
function compareNests(key: number, a: number, b: number, order: number) {
	if (a !== b) {
		return a - b;
	}
	const side = key & 3;
	return side === Side.Before || (side === Side.Slot && a === 0) ? -order : order;
}

class Rewrite<S extends Source, Data> {
	edits = new Edits<S, Data>();
	/** Removed ranges as flat start, end pairs; sorted and merged when frozen. */
	removals = new Int32Array(16);
	removalsSize = 0;
	/** Whether the removals arrived in order of start. */
	removalsSorted = true;
	/** The cuts, in call order. */
	cuts: Cut<S, Data>[] = [];
	/** The outermost cuts, sorted and disjoint. */
	roots: Cut<S, Data>[] = [];
	/** Whether the edits are sorted and compiled for the edits so far. */
	frozen = false;
	/** How many renders of the rewrite or its slices are running. */
	rendering = 0;
	/** What compiling the edits threw, which every render throws until the next edit. */
	error: unknown;
	/** The content of the source when the rewrite was made. */
	readonly content: string;

	constructor(readonly source: S) {
		this.content = source.content;
	}

	insertBefore(offset: number, code: RewriteCode<S, Data>) {
		this.check(offset, offset);
		if (code !== '') {
			this.edits.add(offset, Side.Point, 0, code);
		}
	}

	insertAfter(offset: number, code: RewriteCode<S, Data>) {
		this.check(offset, offset);
		if (code !== '') {
			this.edits.add(offset - 1, Side.After, 1, code);
		}
	}

	wrap(start: number, end: number, before: RewriteCode<S, Data>, after: RewriteCode<S, Data>) {
		this.check(start, end);
		const { edits } = this;
		if (start === end) {
			if (before !== '') {
				edits.add(start, Side.Slot, 0, before);
			}
			if (after !== '') {
				edits.add(start, Side.Slot, 2, after);
			}
		}
		else {
			if (before !== '') {
				edits.add(start, Side.Before, -end, before);
			}
			if (after !== '') {
				edits.add(end - 1, Side.After, -start, after);
			}
		}
	}

	replace(start: number, end: number, code: RewriteCode<S, Data>) {
		this.check(start, end);
		if (start === end && code === '') {
			return;
		}
		this.edits.add(start, Side.Slot, 1, code);
		if (start < end) {
			this.addRemoval(start, end);
		}
	}

	private check(start: number, end: number) {
		this.thaw();
		const { length } = this.content;
		if (!isRange(start, end, length)) {
			throw new RangeError(`${start === end ? `The offset ${start}` : `The range ${start}..${end}`} is out of 0..${length}.`);
		}
	}

	/**
	 * The cut of `start`..`end`, inside the innermost cut that holds the range, around the cuts in the range; the cuts
	 * of each level stay sorted and disjoint.
	 */
	cut(start: number, end: number, options: RewriteCutOptions<S, Data> | undefined) {
		this.thaw();
		const { length } = this.content;
		if (!isRange(start, end, length)) {
			throw new RangeError(`The range ${start}..${end} is out of 0..${length}.`);
		}
		if (start === end) {
			throw new RangeError(`The cut at ${start} moves no char.`);
		}
		let placeholder: RewriteCode<S, Data> | undefined;
		let data: Partial<Data> | undefined;
		if (options) {
			const { placeholder: code, ...fields } = options;
			placeholder = code;
			for (const _ in fields) {
				data = fields as Partial<Data>;
				break;
			}
		}
		let parent: Cut<S, Data> | undefined;
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
			const cut = new Cut<S, Data>(this, parent, start, end, data, placeholder);
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
	render(start: number, end: number, data: Data, sink: (piece: Piece<RewriteOrigin<S, Data>>) => void) {
		const { length } = this.content;
		if (!isRange(start, end, length)) {
			throw new RangeError(`The range ${start}..${end} is out of 0..${length}.`);
		}
		this.freeze();
		const { roots, removals } = this;
		const { keys } = this.edits;
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
		let edit = 0;
		// a view skips the cut that it starts inside, but for the afters of the wraps around it at its last char
		const first = roots[index];
		if (first && first.start < start) {
			pos = first.end < end ? first.end : end;
			edit = first.endEdit;
			index++;
		}
		else if (start) {
			high = this.edits.code.length;
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
		this.rendering++;
		try {
			this.renderSpan(pos, end, edit, this.edits.code.length, removal * 2, roots, index, data, sink, end === length);
		}
		finally {
			this.rendering--;
		}
	}

	/**
	 * The text from `pos` to `end` with the edits in it, from the edit `edit` on and before `editEnd`, and from the
	 * removal `removal` on, but for the text of `children`, the cuts in it from `index`, sorted and disjoint: their
	 * placeholders render in their place. Kept text has the fields of `data`, and `tail` renders the code at the end of
	 * the text.
	 */
	renderSpan(
		pos: number,
		end: number,
		edit: number,
		editEnd: number,
		removal: number,
		children: readonly Cut<S, Data>[] | undefined,
		index: number,
		data: Data,
		sink: (piece: Piece<RewriteOrigin<S, Data>>) => void,
		tail: boolean,
	) {
		const { removals, removalsSize, source } = this;
		const { keys, code } = this.edits;
		while (true) {
			const child = children?.[index];
			const entering = child !== undefined && child.start < end;
			const stop = entering ? child.start : end;
			const last = stop * 4;
			// before a child, the edits before its own, which include those of the wraps around it at its first char
			const limit = entering ? child.firstEdit : editEnd;
			while (true) {
				// no key is below -1
				const key = edit < limit && (entering || keys[edit]! < last) ? keys[edit]! : -8;
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
				renderCode(code[edit++]!, sink, data);
			}
			if (stop === end) {
				break;
			}
			if (child!.placeholder !== undefined) {
				renderCode(child!.placeholder, sink, data);
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
			while (edit < editEnd) {
				renderCode(code[edit++]!, sink, data);
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

	/** Lets the edits change: a render while they change would deliver part of the text from before the change. */
	private thaw() {
		if (this.rendering) {
			throw new Error('The rewrite is rendering.');
		}
		if (this.frozen) {
			this.frozen = false;
			this.error = undefined;
			for (const cut of this.cuts) {
				cut.renderers = undefined;
				cut.visit = Visit.Unvisited;
			}
		}
	}

	freeze() {
		if (this.source.content !== this.content) {
			throw new Error('The content of the source changed after the rewrite was made.');
		}
		if (this.frozen) {
			if (this.error) {
				throw this.error;
			}
			return;
		}
		this.frozen = true;
		this.edits.sort();
		this.mergeRemovals();
		try {
			this.compile();
		}
		catch (error) {
			this.error = error;
			throw error;
		}
	}

	/**
	 * Finds where the edits and the removals of each cut start and end, and the cut that owns each edit, in one walk of
	 * the cuts in the order of their starts and ends: an edit at a char of a cut is of the cut, but for those of the
	 * wraps around it at its first and last char. Then checks that no wrap crosses a cut, and the placements of the
	 * cuts.
	 */
	private compile() {
		if (!this.cuts.length) {
			return;
		}
		const { keys, nests, code } = this.edits;
		const count = code.length;
		const { removals, removalsSize } = this;
		/** The cut that owns each edit, by its index in `code`. */
		const owners: (Cut<S, Data> | undefined)[] = [];
		let edit = 0;
		let removal = 0;
		/** The cuts entered and not left but the innermost, `owner`, each with the index of its next child. */
		const path: (Cut<S, Data> | undefined)[] = [];
		const nextChild: number[] = [];
		let owner: Cut<S, Data> | undefined;
		let children: Cut<S, Data>[] | undefined = this.roots;
		let index = 0;
		while (true) {
			const child: Cut<S, Data> | undefined = children?.[index];
			if (child) {
				// up to the edits of the child: before its first char, and the befores of wraps that end after it
				const key = child.start * 4 + Side.Before;
				const wider = -child.end;
				for (; edit < count && (keys[edit]! < key || (keys[edit] === key && nests[edit]! < wider)); edit++) {
					owners.push(own(owner, keys[edit]!, nests[edit]!));
				}
				for (; removal < removalsSize && removals[removal + 1]! <= child.start; removal += 2);
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
			// up to the afters of wraps at its last char that start before it
			const key = (owner.end - 1) * 4 + Side.After;
			const inner = -owner.start;
			for (; edit < count && (keys[edit]! < key || (keys[edit] === key && nests[edit]! <= inner)); edit++) {
				owners.push(own(owner, keys[edit]!, nests[edit]!));
			}
			for (; removal < removalsSize && removals[removal + 1]! <= owner.end; removal += 2);
			owner.endEdit = edit;
			owner.endRemoval = removal;
			owner = path.pop();
			index = nextChild.pop()!;
			children = owner ? owner.children : this.roots;
		}
		/** The cuts that have renderers. */
		const placed: Cut<S, Data>[] = [];
		// in render order, which decides the cut that the error of a cycle names
		for (let index = 0; index < owners.length; index++) {
			const owner = owners[index];
			if (owner) {
				place(this, placed, code[index]!, owner);
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
		this.removalsSorted = true;
	}
}

/** `owner`, which owns the edit of `key` and `nest`, unless the edit is of a wrap that crosses it. */
function own<S extends Source, Data>(owner: Cut<S, Data> | undefined, key: number, nest: number) {
	if (owner) {
		const side = key & 3;
		if (side === Side.Before && -nest > owner.end) {
			throw new RangeError(`The wrap ${key >> 2}..${-nest} crosses ${nameCut(owner).toLowerCase()}.`);
		}
		if (side === Side.After && nest <= 0 && -nest < owner.start) {
			throw new RangeError(`The wrap ${-nest}..${(key >> 2) + 1} crosses ${nameCut(owner).toLowerCase()}.`);
		}
	}
	return owner;
}

/**
 * Records the cuts of `rewrite` placed in `code` as rendered by `renderer`, and adds each to `placed` the first time;
 * a view is no renderer. Not a closure in `compile`: a new closure at each freeze makes V8 deoptimize the call.
 */
function place<S extends Source, Data>(
	rewrite: Rewrite<S, Data>,
	placed: Cut<S, Data>[],
	code: RewriteCode<S, Data>,
	renderer: Cut<S, Data>,
) {
	if (typeof code === 'string') {
		return;
	}
	if (isCodeArray<S, Data>(code)) {
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
function checkRenderers<S extends Source, Data>(placed: Cut<S, Data>[]) {
	/** The walked cuts, each with the index of its next renderer. */
	const path: Cut<S, Data>[] = [];
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
	Rendered,
}

function nameCut(cut: { start: number; end: number }) {
	return `The cut ${cut.start}..${cut.end}`;
}

function isRange(start: number, end: number, length: number) {
	return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start <= end && end <= length;
}

class Cut<S extends Source, Data> implements RewriteSlice<S, Data> {
	/** The cuts directly inside, sorted and disjoint. */
	children: Cut<S, Data>[] | undefined;
	/** The cuts whose render renders code that it is placed in. */
	renderers: Cut<S, Data>[] | undefined;
	visit = Visit.Unvisited;
	state = CutState.Unrendered;
	/** When frozen, the indexes of the edits and removals of the rewrite at its start and at its end. */
	firstEdit = 0;
	firstRemoval = 0;
	endEdit = 0;
	endRemoval = 0;

	constructor(
		readonly rewrite: Rewrite<S, Data>,
		/** The cut that contains it directly, which renders its placeholder; none for a view. */
		public parent: Cut<S, Data> | undefined,
		readonly start: number,
		readonly end: number,
		/** The fields that the cut sets over the data of the code it renders in; none if it sets none. */
		readonly data: Partial<Data> | undefined,
		readonly placeholder: RewriteCode<S, Data> | undefined,
	) {}

	render(sink: (piece: Piece<RewriteOrigin<S, Data>>) => void, outer?: Data) {
		const { rewrite } = this;
		rewrite.freeze();
		if (this.state === CutState.Rendering) {
			throw new Error(`${nameCut(this)} is placed inside itself, so it never renders.`);
		}
		this.state = CutState.Rendering;
		rewrite.rendering++;
		try {
			const { start, end, firstEdit, firstRemoval, children, data } = this;
			const fields = data ? { ...outer, ...data } as Data : outer ?? {} as Data;
			rewrite.renderSpan(start, end, firstEdit, this.endEdit, firstRemoval, children, 0, fields, sink, false);
		}
		finally {
			rewrite.rendering--;
			this.state = CutState.Rendered;
		}
	}
}

function renderCode<S extends Source, Data>(
	code: RewriteCode<S, Data>,
	sink: (piece: Piece<RewriteOrigin<S, Data>>) => void,
	data: Data,
) {
	if (typeof code === 'string') {
		if (code) {
			sink(code);
		}
	}
	else if (isCodeArray<S, Data>(code)) {
		for (let index = 0; index < code.length; index++) {
			renderCode(code[index]!, sink, data);
		}
	}
	else if (isSlice<S, Data>(code)) {
		(code.render as (sink: (piece: Piece<RewriteOrigin<S, Data>>) => void, data: Data) => void)(sink, data);
	}
	else {
		sink(code as Piece<RewriteOrigin<S, Data>>);
	}
}

function isCodeArray<S extends Source, Data>(code: RewriteCode<S, Data>): code is readonly RewriteCode<S, Data>[] {
	return Array.isArray(code);
}

function isSlice<S extends Source, Data>(code: RewriteCode<S, Data>): code is RewriteSlice<S, Data> {
	return typeof (code as RewriteSlice<S, Data>).render === 'function';
}
