/**
 * Generated text: new text, which maps nowhere, or the range `start`..`end` of a source text. A range without `text`
 * is a copy of the text there; `text` is generated text that stands for the range, mapped as its consumer decides. An empty
 * range is an anchor. `Origin` is what a range carries beyond its offsets: nothing for a producer of one source and no
 * data, whose consumer knows the source; `{ source, name, data }` for a rewrite, whose code can mix sources and whose
 * ranges read their text from `source.content`.
 *
 * The fields at the top of a range are the ones that the package reads: `start`, `end`, `text`, `source` and `name`.
 * What a consumer adds goes under one field of its own, as `data` in a rewrite, so that no field of the package, now or
 * later, has the name of one of the consumer.
 */
export type Piece<Origin = unknown> = string | (Origin & {
	start: number;
	end: number;
	text?: string;
});

/** A source text, by the identity that the ranges of pieces carry: a range without `text` copies its `content`. */
export interface Source {
	readonly content: string;
}
