const NO_DATA_SYMBOL: unique symbol = Symbol();

export type Segment<T = typeof NO_DATA_SYMBOL> = T extends typeof NO_DATA_SYMBOL ? SegmentWithoutData : SegmentWithData<T>;
export type SegmentWithoutData = WithString<_SegmentWithoutData>;
export type SegmentWithData<T = any> = WithString<_SegmentWithData<T>>;

type WithString<T> = T | string;

type _SegmentWithoutData = [
	string, // text
	string | undefined, // source
	number | [number, number], // source offset
];

type _SegmentWithData<T = any> = [
	string, // text
	string | undefined, // source
	number | [number, number], // source offset
	T, // data
];

export function getLength(segments: Segment<any>[]) {
	let length = 0;
	for (const segment of segments) {
		length += typeof segment == 'string' ? segment.length : segment[0].length;
	}
	return length;
}

export function toString<T extends Segment<any>>(segments: T[]) {
	return segments.map(s => typeof s === 'string' ? s : s[0]).join('');
}

export function replace<T extends Segment<any>>(segments: T[], pattern: string | RegExp, replacer: string | ((match: string) => T)) {
	const str = toString(segments);
	const match = str.match(pattern);
	if (match && match.index !== undefined) {
		const startOffset = match.index;
		const endOffset = startOffset + match[0].length;
		update(segments, startOffset, endOffset, typeof replacer === 'string' ? replacer : replacer(match[0]));
	}
}

export function update<T extends Segment<any>>(segments: T[], startOffset: number, endOffset: number, newSegment: T) {
	const offsets = toOffsets(segments);
	const startIndex = binarySearchStartIndex(offsets, startOffset);
	const endIndex = binarySearchEndIndex(offsets, endOffset);
	const startSegment = segments[startIndex];
	const endSegment = segments[endIndex];
	const startSegmentStart = offsets[startIndex];
	const endSegmentEnd = offsets[endIndex] + (typeof endSegment === 'string' ? endSegment.length : endSegment[0].length);
	const inserts: T[] = [];
	if (startOffset > startSegmentStart) {
		inserts.push(trimSegmentEnd(startSegment, startOffset - startSegmentStart));
	}
	inserts.push(newSegment);
	if (endOffset < endSegmentEnd) {
		inserts.push(trimSegmentStart(endSegment, endOffset - startSegmentStart));
	}
	combineStrings(inserts);
	segments.splice(startIndex, endIndex - startIndex + 1, ...inserts);
}

function combineStrings<T extends Segment<any>>(segments: T[]) {
	for (let i = segments.length - 1; i >= 1; i--) {
		if (typeof segments[i] === 'string' && typeof segments[i - 1] === 'string') {
			segments[i - 1] = (segments[i - 1] as string + segments[i] as string) as T;
			segments.splice(i, 1);
		}
	}
}

function trimSegmentEnd<T extends Segment<any>>(segment: T, trimEnd: number) {
	if (typeof segment === 'string') {
		return segment.slice(0, trimEnd) as T;
	}
	const originalString = segment[0];
	const originalRange = segment[2];
	const newString = originalString.slice(0, trimEnd);
	const newRange = typeof originalRange === 'number' ? originalRange : [originalRange[0], originalRange[1] - (originalString.length - newString.length)];
	return [
		newString,
		segment[1],
		newRange,
		...segment.slice(3),
	] as T;
}

function trimSegmentStart<T extends Segment<any>>(segment: T, trimStart: number) {
	if (typeof segment === 'string') {
		return segment.slice(trimStart) as T;
	}
	const originalString = segment[0];
	const originalRange = segment[2];
	const newString = originalString.slice(trimStart);
	const newRange = typeof originalRange === 'number' ? originalRange + trimStart : [originalRange[0] + trimStart, originalRange[1]];
	return [
		newString,
		segment[1],
		newRange,
		...segment.slice(3),
	] as T;
}

function toOffsets(segments: Segment<any>[]) {
	const offsets: number[] = [];
	let offset = 0;
	for (const segment of segments) {
		offsets.push(offset);
		offset += typeof segment == 'string' ? segment.length : segment[0].length;
	}
	return offsets;
}

function binarySearchStartIndex(offsets: number[], searchOffset: number) {
	let start = 0;
	let end = offsets.length - 1;
	while (start < end) {
		const mid = Math.floor((start + end) / 2);
		if (offsets[mid] < searchOffset) {
			start = mid + 1;
		} else {
			end = mid;
		}
	}
	return start;
}

function binarySearchEndIndex(offsets: number[], searchOffset: number) {
	let start = 0;
	let end = offsets.length - 1;
	while (start < end) {
		const mid = Math.floor((start + end) / 2);
		if (offsets[mid] <= searchOffset) {
			start = mid + 1;
		} else {
			end = mid;
		}
	}
	return start;
}
