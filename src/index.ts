import { binarySearch } from "./binarySearch";
import { Segment } from "./types";

export * from './types';

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

export function replace<T extends Segment<any>>(segments: T[], pattern: string | RegExp, ...replacers: (T | ((match: string, matches: RegExpMatchArray) => T))[]) {
	const str = toString(segments);
	const match = str.match(pattern);
	if (match && match.index !== undefined) {
		const startOffset = match.index;
		const endOffset = startOffset + match[0].length;
		replaceRange(segments, startOffset, endOffset, ...replacers.map(replacer => typeof replacer === 'function' ? replacer(match[0], match) : replacer));
	}
}

export function replaceAll<T extends Segment<any>>(segments: T[], pattern: RegExp, ...replacers: (T | ((match: string) => T))[]) {
	const str = toString(segments);
	const allMatch = str.matchAll(pattern);
	let length = str.length;
	let lengthDiff = 0;
	for (const match of allMatch) {
		if (match.index !== undefined) {
			const startOffset = match.index + lengthDiff;
			const endOffset = startOffset + match[0].length;
			replaceRange(segments, startOffset, endOffset, ...replacers.map(replacer => typeof replacer === 'function' ? replacer(match[0]) : replacer));
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
			const segmentStart = segment[2];
			const segmentEnd = segment[2] + segment[0].length;
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
				return true;
			}
		}
	}
	return false;
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
	return [
		segment[0].slice(0, trimEnd),
		...segment.slice(1),
	] as T;
}

function trimSegmentStart<T extends Segment<any>>(segment: T, trimStart: number) {
	if (typeof segment === 'string') {
		return segment.slice(trimStart) as T;
	}
	if (trimStart < 0) {
		trimStart += segment[0].length;
	}
	return [
		segment[0].slice(trimStart),
		segment[1],
		segment[2] + trimStart,
		...segment.slice(3),
	] as T;
}

function toOffsets(segments: Segment<any>[]) {
	const offsets: number[] = new Array(segments.length);
	let offset = 0;
	for (let i = 0; i < segments.length; i++) {
		offsets[i] = offset;
		const segment = segments[i];
		offset += typeof segment == 'string' ? segment.length : segment[0].length;
	}
	return offsets;
}
