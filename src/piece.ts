// The check of a range that the text render and the map renders share, so that they take the same ranges.

export function isRange(start: number, end: number, length: number) {
	return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start <= end && end <= length;
}
