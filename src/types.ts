/**
 * Generated code: new text, which maps nowhere, or the range `start`..`end` of the text of `source`. A range without
 * `text` is a copy of the text there; `text` is code that stands for the range, mapped as its consumer decides. An
 * empty range is an anchor.
 */
export type Piece<Source, Data> = string | {
	source: Source;
	start: number;
	end: number;
	data: Data;
	text?: string;
};
