// Vue cases: the calls of @vue/compiler-sfc on a rewrite, by the trace of sfc.mjs, then the render that it ends with,
// to text when `sourceMap` is false and by renderWithSourceMap otherwise.
import { renderText } from './inputs.mjs';
import {
	awaitShape,
	compileScriptTrace,
	hoistShape,
	makeSfc,
	referencesShape,
	templateCodegenPieces,
	typicalShape,
} from './sfc.mjs';

const filename = () => 'Generated.vue';
const mapOutput = ({ text, map }) => `${text}\n${map.mappings}`;

function compileCase({ name, description, sizes, smoke, unit, units, shape, map }) {
	return {
		name,
		description,
		sizes,
		smoke,
		unit,
		units,
		setup(M, size) {
			const { content, plan } = makeSfc(shape(size));
			const source = { content };
			const render = rewrite => sink => rewrite.render(0, content.length, sink);
			return {
				run: map
					? () => M.renderWithSourceMap(render(compileScriptTrace(M, source, plan)), filename)
					: () => renderText(M, render(compileScriptTrace(M, source, plan))),
			};
		},
		output: map ? mapOutput : undefined,
	};
}

const file = { unit: 'file', units: () => 1 };

export const vue = [
	compileCase({
		name: 'vue/sfc:text',
		description:
			'compileScript of a typical component, scaled: hoisted imports, macros, props destructure, models, awaits, inline template, to text',
		sizes: [1, 100],
		smoke: 1,
		...file,
		shape: typicalShape,
	}),
	compileCase({
		name: 'vue/sfc:map',
		description: 'vue/sfc:text with a source map, the path of compiler-sfc by default',
		sizes: [1, 100, 1000],
		smoke: 1,
		...file,
		shape: typicalShape,
		map: true,
	}),
	compileCase({
		name: 'vue/props-references:map',
		description: 'many destructured props references, each a small mapped replace, with a source map',
		sizes: [1000, 100_000],
		smoke: 20,
		unit: 'reference',
		shape: referencesShape,
		map: true,
	}),
	compileCase({
		name: 'vue/hoist:map',
		description:
			'many imports and type declarations, each hoisted by insertBefore(0, cut), a fifth with removed specifiers, with a source map',
		sizes: [1000, 10_000],
		smoke: 20,
		unit: 'cut',
		shape: hoistShape,
		map: true,
	}),
	compileCase({
		name: 'vue/awaits:text',
		description:
			'many top-level awaits, half nested, each a replace and a ranked insertAfter, closes stacked at one end, to text',
		sizes: [1000, 10_000],
		smoke: 10,
		unit: 'await',
		shape: awaitShape,
	}),
	{
		name: 'vue/template:map',
		description:
			'renderWithSourceMap of the pieces of template code, without a rewrite, as compileTemplate maps them',
		sizes: [1000, 10_000],
		smoke: 10,
		unit: 'node',
		setup(M, size) {
			const { content, plan } = makeSfc({ ...referencesShape(0), templateNodes: size });
			const pieces = templateCodegenPieces({ content }, plan);
			return { run: () => M.renderWithSourceMap(sink => pieces.forEach(piece => sink(piece)), filename) };
		},
		output: mapOutput,
	},
];
