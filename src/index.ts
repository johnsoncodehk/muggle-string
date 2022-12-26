import { binarySearch } from "./binarySearch";

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

export function create(source: string): Segment[] {
	return [[source, undefined, 0]];
}

export function replace<T extends Segment<any>>(segments: T[], pattern: string | RegExp, ...replacers: (string | ((match: string) => T))[]) {
	const str = toString(segments);
	const match = str.match(pattern);
	if (match && match.index !== undefined) {
		const startOffset = match.index;
		const endOffset = startOffset + match[0].length;
		replaceRange(segments, startOffset, endOffset, ...replacers.map(replacer => typeof replacer === 'string' ? replacer : replacer(match[0])));
	}
}

export function replaceAll<T extends Segment<any>>(segments: T[], pattern: RegExp, ...replacers: (string | ((match: string) => T))[]) {
	const str = toString(segments);
	const allMatch = str.matchAll(pattern);
	let length = str.length;
	let lengthDiff = 0;
	for (const match of allMatch) {
		if (match.index !== undefined) {
			const startOffset = match.index + lengthDiff;
			const endOffset = startOffset + match[0].length;
			replaceRange(segments, startOffset, endOffset, ...replacers.map(replacer => typeof replacer === 'string' ? replacer : replacer(match[0])));
			const newLength = getLength(segments);
			lengthDiff += newLength - length;
			length = newLength;
		}
	}
}

export function replaceSourceRange<T extends Segment<any>>(segments: T[], source: string | undefined, startOffset: number, endOffset: number, ...newSegments: T[]) {
	for (const segment of segments) {
		if (typeof segment === 'string') {
			continue;
		}
		if (segment[1] === source) {
			const segmentStart = typeof segment[2] === 'number' ? segment[2] : segment[2][0];
			const segmentEnd = typeof segment[2] === 'number' ? segment[2] + segment[0].length : segment[2][1];
			if (segmentStart <= startOffset && segmentEnd >= endOffset) {
				const inserts: T[] = [];
				if (startOffset > segmentStart) {
					inserts.push(trimSegmentEnd(segment, startOffset - segmentStart));
				}
				for (const newSegment of newSegments) {
					inserts.push(newSegment);
				}
				if (endOffset < segmentEnd) {
					inserts.push(trimSegmentStart(segment, endOffset - segmentEnd));
				}
				combineStrings(inserts);
				segments.splice(segments.indexOf(segment), 1, ...inserts);
				return;
			}
		}
	}
	throw new Error(`Source range not found: ${source} ${startOffset} ${endOffset}`);
}

export function replaceRange<T extends Segment<any>>(segments: T[], startOffset: number, endOffset: number, ...newSegments: T[]) {
	const offsets = toOffsets(segments);
	const startIndex = binarySearch(offsets, startOffset);
	const endIndex = binarySearch(offsets, endOffset);
	const startSegment = segments[startIndex];
	const endSegment = segments[endIndex];
	const startSegmentStart = offsets[startIndex];
	const endSegmentStart = offsets[endIndex];
	const endSegmentEnd = offsets[endIndex] + (typeof endSegment === 'string' ? endSegment.length : endSegment[0].length);
	const inserts: T[] = [];
	if (startOffset > startSegmentStart) {
		inserts.push(trimSegmentEnd(startSegment, startOffset - startSegmentStart));
	}
	for (const newSegment of newSegments) {
		inserts.push(newSegment);
	}
	if (endOffset < endSegmentEnd) {
		inserts.push(trimSegmentStart(endSegment, endOffset - endSegmentStart));
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
	if (trimStart < 0) {
		trimStart += originalString.length;
	}
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
