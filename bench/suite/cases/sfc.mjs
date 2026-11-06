// A synthetic Vue single-file component and the calls that Vue's `compileScript` makes on a rewrite of it, in the order
// that it makes them, after the muggle-string port of @vue/compiler-sfc
// (https://github.com/vuejs/core/pull/16126, packages/compiler-sfc/src/compileScript.ts and script/*.ts). The component
// is generated with the offsets that its parse would give, so the trace makes only the calls on the rewrite and the
// pieces that Vue passes to them, without a parser or the rest of the compiler.

/** The counts of each construct in a component; `scale` multiplies a typical one. */
export function typicalShape(scale = 1) {
	return {
		imports: 6 * scale,
		macroImports: 2 * scale,
		types: 2 * scale,
		props: 8 * scale,
		models: 2 * scale,
		statements: 30 * scale,
		awaits: 2 * scale,
		templateNodes: 40 * scale,
		cssVars: true,
		options: true,
		expose: true,
		script: true,
	};
}

/** Only the props destructure and `count` references of the props, as Vue rewrites each to `__props.x`. */
export function referencesShape(count) {
	return { ...emptyShape(), props: 20, statements: Math.ceil(count / 2) };
}

/** Only imports and type declarations, each hoisted by a cut, a fifth of the imports with removed specifiers. */
export function hoistShape(count) {
	return { ...emptyShape(), imports: Math.ceil(count * 0.6), macroImports: Math.ceil(count * 0.2), types: Math.ceil(count * 0.2) };
}

/** Only top-level awaits, half of them nested. */
export function awaitShape(count) {
	return { ...emptyShape(), awaits: count };
}

function emptyShape() {
	return {
		imports: 0,
		macroImports: 0,
		types: 0,
		props: 0,
		models: 0,
		statements: 0,
		awaits: 0,
		templateNodes: 0,
		cssVars: false,
		options: false,
		expose: false,
		script: false,
	};
}

class Text {
	parts = [];
	length = 0;
	/** Appends `text` and returns its offset. */
	add(text) {
		const at = this.length;
		this.parts.push(text);
		this.length += text.length;
		return at;
	}
}

/**
 * The content of a component of `shape`, and what `compileScript` reads of its parse: offsets into the content, and
 * the generated strings that it writes, made here so that the trace times the rewrite and not string building.
 */
export function makeSfc(shape) {
	const text = new Text();
	const plan = {
		imports: [],
		body: [],
		references: [],
		propsDecl: [],
		helpers: new Set(['defineComponent']),
		awaits: 0,
	};
	text.add('<script setup lang="ts">');
	plan.startOffset = text.length;
	text.add('\n');
	const macroEvery = shape.macroImports ? Math.max(1, Math.floor((shape.imports + shape.macroImports) / shape.macroImports)) : 0;
	let macros = 0;
	let others = 0;
	for (let index = 0; index < shape.imports + shape.macroImports; index++) {
		const macro = macros < shape.macroImports && (others >= shape.imports || index % macroEvery === 0);
		if (macro) {
			macros++;
			// macros need no import, and `ref` is imported already: every specifier is removed, then the import
			const start = text.add('import { ');
			const specifiers = ['defineProps', 'defineEmits', 'ref'].map((name, at) => {
				const specifierStart = text.add(name);
				text.add(at < 2 ? ', ' : '');
				return { start: specifierStart, end: specifierStart + name.length };
			});
			text.add(" } from 'vue'");
			const end = text.length;
			text.add('\n');
			plan.imports.push({ start, end, hoistEnd: text.length, removed: specifiers });
		}
		else {
			others++;
			const start = text.add(`import { use${index}, helper${index} } from './module${index}'`);
			const end = text.length;
			text.add('\n');
			plan.imports.push({ start, end, hoistEnd: text.length, removed: [] });
		}
	}
	for (let index = 0; index < shape.types; index++) {
		const start = text.add(`interface Item${index} {\n  id: number\n  label?: string\n}`);
		text.add('\n');
		plan.body.push({ kind: 'type', start, end: text.length });
	}
	const props = [];
	if (shape.props) {
		const start = text.add('const { ');
		for (let index = 0; index < shape.props; index++) {
			props.push(`p${index}`);
			text.add(index % 3 === 1 ? `p${index} = ${index}` : `p${index}`);
			text.add(index < shape.props - 1 ? ', ' : '');
		}
		text.add(' } = defineProps<{ ');
		text.add(props.map(name => `${name}?: number`).join('; '));
		text.add(' }>()');
		plan.body.push({ kind: 'remove', start, end: text.length });
		text.add('\n');
		plan.propsDecl.push(`{ ${props.map(name => `${name}: { type: Number, required: false }`).join(', ')} }`);
		text.add('const emit = ');
		const init = text.add(`defineEmits(['change', 'update'])`);
		plan.body.push({ kind: 'replace', start: init, end: text.length, code: '__emit' });
		text.add('\n');
	}
	for (let index = 0; index < shape.models; index++) {
		// get is runtime-only, so it stays in the runtime options; the others move to the prop options
		text.add(`const m${index} = `);
		const callee = text.add('defineModel');
		const calleeEnd = text.length;
		text.add('(');
		const arg0 = text.add(`'m${index}'`);
		text.add(', ');
		const options = text.add('{ ');
		const type = text.add('type: String, ');
		const required = text.add('required: true, ');
		const get = text.add('get(value) { return value }, ');
		const fallback = text.add(`default: 'm${index}'`);
		text.add(' }');
		const optionsEnd = text.length;
		text.add(')\n');
		plan.body.push({
			kind: 'model',
			name: `m${index}`,
			callee,
			calleeEnd,
			arg0,
			removals: [[type, required], [required, get], [fallback, optionsEnd - 1]],
			kept: [[options, get], [fallback, optionsEnd]],
		});
		plan.helpers.add('useModel').add('mergeModels');
	}
	if (shape.options) {
		const start = text.add('defineOptions(');
		const argStart = text.add(`{ name: 'Generated', inheritAttrs: false }`);
		const argEnd = text.length;
		text.add(')');
		plan.body.push({ kind: 'remove', start, end: text.length });
		plan.optionsDecl = [argStart, argEnd];
		text.add('\n');
	}
	for (let index = 0; index < shape.statements; index++) {
		const a = props.length ? props[index % props.length] : undefined;
		const b = props.length ? props[(index * 7 + 3) % props.length] : undefined;
		if (index % 5 === 4 && a) {
			// a shorthand property: `{ a }` becomes `{ a: __props.a }`
			text.add(`watch(() => ({ `);
			const at = text.add(a);
			plan.references.push({ kind: 'shorthand', end: at + a.length, code: `: __props.${a}` });
			text.add(` }), (value) => emit('change', value))\n`);
			continue;
		}
		text.add(`const v${index} = computed(() => `);
		if (a) {
			const at = text.add(a);
			plan.references.push({ kind: 'replace', start: at, end: at + a.length, code: `__props.${a}` });
			text.add(' + ');
			const bt = text.add(b);
			plan.references.push({ kind: 'replace', start: bt, end: bt + b.length, code: `__props.${b}` });
			text.add(' * 2)\n');
		}
		else {
			text.add(`${index} * 2)\n`);
		}
	}
	for (let index = 0; index < shape.awaits; index++) {
		const statement = index % 2 === 1;
		if (statement) {
			// `await await f()` as a statement: both awaits end at one offset, the outer one left last
			const outer = text.add('await ');
			const inner = text.add('await ');
			const argument = text.add(`tick${index}()`);
			const end = text.length;
			plan.body.push({ kind: 'await', start: inner, argument, end, rank: 0, depth: 1, statement: false, nested: false });
			plan.body.push({ kind: 'await', start: outer, argument: inner, end, rank: 1, depth: 0, statement: true, nested: true });
		}
		else {
			text.add(`const r${index} = `);
			const outer = text.add('await ');
			const argument = text.add(`load${index}(`);
			const inner = text.add('await ');
			const innerArgument = text.add(`arg${index}()`);
			const innerEnd = text.length;
			text.add(')');
			plan.body.push({ kind: 'await', start: inner, argument: innerArgument, end: innerEnd, rank: 0, depth: 1, statement: false, nested: false });
			plan.body.push({ kind: 'await', start: outer, argument, end: text.length, rank: 1, depth: 0, statement: false, nested: true });
		}
		text.add('\n');
		plan.awaits++;
		plan.helpers.add('withAsyncContext');
	}
	if (shape.expose) {
		const callee = text.add('defineExpose');
		text.add(`({ emit })`);
		plan.body.push({ kind: 'replace', start: callee, end: callee + 'defineExpose'.length, code: '__expose' });
		text.add('\n');
	}
	plan.endOffset = text.length;
	text.add('</script>\n\n');
	if (shape.script) {
		text.add('<script lang="ts">');
		plan.scriptStartOffset = text.length;
		const exportStart = text.add('\nexport default ');
		const declaration = text.add('{\n  inheritAttrs: false,\n}');
		plan.defaultExport = [exportStart + 1, declaration];
		text.add('\n');
		plan.scriptEndOffset = text.length;
		text.add('</script>\n\n');
	}
	const template = [];
	if (shape.templateNodes) {
		text.add('<template>\n');
		for (let index = 0; index < shape.templateNodes; index++) {
			text.add('  <div :class="{ active: ');
			const prop = props.length ? props[index % props.length] : 'flag';
			const propAt = text.add(prop);
			text.add(' }">{{ ');
			const valueAt = text.add(`v${index}`);
			text.add(' }}</div>\n');
			template.push({ prop, propAt, valueAt, value: `v${index}` });
		}
		text.add('</template>\n\n');
		plan.helpers.add('normalizeClass').add('toDisplayString').add('openBlock').add('createElementBlock');
	}
	if (shape.cssVars) {
		text.add('<style scoped>\n.active { color: v-bind(color) }\n</style>\n');
		plan.helpers.add('useCssVars').add('unref');
	}
	plan.template = template;
	plan.length = text.length;
	const content = text.parts.join('');
	plan.awaitCode = plan.body.filter(node => node.kind === 'await').map(node => awaitCode(node));
	plan.helperImport = `import { ${[...plan.helpers].map(name => `${name} as _${name}`).join(', ')} } from 'vue'\n`;
	plan.preamble = template.length ? `import { createElementVNode as _createElementVNode } from "vue"\n` : '';
	return { content, plan };
}

function awaitCode({ depth, statement, nested }) {
	const outer = `\n${'  '.repeat(depth)}`;
	const inner = `${outer}  `;
	return {
		head: `(${inner}([__temp,__restore] = _withAsyncContext(${nested ? 'async ' : ''}() => `,
		tail: `)),${inner}${statement ? '' : '__temp = '}await __temp,${inner}__restore()${statement ? '' : `,${inner}__temp`}${outer})`,
	};
}

/** The template code inlined in `setup`, as pieces: kept ranges where the code is an expression of the component. */
function templatePieces(source, plan) {
	const pieces = ['() => {\n  return (_openBlock(), _createElementBlock("div", null, [\n'];
	for (const { prop, propAt, valueAt, value } of plan.template) {
		pieces.push('    _createElementVNode("div", { class: _normalizeClass({ active: ');
		pieces.push({ source, start: propAt, end: propAt + prop.length, text: `__props.${prop}` });
		pieces.push(' }) }, _toDisplayString(_unref(');
		pieces.push({ source, start: valueAt, end: valueAt + value.length });
		pieces.push(')), 3 /* TEXT, CLASS */),\n');
	}
	pieces.push('  ]))\n}');
	return pieces;
}

/**
 * The template code of `plan` as Vue's codegen pushes it for compileTemplate, which maps it by renderWithSourceMap
 * without a rewrite.
 */
export function templateCodegenPieces(source, plan) {
	return templatePieces(source, plan);
}

// ranks of @vue/compiler-sfc: the head ranks order the code before all text, the setup ranks the code at the tags of
// <script setup>
const HeadRank = { Preamble: 2, HelperImports: 3 };
const SetupRank = { Setup: 1, AsyncContext: 2, Return: 2, CssVars: 3 };

/** Makes the calls of `compileScript` for the component of `plan` on a new rewrite of `source`, and returns it. */
export function compileScriptTrace(M, source, plan) {
	const s = M.createSourceRewrite(source);
	const { startOffset, endOffset } = plan;
	const replace = (start, end, text) => s.replace(start, end, { source, start, end, text });
	const copy = (start, end) => ({ source, start, end });
	// 1.2 imports of <script setup>: hoisted, then their macro and duplicate specifiers removed
	for (const node of plan.imports) {
		s.insertBefore(0, s.cut(node.start, node.hoistEnd));
		let removed = 0;
		for (let index = 0; index < node.removed.length; index++) {
			const removeLeft = index > removed;
			removed++;
			const current = node.removed[index];
			const next = node.removed[index + 1];
			s.replace(
				removeLeft ? node.removed[index - 1].end : current.start,
				next && !removeLeft ? next.start : current.end,
				'',
			);
		}
		if (node.removed.length) {
			s.replace(node.start, node.end, '');
		}
	}
	// 2.1 the normal script, after <script setup>, is moved up so that __default__ is declared first
	if (plan.defaultExport) {
		replace(plan.defaultExport[0], plan.defaultExport[1], 'const __default__ = ');
		s.insertBefore(0, s.cut(plan.scriptStartOffset, plan.scriptEndOffset));
	}
	// 2.2 the body of <script setup>, statement by statement
	const models = [];
	let awaitIndex = 0;
	for (const node of plan.body) {
		switch (node.kind) {
			case 'type':
				s.insertBefore(0, s.cut(node.start, node.end));
				break;
			case 'remove':
				s.replace(node.start, node.end, '');
				break;
			case 'replace':
				replace(node.start, node.end, node.code);
				break;
			case 'model': {
				for (const [start, end] of node.removals) {
					s.replace(start, end, '');
				}
				models.push(`\n    ${node.name}: `, node.kept.map(([start, end]) => copy(start, end)), ',');
				replace(node.callee, node.calleeEnd, '_useModel');
				s.insertAfter(node.arg0, '__props, ');
				break;
			}
			case 'await': {
				const { head, tail } = plan.awaitCode[awaitIndex++];
				replace(node.start, node.argument, head);
				s.writer(node.rank).insertAfter(node.end, tail);
				break;
			}
		}
	}
	// 3 the references of destructured props
	for (const reference of plan.references) {
		if (reference.kind === 'shorthand') {
			s.insertAfter(reference.end, reference.code);
		}
		else {
			replace(reference.start, reference.end, reference.code);
		}
	}
	// 5 everything but the scripts is removed
	if (plan.defaultExport) {
		s.replace(0, startOffset, '');
		s.replace(endOffset, plan.scriptStartOffset, '');
		s.replace(plan.scriptEndOffset, plan.length, '');
	}
	else {
		s.replace(0, startOffset, '');
		s.replace(endOffset, plan.length, '');
	}
	// 7 css vars, 8 async context, at the start tag
	if (plan.helpers.has('useCssVars')) {
		s.writer(SetupRank.CssVars).insertAfter(startOffset, '\n_useCssVars(_ctx => ({\n  "color": (_unref(color))\n}))\n');
	}
	if (plan.awaits) {
		s.writer(SetupRank.AsyncContext).insertAfter(startOffset, '\nlet __temp: any, __restore: any\n');
	}
	// 9 the inline template, returned before the end tag
	if (plan.template.length) {
		s.writer(HeadRank.Preamble).insertAfter(0, plan.preamble);
		s.writer(SetupRank.Return).insertBefore(endOffset, ['\nreturn ', templatePieces(source, plan)]);
	}
	else {
		s.writer(SetupRank.Return).insertBefore(endOffset, '\nconst __returned__ = { }\nreturn __returned__');
	}
	// 10 the setup function around the body
	const setup = s.writer(SetupRank.Setup);
	setup.insertAfter(startOffset, [
		`\nexport default /*@__PURE__*/_defineComponent({`,
		plan.defaultExport ? `\n  ...__default__,` : '',
		plan.optionsDecl ? ['\n  ...', copy(plan.optionsDecl[0], plan.optionsDecl[1]), ','] : '',
		`\n  __name: 'Generated',`,
		models.length || plan.propsDecl.length
			? ['\n  props: /*@__PURE__*/_mergeModels(', plan.propsDecl[0] ?? '{}', ', {', models, '\n  }),']
			: '',
		`\n  ${plan.awaits ? 'async ' : ''}setup(__props: any, { expose: __expose, emit: __emit }) {\n`,
	]);
	setup.insertBefore(endOffset, `\n}\n\n})`);
	// 11 the helper imports, before all
	s.writer(HeadRank.HelperImports).insertAfter(0, plan.helperImport);
	return s;
}
