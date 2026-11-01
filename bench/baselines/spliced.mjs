// The obvious first version of a ranked rewrite: one array of edits, kept sorted by splicing each edit into its place,
// and a sorted array of removals. It has the inserts, replaces, writers and ranks of the rewrite, but no cuts or views.

const coreRank = 0x7fffffff;
const before = 0;
const slot = 1;
const after = 2;

export function createSourceRewrite(source) {
	const edits = [];
	const removals = [];
	let calls = 0;
	// at one side of one char: code before the text outermost first, the rest innermost first, then call order
	const precedes = (a, b) =>
		a.key - b.key || ((a.key & 3) === before ? b.rank - a.rank : a.rank - b.rank) || a.call - b.call;
	const add = (rank, at, side, code) => {
		const edit = { key: at * 4 + side, rank, call: calls++, code };
		let low = 0;
		let high = edits.length;
		while (low < high) {
			const mid = (low + high) >>> 1;
			if (precedes(edits[mid], edit) < 0) {
				low = mid + 1;
			}
			else {
				high = mid;
			}
		}
		edits.splice(low, 0, edit);
	};
	const writer = rank => ({
		insertBefore(offset, code) {
			add(rank, offset, offset === source.content.length ? after : before, code);
		},
		insertAfter(offset, code) {
			add(rank, offset ? offset - 1 : -1, offset ? after : before, code);
		},
		replace(start, end, code) {
			add(rank, start, slot, code);
			let low = 0;
			let high = removals.length;
			while (low < high) {
				const mid = (low + high) >>> 1;
				if (removals[mid][0] <= start) {
					low = mid + 1;
				}
				else {
					high = mid;
				}
			}
			removals.splice(low, 0, [start, end]);
		},
	});
	return {
		...writer(coreRank),
		writer,
		render(start, end, sink) {
			const { length } = source.content;
			if (start !== 0 || end !== length) {
				throw new Error('The baseline renders only the whole text.');
			}
			const merged = [];
			for (const [from, to] of removals) {
				const last = merged[merged.length - 1];
				if (last && from <= last[1]) {
					last[1] = Math.max(last[1], to);
				}
				else {
					merged.push([from, to]);
				}
			}
			let pos = 0;
			let removal = 0;
			const keep = to => {
				while (pos < to) {
					while (removal < merged.length && merged[removal][1] <= pos) {
						removal++;
					}
					if (removal < merged.length && merged[removal][0] <= pos) {
						pos = Math.min(merged[removal][1], to);
						continue;
					}
					const runEnd = removal < merged.length && merged[removal][0] < to ? merged[removal][0] : to;
					sink({ source, start: pos, end: runEnd });
					pos = runEnd;
				}
			};
			for (const { key, code } of edits) {
				const at = (key >> 2) + ((key & 3) === after ? 1 : 0);
				keep(at < length ? at : length);
				if (typeof code !== 'string' || code) {
					sink(code);
				}
			}
			keep(length);
		},
	};
}
