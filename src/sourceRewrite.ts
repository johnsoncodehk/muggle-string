import { describe, isRange, notPiece, rangeProblem, type UncheckedRange } from './piece.js';
import type { Piece, Source } from './types.js';

// `Symbol.for`, as a cut of another copy of the package, such as its CommonJS build, is a slice too: every copy finds
// under it where the slice is placed, and records there where it places it
const sliceBrand = Symbol.for('muggle-string.slice');

/** Where a slice is placed, which every copy of the package that places it records under the brand of the slice. */
interface SlicePlaces {
	/** The range of its cut, which the error of an edit that places it wrongly names. */
	readonly start: number;
	readonly end: number;
	/** Whether it is placed in the code before or after all text, which a view renders. */
	inView: boolean;
	/**
	 * For each other place, in the code of an edit or in a placeholder, what gives the slice that renders the code there
	 * now, or nothing when a view does: a later cut around the place changes it.
	 */
	renderers: (() => PlacedSlice | undefined)[] | undefined;
}

/** A slice of any rewrite of any copy of the package, as the edits that place it see it. */
interface PlacedSlice {
	readonly [sliceBrand]: SlicePlaces;
}

/**
 * What a range of a rewrite carries beyond its offsets: its `source`; `name`, the original name of the symbol that a
 * range with `text` renames, which a source map takes; and `data`, the value of the consumer, which the rewrite never
 * reads. A kept range has the `data` of the cut or the view that renders it, and no `data` field when that is
 * undefined. `data` is required where `Data` does not include undefined.
 */
export type RewriteOrigin<S extends Source, Data = undefined> =
	& { source: S; name?: string }
	& (undefined extends Data ? { data?: Data } : { data: Data });

/**
 * Code written into a rewrite: pieces, slices, which render their cut in place, and arrays of code. Only `cut` makes a
 * slice; any other object is a range. Code is checked when it is written: a value that is not code, or a range that no
 * render takes, throws there. An array is read once, when it is written; a range is passed on as the object it is.
 */
export type RewriteCode<S extends Source, Data = undefined> =
	| Piece<RewriteOrigin<S, Data>>
	| RewriteSlice<S, Data>
	| readonly RewriteCode<S, Data>[];

/**
 * The options of a cut: `data`, the data of its kept pieces, required where `Data` does not include undefined, and
 * `placeholder`, the code that takes the place of the cut in the cut that contains it. An object with any other field
 * throws.
 */
export type RewriteCutOptions<S extends Source, Data = undefined> =
	& (undefined extends Data ? { data?: Data } : { data: Data })
	& { placeholder?: RewriteCode<S, Data> };

export interface RewriteWriter<S extends Source, Data = undefined> {
	/**
	 * `code` right before the text that starts at `offset`; it goes wherever that text goes. At the end of the text,
	 * no text starts there: the code stays after all text.
	 */
	insertBefore(offset: number, code: RewriteCode<S, Data>): void;
	/**
	 * `code` right after the text that ends at `offset`; it goes wherever that text goes. At 0, no text ends there: the
	 * code stays before all text.
	 */
	insertAfter(offset: number, code: RewriteCode<S, Data>): void;
	/**
	 * The text at `start`..`end` is not rendered; `code` takes the place of its first char. An empty range removes
	 * nothing, and `code` goes in the place of the char at `start`, inside the inserts there, or at the end of the text.
	 */
	replace(start: number, end: number, code: RewriteCode<S, Data>): void;
}

/** What `cut` returns; no other object is a slice. */
export interface RewriteSlice<S extends Source, Data = undefined> extends PlacedSlice {
	/** Passes the pieces of the slice to `sink`, in order: no string is empty, and kept text is a range without `text`. */
	render(sink: (piece: Piece<RewriteOrigin<S, Data>>) => void): void;
}

/**
 * Edits of one source text by ranked writers. Inserts attach to a side of a char, removals add up, and text moves
 * only by slices, which nest or are disjoint, so edits never conflict. The rewrite is itself the outermost writer.
 * A render renders the edits made before it; an edit while a render runs throws.
 */
export interface SourceRewrite<S extends Source, Data = undefined> extends RewriteWriter<S, Data> {
	/** The source that the rewrite edits, which its kept pieces carry. */
	readonly source: S;
	/**
	 * The writer of `rank`, a non-negative integer. A higher rank sits outside a lower one, and the rewrite outside
	 * all.
	 */
	writer(rank: number): RewriteWriter<S, Data>;
	/**
	 * The slice of `start`..`end` (not empty): its text, with the edits of all writers in it, renders where the slice is
	 * placed, kept text with the `data` of `options`, and the `placeholder` of `options` takes its place where it is cut
	 * from. Cuts are made in any order: a cut inside another moves with it, of two cuts of one range the later is
	 * inside, and a cut that crosses another throws. Text that is not wanted is removed by `replace`; a slice is cut to
	 * be placed, and `unrendered` tells one that is not.
	 *
	 * A slice renders wherever and as often as it is placed and rendered. An edit that places a slice in code that only
	 * its own render renders, as in its own range, throws.
	 */
	cut(
		start: number,
		end: number,
		...options: undefined extends Data ? [options?: RewriteCutOptions<S, Data>] : [options: RewriteCutOptions<S, Data>]
	): RewriteSlice<S, Data>;
	/**
	 * Passes the pieces of the text at `start`..`end`, with the edits in it, to `sink`, kept text with `data`: a view,
	 * which owns no text, so views can overlap and render again. The text of a slice renders where the slice is placed,
	 * with the data of its cut, and its placeholder in the view of its start. The code before all text renders in a view
	 * from 0, and the code after all text in a view to the end of the text.
	 */
	render(
		start: number,
		end: number,
		sink: (piece: Piece<RewriteOrigin<S, Data>>) => void,
		...data: undefined extends Data ? [data?: Data] : [data: Data]
	): void;
	/**
	 * The slices that no view renders, in cut order: those placed in no code, or only in code that moves with such a
	 * slice. It tells what the edits place, whatever has rendered: a slice that only its own `render` renders is one of
	 * them.
	 */
	unrendered(): RewriteSlice<S, Data>[];
}

/**
 * A rewrite of the content of `source`; a render after the content changed throws. `Data` is the type of the `data`
 * of its ranges, which the cuts and views give: none by default.
 */
export function createSourceRewrite<S extends Source, Data = undefined>(source: S): SourceRewrite<S, Data> {
	const rewrite = new Rewrite<S, Data>(source);
	return {
		...rewrite.core,
		source,
		writer: rank => rewrite.writer(rank),
		cut: (start: number, end: number, options?: RewriteCutOptions<S, Data>) => rewrite.cut(start, end, options),
		render: (start: number, end: number, sink: Sink<S, Data>, data?: Data) =>
			rewrite.render(start, end, data, sink),
		unrendered: () => rewrite.unrendered(),
	};
}

type Sink<S extends Source, Data> = (piece: Piece<RewriteOrigin<S, Data>>) => void;

/**
 * The generated text of `piece`: new text, the `text` of a range, or the content of its source that it keeps. It
 * takes the pieces that `renderWithSourceMap` takes, by the same check: a range without a source, whose `start` and
 * `end` are not integers with 0 <= `start` <= `end` <= the length of the content, or whose `text` or `name` is neither
 * undefined nor a string, throws, with `text` or without.
 */
export function rewritePieceText(piece: Piece<{ source: Source }>): string {
	if (typeof piece === 'string') {
		return piece;
	}
	if (typeof piece !== 'object' || piece === null) {
		throw notPiece(piece);
	}
	const problem = rangeProblem(piece);
	if (problem) {
		throw new problem[0](`The range ${piece.start}..${piece.end} ${problem[1]}.`);
	}
	const { text } = piece;
	return text === undefined ? piece.source.content.slice(piece.start, piece.end) : text;
}

// a slice of version 1 has true there, and no record of its places: it is no slice here
function isPlaces(places: unknown): places is SlicePlaces {
	return typeof places === 'object' && places !== null;
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
class Edits<S extends Source, Data> {
	/** The keys of the edits, as many as `code`. */
	keys = new Int32Array(16);
	code: RewriteCode<S, Data>[] = [];
	/** Whether the edits arrived in render order. */
	sorted = true;

	constructor(
		readonly rank: number,
		/** The writer that adds the edits. */
		readonly writer: RewriteWriter<S, Data>,
	) {}

	add(at: number, side: Side, code: RewriteCode<S, Data>) {
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
		// no key is below -4, the key of the code before all text
		const sorted = sortOrder(keys, size, 1, 4);
		const sortedKeys = new Int32Array(size);
		const sortedCode: RewriteCode<S, Data>[] = [];
		for (let index = 0; index < size; index++) {
			sortedKeys[index] = keys[sorted[index]!]!;
			sortedCode.push(code[sorted[index]!]!);
		}
		this.keys = sortedKeys;
		this.code = sortedCode;
		this.sorted = true;
	}
}

class Rewrite<S extends Source, Data> {
	/** The writer of the outermost rank, which the rewrite is. */
	readonly core: RewriteWriter<S, Data>;
	/** The edits of each writer, by rank. */
	edits = new Map<number, Edits<S, Data>>();
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
	/** The content of the source when the rewrite was made. */
	readonly content: string;
	/** When frozen, the keys and code of the edits of all writers, in render order. */
	keys: Int32Array = new Int32Array(0);
	code: RewriteCode<S, Data>[] = [];

	constructor(readonly source: S) {
		this.content = source.content;
		this.core = this.createEdits(coreRank).writer;
	}

	writer(rank: number): RewriteWriter<S, Data> {
		if (!Number.isInteger(rank) || rank < 0 || rank >= coreRank) {
			throw new RangeError(`The rank ${rank} is not a non-negative integer below the rank of the rewrite.`);
		}
		return (this.edits.get(rank) ?? this.createEdits(rank)).writer;
	}

	private createEdits(rank: number) {
		const writer: RewriteWriter<S, Data> = {
			insertBefore: (offset, code) => {
				this.check(offset, offset);
				code = this.accept(code, offset, 'insertBefore', offset, offset);
				edits.add(offset, offset === this.content.length ? Side.After : Side.Before, code);
			},
			insertAfter: (offset, code) => {
				this.check(offset, offset);
				code = this.accept(code, offset - 1, 'insertAfter', offset, offset);
				edits.add(offset ? offset - 1 : -1, offset ? Side.After : Side.Before, code);
			},
			replace: (start, end, code) => {
				this.check(start, end);
				if (start < end) {
					edits.add(start, Side.Slot, this.accept(code, start, 'replace', start, end));
					this.addRemoval(start, end);
				}
				else if (code !== '') {
					edits.add(start, Side.Slot, this.accept(code, start, 'replace', start, end));
				}
			},
		};
		const edits = new Edits(rank, writer);
		this.edits.set(rank, edits);
		return edits;
	}

	private check(start: number, end: number) {
		this.thaw();
		const { length } = this.content;
		if (!isRange(start, end, length)) {
			throw new RangeError(`${start === end ? `The offset ${start}` : `The range ${start}..${end}`} is out of 0..${length}.`);
		}
	}

	/**
	 * `code` as the rewrite holds it, once it is known to be code that renders. The slices in it are placed at the char
	 * `at`, in the code of the edit that `method` makes at `start`..`end`.
	 */
	private accept(code: RewriteCode<S, Data>, at: number, method: EditMethod, start: number, end: number) {
		if (typeof code === 'string') {
			return code;
		}
		// most code that places a slice is the slice, which needs no check; code is any value until it is read
		if (typeof code === 'object' && code !== null && isSlice<S, Data>(code)) {
			this.place(code, at, method, start, end);
			return code;
		}
		const array = isCodeArray<S, Data>(code);
		code = readCode<S, Data>(code, method, start, end);
		// a range holds no slice
		const slices = array && slicesOf(code);
		if (slices) {
			this.place(slices, at, method, start, end);
		}
		return code;
	}

	/** Places `slices` in the code of the edit that `method` makes at `start`..`end`, at the char `at`. */
	private place(slices: PlacedSlice | PlacedSlice[], at: number, method: EditMethod, start: number, end: number) {
		// the code before and after all text is at no char: no cut holds it, now or later
		if (at < 0 || at >= this.content.length) {
			if (isSlices(slices)) {
				for (const slice of slices) {
					slice[sliceBrand].inView = true;
				}
			}
			else {
				slices[sliceBrand].inView = true;
			}
			return;
		}
		const owner = this.ownerAt(at);
		const inside = owner && firstRendering(slices, owner);
		if (inside) {
			throw new Error(
				`${nameEdit(method, start, end)}: ${nameCut(inside)} would be placed inside itself, so it would never render.${
					inside !== owner
						? ''
						: method === 'insertBefore' && start === owner.start
						? ` Code before the char at ${start} is part of the cut that starts there: insertAfter(${start}, code) places code before that cut.`
						: method === 'insertAfter' && start === owner.end
						? ` Code after the char that ends at ${start} is part of the cut that ends there: insertBefore(${start}, code) places code after that cut.`
						: ''
				}`,
			);
		}
		// a later cut around the char renders the code there
		addRenderer(slices, () => this.ownerAt(at));
	}

	/** The innermost cut that holds the char `at`, which renders the code of the edits at it; none out of all cuts. */
	ownerAt(at: number) {
		let owner: Cut<S, Data> | undefined;
		let children: Cut<S, Data>[] | undefined = this.roots;
		while (children) {
			let low = 0;
			let high = children.length;
			while (low < high) {
				const mid = (low + high) >>> 1;
				if (children[mid]!.end <= at) {
					low = mid + 1;
				}
				else {
					high = mid;
				}
			}
			const child: Cut<S, Data> | undefined = children[low];
			if (!child || child.start > at) {
				break;
			}
			owner = child;
			children = child.children;
		}
		return owner;
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
		let data: Data | undefined;
		let placeholder: RewriteCode<S, Data> | undefined;
		/** The slices in the placeholder. */
		let slices: PlacedSlice | PlacedSlice[] | undefined;
		if (options !== undefined) {
			if (typeof options !== 'object' || options === null || Array.isArray(options)) {
				throw new TypeError(`${nameCutCall(start, end)}: the options are ${describe(options)}, not an object.`);
			}
			for (const key of Object.keys(options)) {
				if (key !== 'data' && key !== 'placeholder') {
					throw new TypeError(
						`${nameCutCall(start, end)}: ${JSON.stringify(key)} is not an option of a cut, which are "data" and "placeholder".`,
					);
				}
			}
			({ data, placeholder } = options);
			if (placeholder !== undefined && typeof placeholder !== 'string') {
				placeholder = readCode<S, Data>(placeholder, 'cut', start, end);
				slices = slicesOf(placeholder);
			}
		}
		// the innermost cut that holds the range is inside any cut that holds it, so the search starts from the closest
		// such cut around the last one made: cuts usually come in order, or each inside the last
		let parent: Cut<S, Data> | undefined = this.cuts[this.cuts.length - 1];
		while (parent && (start < parent.start || parent.end < end)) {
			parent = parent.parent;
		}
		let siblings = parent ? parent.children ??= [] : this.roots;
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
					throw new RangeError(`The cut ${start}..${end} crosses ${nameCut(inner)}.`);
				}
			}
			// the cut that contains the cut renders its placeholder
			const inside = slices && parent && firstRendering(slices, parent);
			if (inside) {
				throw new Error(
					`${nameCutCall(start, end)}: ${nameCut(inside)} would be placed inside itself by the placeholder, so it would never render.`,
				);
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
			if (slices) {
				// a later cut around the cut renders its placeholder
				addRenderer(slices, () => cut.parent);
			}
			this.cuts.push(cut);
			return cut;
		}
	}

	/** The view `start`..`end`. */
	render(start: number, end: number, data: Data | undefined, sink: (piece: Piece<RewriteOrigin<S, Data>>) => void) {
		const { length } = this.content;
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
		this.rendering++;
		try {
			this.renderSpan(pos, end, edit, removal * 2, roots, index, data, sink, end === length);
		}
		finally {
			this.rendering--;
		}
	}

	/**
	 * The text from `pos` to `end` with the edits in it, from the edit `edit` and the removal `removal` on, but for the
	 * text of `children`, the cuts in it from `index`, sorted and disjoint: their placeholders render in their place.
	 * Kept text has `data`, and `tail` renders the code after all text.
	 */
	renderSpan(
		pos: number,
		end: number,
		edit: number,
		removal: number,
		children: readonly Cut<S, Data>[] | undefined,
		index: number,
		data: Data | undefined,
		sink: (piece: Piece<RewriteOrigin<S, Data>>) => void,
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
					sink(
						(data === undefined
							? { source, start: pos, end: runEnd }
							: { source, start: pos, end: runEnd, data }) as Piece<RewriteOrigin<S, Data>>,
					);
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

	/** Lets the edits change: a render while they change would deliver part of the text from before the change. */
	private thaw() {
		if (this.rendering) {
			throw new Error('The rewrite is rendering.');
		}
		this.frozen = false;
	}

	freeze() {
		if (this.source.content !== this.content) {
			throw new Error('The content of the source changed after the rewrite was made.');
		}
		if (this.frozen) {
			return;
		}
		this.frozen = true;
		const writers = [...this.edits.values()].filter(edits => edits.code.length);
		for (const edits of writers) {
			edits.sort();
		}
		this.mergeRemovals();
		this.compile(writers);
	}

	/**
	 * Merges the edits of all writers in render order, and finds where the edits and the removals of each cut start and
	 * end, in one walk of the cuts in the order of their starts and ends.
	 */
	private compile(writers: Edits<S, Data>[]) {
		const [keys, code] = mergeEdits(writers);
		this.keys = keys;
		this.code = code;
		if (!this.cuts.length) {
			return;
		}
		const count = code.length;
		const { removals, removalsSize } = this;
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
			// enters the next child, or leaves the cut
			const at = child ? child.start : owner ? owner.end : Infinity;
			for (; edit < count && keys[edit]! < at * 4; edit++);
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
	}

	/**
	 * The cuts that no view renders: a view renders a cut that is placed in code out of all cuts, in the placeholder of
	 * an outermost cut, or in code or a placeholder that a cut that a view renders does. No cut renders itself, as the
	 * edits refuse it, so the search ends.
	 */
	unrendered() {
		const known = new Map<PlacedSlice, boolean>();
		const rendered = (slice: PlacedSlice): boolean => {
			let is = known.get(slice);
			if (is === undefined) {
				const { inView, renderers } = slice[sliceBrand];
				is = inView;
				if (!is && renderers) {
					for (const renderer of renderers) {
						const by = renderer();
						if (!by || rendered(by)) {
							is = true;
							break;
						}
					}
				}
				known.set(slice, is);
			}
			return is;
		};
		return this.cuts.filter(cut => !rendered(cut));
	}

	private mergeRemovals() {
		let removals = this.removals;
		const pairs = this.removalsSize >> 1;
		if (!this.removalsSorted) {
			const sorted = sortOrder(removals, pairs, 2, 0);
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

/**
 * The indexes 0..`size` - 1 in the order of their values, `values[index * stride] + bias`, which are not negative, and
 * of the index among equal values: a radix sort by byte, which takes as long whatever the order of the values.
 */
function sortOrder(values: Int32Array, size: number, stride: number, bias: number) {
	let order = new Int32Array(size);
	for (let index = 0; index < size; index++) {
		order[index] = index;
	}
	if (size <= 16) {
		for (let index = 1; index < size; index++) {
			const value = values[index * stride]!;
			let at = index;
			for (; at && values[order[at - 1]! * stride]! > value; at--) {
				order[at] = order[at - 1]!;
			}
			order[at] = index;
		}
		return order;
	}
	let next = new Int32Array(size);
	const counts = new Int32Array(256);
	for (let shift = 0; shift < 32; shift += 8) {
		counts.fill(0);
		for (let index = 0; index < size; index++) {
			counts[((values[index * stride]! + bias) >>> shift) & 255]!++;
		}
		// a byte that all values share moves none
		if (counts[((values[0]! + bias) >>> shift) & 255] === size) {
			continue;
		}
		let total = 0;
		for (let digit = 0; digit < 256; digit++) {
			const count = counts[digit]!;
			counts[digit] = total;
			total += count;
		}
		for (let index = 0; index < size; index++) {
			const at = order[index]!;
			next[counts[((values[at * stride]! + bias) >>> shift) & 255]!++] = at;
		}
		const swap = order;
		order = next;
		next = swap;
	}
	return order;
}

/**
 * The keys and code of all writers, in render order: at one side of one char, the code before the text goes outermost
 * (highest rank) first, and the code in the place of the char and after the text innermost first.
 */
function mergeEdits<S extends Source, Data>(
	writers: Edits<S, Data>[],
): [Int32Array, RewriteCode<S, Data>[]] {
	if (writers.length < 2) {
		return writers.length ? [writers[0]!.keys, writers[0]!.code] : [new Int32Array(0), []];
	}
	let total = 0;
	for (const edits of writers) {
		total += edits.code.length;
	}
	const keys = new Int32Array(total);
	const merged: RewriteCode<S, Data>[] = [];
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
			return [keys, merged];
		}
		const edits = writers[best]!;
		let edit = next[best]!;
		// an edit at `bound` itself may lose to the other writer there: it is chosen again
		do {
			keys[merged.length] = edits.keys[edit]!;
			merged.push(edits.code[edit++]!);
		}
		while (edit < edits.code.length && edits.keys[edit]! < bound);
		next[best] = edit;
	}
}

type EditMethod = 'insertBefore' | 'insertAfter' | 'replace';

function nameEdit(method: EditMethod, start: number, end: number) {
	return method === 'replace' ? `replace(${start}, ${end}, code)` : `${method}(${start}, code)`;
}

function nameCutCall(start: number, end: number) {
	return `cut(${start}, ${end}, options)`;
}

function nameCut(slice: PlacedSlice) {
	const { start, end } = slice[sliceBrand];
	return `the cut ${start}..${end}`;
}

/** What is wrong with code: the class of its error, where in the code, and the rest of the sentence. */
interface CodeProblem {
	type: TypeErrorConstructor | RangeErrorConstructor;
	path: string;
	problem: string;
}

// deeper than any code that is written by hand or generated, and well within the call stack
const maxCodeDepth = 500;

/**
 * `code`, which is not a string, as a rewrite holds it, once it is known to be code that renders: a range or a slice
 * as it is, and an array as a flat copy of its values that are not empty strings, or as its one value, or as '' when
 * it has none. Code with a value that is not a string, a range that the renders take, a slice or an array of them
 * throws, for the call of `method` at `start`..`end` that writes it: an edit, or a cut, whose placeholder it is.
 */
function readCode<S extends Source, Data>(
	code: RewriteCode<S, Data>,
	method: EditMethod | 'cut',
	start: number,
	end: number,
): RewriteCode<S, Data> {
	let problem: CodeProblem | undefined;
	if (isCodeArray<S, Data>(code)) {
		const flat: RewriteCode<S, Data>[] = [];
		problem = flatten(code, 0, flat);
		code = flat.length > 1 ? flat : flat.length ? flat[0]! : '';
	}
	else {
		problem = valueProblem(code);
	}
	if (problem) {
		throw new problem.type(
			`${method === 'cut' ? `${nameCutCall(start, end)}: the placeholder` : `${nameEdit(method, start, end)}: code`}${problem.path}${problem.problem}.`,
		);
	}
	return code;
}

/** Adds the values of `code` and of the arrays in it that are not empty strings to `flat`, up to one that is not code. */
function flatten(code: readonly unknown[], depth: number, flat: unknown[]): CodeProblem | undefined {
	if (depth === maxCodeDepth) {
		return {
			type: TypeError,
			path: '',
			problem: ` is nested in more than ${maxCodeDepth} arrays, as an array that holds itself is`,
		};
	}
	for (let index = 0; index < code.length; index++) {
		const value = code[index];
		if (typeof value === 'string') {
			if (value) {
				flat.push(value);
			}
			continue;
		}
		const nested = Array.isArray(value);
		const problem = nested ? flatten(value, depth + 1, flat) : valueProblem(value);
		if (problem) {
			problem.path = `[${index}]${problem.path}`;
			return problem;
		}
		if (!nested) {
			flat.push(value);
		}
	}
	return undefined;
}

/** What is wrong with `value`, which is neither a string nor an array, as code: it is no slice, and no range that the renders take. */
function valueProblem(value: unknown): CodeProblem | undefined {
	if (typeof value !== 'object' || value === null) {
		return {
			type: TypeError,
			path: '',
			problem: ` is ${describe(value)}, which is not code: a string, a range, a slice or an array of them`,
		};
	}
	if (isPlaces((value as Partial<PlacedSlice>)[sliceBrand])) {
		return undefined;
	}
	const { start, end } = value as UncheckedRange;
	if (typeof start !== 'number' || typeof end !== 'number') {
		return {
			type: TypeError,
			path: '',
			problem: ' is an object without a start and an end, which is not code: a string, a range, a slice or an array of them',
		};
	}
	const problem = rangeProblem(value as UncheckedRange);
	return problem && { type: problem[0], path: '', problem: `, the range ${start}..${end}, ${problem[1]}` };
}

/**
 * The slices in `code` as a rewrite holds it: the slice that it is, as most code that places a slice, or those of its
 * array, if any. No list is made for one slice: a rewrite of many cuts places each by an edit of its own.
 */
function slicesOf<S extends Source, Data>(code: RewriteCode<S, Data>): PlacedSlice | PlacedSlice[] | undefined {
	if (typeof code === 'string') {
		return undefined;
	}
	if (!isCodeArray<S, Data>(code)) {
		return isSlice<S, Data>(code) ? code : undefined;
	}
	let slices: PlacedSlice[] | undefined;
	for (let index = 0; index < code.length; index++) {
		const value = code[index]!;
		if (typeof value !== 'string' && isSlice<S, Data>(value)) {
			(slices ??= []).push(value);
		}
	}
	return slices;
}

function isSlices(slices: PlacedSlice | PlacedSlice[]): slices is PlacedSlice[] {
	return Array.isArray(slices);
}

/** The first of `slices` whose render renders `owner`, if any. */
function firstRendering(slices: PlacedSlice | PlacedSlice[], owner: PlacedSlice) {
	return isSlices(slices) ? slices.find(slice => renders(slice, owner)) : renders(slices, owner) ? slices : undefined;
}

/** Records a place of `slices`: `renderer` gives the slice that renders the code there, or nothing when a view does. */
function addRenderer(slices: PlacedSlice | PlacedSlice[], renderer: () => PlacedSlice | undefined) {
	if (isSlices(slices)) {
		for (const slice of slices) {
			(slice[sliceBrand].renderers ??= []).push(renderer);
		}
	}
	else {
		(slices[sliceBrand].renderers ??= []).push(renderer);
	}
}

/**
 * Whether a render of `slice` renders `owner`: it is `owner`, or it renders code that `owner` is placed in, itself or
 * through the slices placed in it. A slice placed in code that `owner` renders would then render only by its own
 * render. Code at a char renders in the innermost cut that holds the char, and a placeholder in the cut around its own.
 */
function renders(slice: PlacedSlice, owner: PlacedSlice) {
	if (slice === owner) {
		return true;
	}
	if (!owner[sliceBrand].renderers) {
		return false;
	}
	const seen = new Set([owner]);
	const walk = [owner];
	while (walk.length) {
		for (const renderer of walk.pop()![sliceBrand].renderers ?? []) {
			const by = renderer();
			if (by === slice) {
				return true;
			}
			if (by && !seen.has(by)) {
				seen.add(by);
				walk.push(by);
			}
		}
	}
	return false;
}

class Cut<S extends Source, Data> implements RewriteSlice<S, Data> {
	readonly [sliceBrand]: SlicePlaces;
	/** The cuts directly inside, sorted and disjoint. */
	children: Cut<S, Data>[] | undefined;
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
		/** The data of its kept pieces. */
		readonly data: Data | undefined,
		/** The code that takes its place in the cut that contains it; undefined when it has none. */
		readonly placeholder: RewriteCode<S, Data> | undefined,
	) {
		this[sliceBrand] = { start, end, inView: false, renderers: undefined };
	}

	render(sink: (piece: Piece<RewriteOrigin<S, Data>>) => void) {
		const { rewrite } = this;
		rewrite.freeze();
		rewrite.rendering++;
		try {
			const { start, end, firstEdit, firstRemoval, children } = this;
			rewrite.renderSpan(start, end, firstEdit, firstRemoval, children, 0, this.data, sink, false);
		}
		finally {
			rewrite.rendering--;
		}
	}
}

/** Renders code as a rewrite holds it. */
function renderCode<S extends Source, Data>(
	code: RewriteCode<S, Data>,
	sink: (piece: Piece<RewriteOrigin<S, Data>>) => void,
) {
	if (typeof code === 'string') {
		if (code) {
			sink(code);
		}
	}
	else if (isCodeArray<S, Data>(code)) {
		for (let index = 0; index < code.length; index++) {
			const value = code[index]!;
			if (typeof value !== 'string' && isSlice<S, Data>(value)) {
				value.render(sink);
			}
			else {
				sink(value as Piece<RewriteOrigin<S, Data>>);
			}
		}
	}
	else if (isSlice<S, Data>(code)) {
		code.render(sink);
	}
	else {
		sink(code);
	}
}

function isCodeArray<S extends Source, Data>(code: RewriteCode<S, Data>): code is readonly RewriteCode<S, Data>[] {
	return Array.isArray(code);
}

function isSlice<S extends Source, Data>(code: RewriteCode<S, Data>): code is RewriteSlice<S, Data> {
	return isPlaces((code as Partial<PlacedSlice>)[sliceBrand]);
}
