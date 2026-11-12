/**
 * Generated text: new text, which maps nowhere, or the range `start`..`end` of a source text. A range without `text`
 * is a copy of the text there; `text` is generated text that stands for the range, mapped as its consumer decides. An
 * empty range is an anchor.
 *
 * A range has the fields below and no other. `source`, of type `S`, is the source text of the range: a producer of one
 * source, whose consumer knows it, gives none. `name` is the original name of the symbol that a range with `text`
 * renames. `data`, of type `Data`, is the value of whoever makes the range, which the package never reads: all that a
 * consumer carries on a range goes there. A field that the producer has no value for is absent; `source` and `data` are
 * required where their type does not include undefined.
 */
export type Piece<S extends Source | undefined = undefined, Data = undefined> =
	| string
	| (
		& { start: number; end: number; text?: string; name?: string }
		& (undefined extends S ? { source?: S } : { source: S })
		& (undefined extends Data ? { data?: Data } : { data: Data })
	);

/** A source text, by the identity that the ranges of pieces carry: a range without `text` copies its `content`. */
export interface Source {
	readonly content: string;
}
