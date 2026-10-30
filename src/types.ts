/** Generated code: plain text, or text that maps to `sourceOffset` of `source`. */
export type Segment<Source, Data> = string | [text: string, source: Source, sourceOffset: number, data: Data];

/** A segment of generated code that maps to a source. */
export type MappedSegment<Source, Data> = Exclude<Segment<Source, Data>, string>;
