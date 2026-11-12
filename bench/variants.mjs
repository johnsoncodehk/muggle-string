// Each variant is the source with one technique taken out, as exact replacements in a copy of `src`. A replacement
// whose text is not found exactly once stops the build, so a variant never silently drifts from the source.

export const variants = [
	{
		name: 'spliced-edits',
		technique: 'append-only edits and removals, sorted once at the first render',
		without: 'each edit and removal spliced into its sorted place when it is made',
		targets: ['random 100000', 'random-map 100000'],
		replacements: [
			{
				file: 'sourceRewrite.ts',
				find: `		const key = at * 4 + side;
		if (size && key < keys[size - 1]!) {
			this.sorted = false;
		}
		if (size === keys.length) {
			keys = new Int32Array(size * 2);
			keys.set(this.keys);
			this.keys = keys;
		}
		keys[size] = key;
		this.code.push(code);`,
				replace: `		const key = at * 4 + side;
		if (size === keys.length) {
			keys = new Int32Array(size * 2);
			keys.set(this.keys);
			this.keys = keys;
		}
		let low = 0;
		let high = size;
		while (low < high) {
			const mid = (low + high) >>> 1;
			if (keys[mid]! <= key) {
				low = mid + 1;
			}
			else {
				high = mid;
			}
		}
		keys.copyWithin(low + 1, low, size);
		keys[low] = key;
		this.code.splice(low, 0, code);`,
			},
			{
				file: 'sourceRewrite.ts',
				find: `		const size = this.removalsSize;
		if (size && start < this.removals[size - 2]!) {
			this.removalsSorted = false;
		}
		if (size === this.removals.length) {
			const removals = new Int32Array(size * 2);
			removals.set(this.removals);
			this.removals = removals;
		}
		this.removals[size] = start;
		this.removals[size + 1] = end;`,
				replace: `		const size = this.removalsSize;
		if (size === this.removals.length) {
			const removals = new Int32Array(size * 2);
			removals.set(this.removals);
			this.removals = removals;
		}
		let low = 0;
		let high = size >> 1;
		while (low < high) {
			const mid = (low + high) >>> 1;
			if (this.removals[2 * mid]! <= start) {
				low = mid + 1;
			}
			else {
				high = mid;
			}
		}
		this.removals.copyWithin(2 * low + 2, 2 * low, size);
		this.removals[2 * low] = start;
		this.removals[2 * low + 1] = end;`,
			},
		],
	},
	{
		name: 'always-sort',
		technique: 'no sort when the edits and removals arrive in order',
		without: 'the edits and removals sorted at the first render even when in order',
		targets: ['ordered 100000', 'ordered-map 100000'],
		replacements: [
			{
				file: 'sourceRewrite.ts',
				find: `		if (this.sorted) {
			return;
		}
`,
				replace: '',
			},
			{
				file: 'sourceRewrite.ts',
				find: `		if (!this.removalsSorted) {`,
				replace: `		{`,
			},
		],
	},
	{
		name: 'cut-search',
		technique: 'a cut that comes after all cuts of its level is appended',
		without: 'every cut placed by a binary search of its level',
		targets: ['cuts 10000'],
		replacements: [
			{
				file: 'sourceRewrite.ts',
				find: `			if (low && siblings[low - 1]!.end > start) {`,
				replace: `			if (low) {`,
			},
		],
	},
	{
		name: 'plain-arrays',
		technique: 'keys and removals in Int32Array, grown by doubling',
		without: 'keys and removals in plain arrays of numbers',
		targets: ['random 100000', 'ordered 100000'],
		replacements: [
			{
				file: 'sourceRewrite.ts',
				find: `	keys = new Int32Array(16);`,
				replace: `	keys: number[] = [];`,
			},
			{
				file: 'sourceRewrite.ts',
				find: `		let keys = this.keys;
		const size = this.code.length;
		const key = at * 4 + side;
		if (size && key < keys[size - 1]!) {
			this.sorted = false;
		}
		if (size === keys.length) {
			keys = new Int32Array(size * 2);
			keys.set(this.keys);
			this.keys = keys;
		}
		keys[size] = key;
		this.code.push(code);`,
				replace: `		const keys = this.keys;
		const size = this.code.length;
		const key = at * 4 + side;
		if (size && key < keys[size - 1]!) {
			this.sorted = false;
		}
		keys.push(key);
		this.code.push(code);`,
			},
			{
				file: 'sourceRewrite.ts',
				find: `		const sortedKeys = new Int32Array(size);`,
				replace: `		const sortedKeys: number[] = [];`,
			},
			{
				file: 'sourceRewrite.ts',
				find: `	removals = new Int32Array(16);`,
				replace: `	removals: number[] = [];`,
			},
			{
				file: 'sourceRewrite.ts',
				find: `	keys: Int32Array = new Int32Array(0);`,
				replace: `	keys: ArrayLike<number> = [];`,
			},
			{
				file: 'sourceRewrite.ts',
				find: `		if (size === this.removals.length) {
			const removals = new Int32Array(size * 2);
			removals.set(this.removals);
			this.removals = removals;
		}
		this.removals[size] = start;
		this.removals[size + 1] = end;`,
				replace: `		this.removals.push(start, end);`,
			},
			{
				file: 'sourceRewrite.ts',
				find: `			const copy = new Int32Array(2 * pairs);`,
				replace: `			const copy: number[] = [];`,
			},
			{
				file: 'sourceRewrite.ts',
				find: `): [Int32Array, RewriteCode<S, Data>[], Int32Array[]?] {`,
				replace: `): [ArrayLike<number>, RewriteCode<S, Data>[], Int32Array[]?] {`,
			},
			{
				file: 'sourceRewrite.ts',
				find: `function sortOrder(values: Int32Array, size: number, stride: number, bias: number) {`,
				replace: `function sortOrder(values: ArrayLike<number>, size: number, stride: number, bias: number) {`,
			},
			{
				file: 'sourceRewrite.ts',
				find: `[writers[0]!.keys, writers[0]!.code] : [new Int32Array(0), []];`,
				replace: `[writers[0]!.keys, writers[0]!.code] : [[], []];`,
			},
			{
				file: 'sourceRewrite.ts',
				find: `	const keys = new Int32Array(total);`,
				replace: `	const keys: number[] = [];`,
			},
		],
	},
	{
		name: 'merge-by-sort',
		technique: 'the writers merged in one pass, a run of one writer at a time',
		without: 'the edits of all writers concatenated and sorted by key and rank',
		targets: ['random 100000', 'ordered 100000'],
		replacements: [
			{
				file: 'sourceRewrite.ts',
				find: /^function mergeEdits<S extends Source, Data>\([\s\S]*?^}\n/m,
				replace: `function mergeEdits<S extends Source, Data>(
	writers: Edits<S, Data>[],
): [Int32Array, RewriteCode<S, Data>[], Int32Array[]?] {
	const order: [number, number][] = [];
	for (let writer = 0; writer < writers.length; writer++) {
		for (let index = 0; index < writers[writer]!.code.length; index++) {
			order.push([writer, index]);
		}
	}
	order.sort(([writerA, indexA], [writerB, indexB]) => {
		const a = writers[writerA]!.keys[indexA]!;
		const b = writers[writerB]!.keys[indexB]!;
		if (a !== b) {
			return a - b;
		}
		if (writerA === writerB) {
			return indexA - indexB;
		}
		const rankA = writers[writerA]!.rank;
		const rankB = writers[writerB]!.rank;
		return (a & 3) === Side.Before ? rankB - rankA : rankA - rankB;
	});
	const keys = new Int32Array(order.length);
	const merged: RewriteCode<S, Data>[] = [];
	const positions = writers.map(edits => new Int32Array(edits.code.length));
	for (let at = 0; at < order.length; at++) {
		const [writer, index] = order[at]!;
		keys[at] = writers[writer]!.keys[index]!;
		merged.push(writers[writer]!.code[index]!);
		positions[writer]![index] = at;
	}
	return [keys, merged, positions];
}
`,
			},
		],
	},
	{
		name: 'view-scan',
		technique: 'a view finds its first cut, edit and removal by binary search',
		without: 'a view scans from the first cut, edit and removal',
		targets: ['views 100000'],
		replacements: [
			{
				file: 'sourceRewrite.ts',
				find: /^\t\tlet index = 0;\n\t\tlet high = roots\.length;[\s\S]*?(?=^\t\tthis\.rendering\+\+;)/m,
				replace: `		let index = 0;
		while (index < roots.length && roots[index]!.end <= start) {
			index++;
		}
		let pos = start;
		// a view skips the cut that it starts inside
		const first = roots[index];
		if (first && first.start < start) {
			pos = first.end < end ? first.end : end;
			index++;
		}
		let edit = 0;
		while (edit < this.code.length && keys[edit]! < pos * 4) {
			edit++;
		}
		let removal = 0;
		while (removal < this.removalsSize >> 1 && removals[2 * removal + 1]! <= pos) {
			removal++;
		}
`,
			},
		],
	},
	{
		name: 'copied-text',
		technique: 'kept text rendered as ranges of the source',
		without: 'kept text copied into each piece at render, and read from there',
		targets: ['spans 100000'],
		replacements: [
			{
				file: 'sourceRewrite.ts',
				find: `					sink(
						data
							? { ...data, source, start: pos, end: runEnd }
							: { source, start: pos, end: runEnd } as Piece<RewriteOrigin<S, Data>>,
					);`,
				replace: `					const copy = source.content.slice(pos, runEnd);
					sink(
						data
							? { ...data, source, start: pos, end: runEnd, copy }
							: { source, start: pos, end: runEnd, copy } as object as Piece<RewriteOrigin<S, Data>>,
					);`,
			},
			{
				file: 'sourceRewrite.ts',
				find: `	const { text } = piece;
	if (text != null) {
		return text;
	}`,
				replace: `	const { text } = piece;
	if (text != null) {
		return text;
	}
	const { copy } = piece as { copy?: string };
	if (copy !== undefined) {
		return copy;
	}`,
			},
			{
				file: 'sourceMap.ts',
				find: `			text += content.slice(piece.start, piece.end);`,
				replace: `			text += (piece as { copy?: string }).copy ?? content.slice(piece.start, piece.end);`,
			},
		],
	},
	{
		name: 'string-mappings',
		technique: 'the mappings written as bytes into a reused buffer, decoded by chunk',
		without: 'the mappings appended to a string char by char',
		targets: ['ordered-map 100000', 'random-map 100000'],
		replacements: [
			{
				file: 'sourceMap.ts',
				find: `	const utf8 = decoder ??= createDecoder('renderWithSourceMap');
	return renderWith(render, sourceName, new ByteWriter(utf8));`,
				replace: `	decoder ??= createDecoder('renderWithSourceMap');
	return renderWith(render, sourceName, new ByteWriter());`,
			},
			{
				file: 'sourceMap.ts',
				find: `	const writer = new ByteWriter(decoder ??= createDecoder('encodeMappings'));`,
				replace: `	decoder ??= createDecoder('encodeMappings');
	const writer = new ByteWriter();`,
			},
			{
				file: 'sourceMap.ts',
				find: `	digits = base64Codes ??= Uint8Array.from(base64, char => char.charCodeAt(0));
	chunks: string[] = [];
	buffer = new Uint8Array(chunkSize);
	length = 0;`,
				replace: `	mappings = '';`,
			},
			{
				file: 'sourceMap.ts',
				find: `	constructor(readonly utf8: { decode(input: Uint8Array): string }) {}
`,
				replace: '',
			},
			{
				file: 'sourceMap.ts',
				find: /^\treserve\(\) \{[\s\S]*?^\t\}\n/m,
				replace: `	reserve() {}
`,
			},
			{
				file: 'sourceMap.ts',
				find: `		const { buffer, digits } = this;
		let length = this.length;
		if (this.lineHasSegment) {
			buffer[length++] = comma;
		}
		this.length = writeVlq(buffer, length, digits, column - this.lastColumn);`,
				replace: `		if (this.lineHasSegment) {
			this.mappings += ',';
		}
		this.mappings = writeVlq(this.mappings, column - this.lastColumn);`,
			},
			{
				file: 'sourceMap.ts',
				find: `		const { buffer, digits } = this;
		let length = this.length;
		if (this.lineHasSegment) {
			buffer[length++] = comma;
		}
		length = writeVlq(buffer, length, digits, column - this.lastColumn);
		length = writeVlq(buffer, length, digits, source - this.lastSource);
		length = writeVlq(buffer, length, digits, line - this.lastLine);
		length = writeVlq(buffer, length, digits, sourceColumn - this.lastSourceColumn);
		if (name !== -1) {
			length = writeVlq(buffer, length, digits, name - this.lastName);
			this.lastName = name;
		}
		this.length = length;`,
				replace: `		let { mappings } = this;
		if (this.lineHasSegment) {
			mappings += ',';
		}
		mappings = writeVlq(mappings, column - this.lastColumn);
		mappings = writeVlq(mappings, source - this.lastSource);
		mappings = writeVlq(mappings, line - this.lastLine);
		mappings = writeVlq(mappings, sourceColumn - this.lastSourceColumn);
		if (name !== -1) {
			mappings = writeVlq(mappings, name - this.lastName);
			this.lastName = name;
		}
		this.mappings = mappings;`,
			},
			{
				file: 'sourceMap.ts',
				find: `function writeVlq(buffer: Uint8Array, length: number, digits: Uint8Array, value: number) {`,
				replace: `function writeVlq(mappings: string, value: number) {`,
			},
			{
				file: 'sourceMap.ts',
				find: `		buffer[length++] = digits[digit]!;
	}
	while (rest);
	return length;`,
				replace: `		mappings += base64[digit]!;
	}
	while (rest);
	return mappings;`,
			},
			{
				file: 'sourceMap.ts',
				find: `		this.buffer[this.length++] = semicolon;`,
				replace: `		this.mappings += ';';`,
			},
			{
				file: 'sourceMap.ts',
				find: `		this.chunks.push(this.utf8.decode(this.buffer.subarray(0, this.length)));
		return this.chunks.join('');`,
				replace: `		return this.mappings;`,
			},
		],
	},
	{
		name: 'regex-classes',
		technique: 'ASCII chars classed by their code, without a regular expression',
		without: 'every char classed by the regular expressions',
		targets: ['ordered-map 100000', 'random-map 100000'],
		replacements: [
			{
				file: 'sourceMap.ts',
				find: `				const kind = code < 128 ? classes[code]! : unicodeClassOf(content, offset);`,
				replace: `				const kind = unicodeClassOf(content, offset);`,
			},
		],
	},
];
