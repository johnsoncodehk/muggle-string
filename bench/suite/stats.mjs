// Order statistics, which a GC pause or a deopt in a few samples does not move, unlike a mean.

export function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = sorted.length >> 1;
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** The median absolute deviation from the median, relative to the median: the spread of typical samples. */
export function relativeMad(values) {
	const middle = median(values);
	return middle ? median(values.map(value => Math.abs(value - middle))) / middle : 0;
}

export function summarize(values) {
	return {
		median: median(values),
		mad: relativeMad(values),
		min: Math.min(...values),
		max: Math.max(...values),
		count: values.length,
	};
}

/**
 * The change from `base` to `head`, by rounds that ran the two one after the other, so that a machine that slows
 * down for a round slows both: the median of the ratios of the rounds, and whether it is a change, when at least 80%
 * of the rounds agree on its direction and it is at least `threshold` from 1, and at least twice `noise`, the spread
 * of the samples. With fewer than 3 rounds, a ratio is never a change, as one round cannot tell noise from it.
 */
export function pairedRatio(base, head, threshold = 0.03, noise = 0) {
	const ratios = [];
	for (const [round, value] of head) {
		const paired = base.get(round);
		if (paired !== undefined && paired > 0) {
			ratios.push(value / paired);
		}
	}
	if (!ratios.length) {
		return undefined;
	}
	const ratio = median(ratios);
	const higher = ratios.filter(value => value > 1).length;
	const agree = Math.max(higher, ratios.length - higher) >= Math.ceil(ratios.length * 0.8);
	const floor = Math.max(threshold, 2 * noise);
	return { ratio, rounds: ratios.length, floor, change: ratios.length >= 3 && agree && Math.abs(ratio - 1) >= floor };
}
