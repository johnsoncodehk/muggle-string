export type Segment<T = '--'> = T extends '--' ? SegmentWithoutData : SegmentWithData<T>;

export type SegmentWithoutData = [
	string, // text
	string | undefined, // source
	number | [number, number], // source offset
] | string;

export type SegmentWithData<T> = [
	string, // text
	string | undefined, // source
	number | [number, number], // source offset
	T, // data
] | string;

export function getLength(segments: Segment<any>[]) {
	let length = 0;
	for (const segment of segments) {
		length += typeof segment == 'string' ? segment.length : segment[0].length;
	}
	return length;
}

export function toString(segments: Segment<any>[]) {
	return segments.map(s => typeof s === 'string' ? s : s[0]).join('');
}
