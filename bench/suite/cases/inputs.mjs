// Deterministic inputs: every run of a case on every machine edits the same text at the same offsets, so numbers of
// one case stay comparable across runs, commits and machines of one kind.

/** A Lehmer generator in 0..1 from `seed`. */
export function random(seed) {
	return () => (seed = (seed * 48271) % 2147483647) / 2147483647;
}

const asciiWords = ['const', 'value', '=', 'call', '(', ')', ';', '\n', '  ', 'return', '{', '}', 'props', '.', 'a1'];
const otherWords = ['名前', '値', '=', '関数', '(', ')', ';', '\n', '  ', '戻る', '{', '}', 'é'];

const contents = new Map();

/** About `length` chars of code-like text, ASCII or mostly not. */
export function makeContent(length, ascii = true) {
	const key = `${length} ${ascii}`;
	let content = contents.get(key);
	if (content === undefined) {
		const words = ascii ? asciiWords : otherWords;
		const next = random(1);
		const parts = [];
		let size = 0;
		while (size < length) {
			const word = words[Math.floor(next() * words.length)] + (next() < 0.5 ? ' ' : '');
			parts.push(word);
			size += word.length;
		}
		content = parts.join('').slice(0, length);
		contents.set(key, content);
	}
	return content;
}

/** A source of about `length` chars. */
export function makeSource(length, ascii = true) {
	return { name: 'main.js', content: makeContent(length, ascii) };
}

/** `count` distinct offsets in 1..`length` - `gap`, `gap` apart, in source order or shuffled. */
export function distinctOffsets(count, length, gap, sorted, seed = 7) {
	const slots = Math.floor((length - gap) / gap);
	if (count > slots) {
		throw new Error(`${count} offsets ${gap} apart do not fit in ${length} chars.`);
	}
	const next = random(seed);
	const offsets = [];
	// every slot from an evenly spread pick, so ordered and shuffled runs edit the same offsets
	const step = slots / count;
	for (let index = 0; index < count; index++) {
		offsets.push(1 + Math.floor(index * step) * gap);
	}
	if (!sorted) {
		for (let index = offsets.length - 1; index > 0; index--) {
			const other = Math.floor(next() * (index + 1));
			[offsets[index], offsets[other]] = [offsets[other], offsets[index]];
		}
	}
	return offsets;
}

/** The text of the pieces of `render`, as a consumer that wants a string builds it. */
export function renderText(M, render) {
	let text = '';
	render(piece => text += M.rewritePieceText(piece));
	return text;
}

/** The text of `rewrite` from 0 to the end. */
export function rewriteText(M, rewrite) {
	return renderText(M, sink => rewrite.render(0, rewrite.source.content.length, sink));
}
