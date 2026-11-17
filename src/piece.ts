// The check of a range that the text render, the map renders and the edits of a rewrite share, so that all of them take
// the same ranges.

export function isRange(start: number, end: number, length: number) {
	return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start <= end && end <= length;
}
