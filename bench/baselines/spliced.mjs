// The obvious first version of the rewrite: one array of edits, kept sorted by splicing each edit into its place,
// and a sorted array of removals. It has the inserts, wraps and replaces of the rewrite, but no cuts or views.

const Point = 0;
const Before = 1;
const Slot = 2;
const After = 3;

export function createSourceRewrite(source) {
	const edits = [];
	const removals = [];
	let calls = 0;
	// at one side of one char: by nest, then call order, reversed for befores
	const precedes = (a, b) =>
		a.key - b.key || a.nest - b.nest
		|| ((a.key & 3) === Before || ((a.key & 3) === Slot && a.nest === 0) ? b.call - a.call : a.call - b.call);
	const add = (at, side, nest, code) => {
		const edit = { key: at * 4 + side, nest, call: calls++, code };
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
	return {
		insertBefore(offset, code) {
			add(offset, Point, 0, code);
		},
		insertAfter(offset, code) {
			add(offset - 1, After, 1, code);
		},
		wrap(start, end, before, after) {
			if (start === end) {
				if (before !== '') {
					add(start, Slot, 0, before);
				}
				if (after !== '') {
					add(start, Slot, 2, after);
				}
				return;
			}
			if (before !== '') {
				add(start, Before, -end, before);
			}
			if (after !== '') {
				add(end - 1, After, -start, after);
			}
		},
		replace(start, end, code) {
			add(start, Slot, 1, code);
			if (start === end) {
				return;
			}
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
				const at = (key >> 2) + ((key & 3) === After ? 1 : 0);
				keep(at < length ? at : length);
				if (typeof code !== 'string' || code) {
					sink(code);
				}
			}
			keep(length);
		},
	};
}
