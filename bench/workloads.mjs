// The inputs of the benchmark, from fixed seeds, and how each kind of implementation runs them.

function random(seed) {
	return () => (seed = (seed * 48271) % 2147483647) / 2147483647;
}

const asciiWords = ['const', 'value', '=', 'call', '(', ')', ';', '\n', '  ', 'return', '{', '}'];
const otherWords = ['名前', '値', '=', '関数', '(', ')', ';', '\n', '  ', '戻る', '{', '}', 'é'];

/** About 1 MB of code-like text. */
function makeContent(words) {
	const next = random(1);
	let content = '';
	while (content.length < 1_000_000) {
		content += words[Math.floor(next() * words.length)] + (next() < 0.5 ? ' ' : '');
	}
	return content;
}

/**
 * `count` edits at distinct offsets 5 chars apart: 40% insertBefore, 40% insertAfter, 20% replace of 1 to 4 chars. In random order, or in source order, as a code generator makes them.
 */
function makeEdits(content, count, sorted) {
	const next = random(7);
	const slots = Math.floor((content.length - 400) / 5);
	const used = new Set();
	const edits = [];
	for (let index = 0; index < count; index++) {
		let slot;
		do {
			slot = Math.floor(next() * slots);
		}
		while (used.has(slot));
		used.add(slot);
		const at = slot * 5 + 1;
		const kind = next();
		// unused, so the edits stay those of earlier results
		next();
		edits.push(kind < 0.4 ? [0, at, at] : kind < 0.8 ? [1, at, at] : [2, at, at + 1 + Math.floor(next() * 4)]);
	}
	if (sorted) {
		edits.sort((a, b) => a[1] - b[1]);
	}
	return edits;
}

function applyEdits(M, source, edits) {
	const rewrite = M.createSourceRewrite(source);
	for (const [kind, start, end] of edits) {
		if (kind === 0) {
			rewrite.insertBefore(start, 'a');
		}
		else if (kind === 1) {
			rewrite.insertAfter(start, 'b');
		}
		else {
			rewrite.replace(start, end, { source, start, end, text: 'x' });
		}
	}
	return rewrite;
}

function renderText(M, rewrite, length) {
	const parts = [];
	rewrite.render(0, length, piece => parts.push(M.rewritePieceText(piece)));
	return parts.join('');
}

function renderMap(M, rewrite, length, flat) {
	const { text, map } = M.renderWithSourceMap(sink => rewrite.render(0, length, sink), source => source.name);
	return `${flat(text)}\n${flat(map.mappings)}\n${map.names.join()}`;
}

/** The 0.4 segment array: an insert or replace finds its segment by a scan from the start, and splits it. */
function segments04(M, content, edits) {
	const segments = [[content, undefined, 0]];
	for (const [kind, start, end] of edits) {
		M.replaceSourceRange(segments, undefined, start, end, kind === 0 ? 'a' : kind === 1 ? 'b' : 'x');
	}
	return M.toString(segments);
}

/**
 * Each workload: `kinds` are the implementations that can run it, and `prepare` gives the run of one iteration, from
 * the inputs to the output, which is hashed.
 */
export const workloads = {
	'random': {
		description: 'edits in random order, rendered to text',
		kinds: ['rewrite', 'spliced', 'segments-0.4'],
		prepare(size) {
			const content = makeContent(asciiWords);
			const source = { name: 'main.js', content };
			const edits = makeEdits(content, size, false);
			return {
				rewrite: M => renderText(M, applyEdits(M, source, edits), content.length),
				'segments-0.4': M => segments04(M, content, edits),
			};
		},
	},
	'ordered': {
		description: 'edits in source order, rendered to text',
		kinds: ['rewrite', 'spliced', 'segments-0.4'],
		prepare(size) {
			const content = makeContent(asciiWords);
			const source = { name: 'main.js', content };
			const edits = makeEdits(content, size, true);
			return {
				rewrite: M => renderText(M, applyEdits(M, source, edits), content.length),
				'segments-0.4': M => segments04(M, content, edits),
			};
		},
	},
	'random-map': {
		description: 'edits in random order, rendered with a source map',
		kinds: ['rewrite', 'spliced'],
		prepare(size, flat) {
			const content = makeContent(asciiWords);
			const source = { name: 'main.js', content };
			const edits = makeEdits(content, size, false);
			return { rewrite: M => renderMap(M, applyEdits(M, source, edits), content.length, flat) };
		},
	},
	'ordered-map': {
		description: 'edits in source order, rendered with a source map',
		kinds: ['rewrite', 'spliced'],
		prepare(size, flat) {
			const content = makeContent(asciiWords);
			const source = { name: 'main.js', content };
			const edits = makeEdits(content, size, true);
			return { rewrite: M => renderMap(M, applyEdits(M, source, edits), content.length, flat) };
		},
	},
	'non-ascii-map': {
		description: 'edits in source order on mostly non-ASCII text, rendered with a source map',
		kinds: ['rewrite'],
		prepare(size, flat) {
			const content = makeContent(otherWords);
			const source = { name: 'main.js', content };
			const edits = makeEdits(content, size, true);
			return { rewrite: M => renderMap(M, applyEdits(M, source, edits), content.length, flat) };
		},
	},
	'views': {
		description: 'edits in source order, rendered as 5,000 views of 200 chars',
		kinds: ['rewrite'],
		prepare(size) {
			const content = makeContent(asciiWords);
			const source = { name: 'main.js', content };
			const edits = makeEdits(content, size, true);
			const next = random(3);
			const starts = Array.from({ length: 5000 }, () => Math.floor(next() * (content.length - 200)));
			return {
				rewrite: M => {
					const rewrite = applyEdits(M, source, edits);
					const parts = [];
					for (const start of starts) {
						rewrite.render(start, start + 200, piece => parts.push(M.rewritePieceText(piece)));
						parts.push('\n');
					}
					return parts.join('');
				},
			};
		},
	},
	'spans': {
		description: 'edits in source order, rendered to spans by length, without text',
		kinds: ['rewrite'],
		prepare(size) {
			const content = makeContent(asciiWords);
			const source = { name: 'main.js', content };
			const edits = makeEdits(content, size, true);
			return {
				rewrite: M => {
					const rewrite = applyEdits(M, source, edits);
					const spans = [];
					let generated = 0;
					rewrite.render(0, content.length, piece => {
						if (typeof piece === 'string') {
							generated += piece.length;
							return;
						}
						const length = piece.text === undefined ? piece.end - piece.start : piece.text.length;
						spans.push(generated, length, piece.start, piece.end);
						generated += length;
					});
					return spans.join();
				},
			};
		},
	},
	'cuts': {
		description: 'cuts made in source order and placed at the end in reverse',
		kinds: ['rewrite'],
		prepare(size) {
			const content = makeContent(asciiWords);
			const source = { name: 'main.js', content };
			const block = Math.floor(content.length / size);
			return {
				rewrite: M => {
					const rewrite = M.createSourceRewrite(source);
					const slices = [];
					for (let index = 0; index < size; index++) {
						slices.push(rewrite.cut(index * block, index * block + (block >> 1)));
					}
					for (let index = size - 1; index >= 0; index--) {
						rewrite.insertBefore(content.length, slices[index]);
					}
					return renderText(M, rewrite, content.length);
				},
			};
		},
	},
};
