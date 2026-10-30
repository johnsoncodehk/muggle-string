/**
 * Generated code: new text, which maps nowhere, or the range `start`..`end` of the text of `source`. A range without
 * `text` is a copy of the text there; `text` is code that maps to the range as a whole. An empty range is an anchor.
 */
export type Piece<Source, Data> = string | {
	source: Source;
	start: number;
	end: number;
	data: Data;
	text?: string;
};
