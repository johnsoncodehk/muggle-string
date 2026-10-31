import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeAll, expect, test } from 'vitest';
import { rewritePieceText } from '../src';

const readme = fs.readFileSync(path.join(__dirname, '../README.md'), 'utf8').replace(/\r\n/g, '\n');
const blocks = [...readme.matchAll(/^```ts\n(.*?)^```$/gms)].map(([, code]) => code!);
const [usage, text, declaration, rendering, sourceMaps] = blocks;
const dir = path.join(__dirname, '.readme');

/** The module of `example`, which renders the rewrite of the usage, exporting `names`. */
function writeExample(name: string, example: string, names: string[]) {
	const code = `${usage}\n${example}\nexport { ${names.join(', ')} };\n`;
	fs.writeFileSync(path.join(dir, `${name}.ts`), code.replaceAll(`from 'muggle-string'`, `from '../../src'`));
}

/** The text of the comments that end `example`, which show what it gives. */
function shown(example: string) {
	const lines = example.trimEnd().split('\n');
	let start = lines.length;
	while (start && lines[start - 1]!.startsWith('// ')) {
		start--;
	}
	return lines.slice(start).map(line => line.slice('// '.length)).join('\n');
}

beforeAll(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir);
	writeExample('text', text!, ['output']);
	writeExample('rendering', rendering!, ['pieces']);
	writeExample('sourceMaps', sourceMaps!, ['output', 'sourceMap']);
	fs.writeFileSync(
		path.join(dir, 'declaration.ts'),
		`import type { Piece as Declared } from '../../src';\n${declaration}`
			+ 'type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;\n'
			+ 'export const same: [Equal<Piece, Declared>, Equal<Piece<{ source: object }>, Declared<{ source: object }>>] = [true, true];\n',
	);
	fs.writeFileSync(
		path.join(dir, 'tsconfig.json'),
		JSON.stringify({
			compilerOptions: {
				strict: true,
				noEmit: true,
				target: 'ES2022',
				lib: ['ES2022'],
				module: 'preserve',
				moduleResolution: 'bundler',
				types: [],
			},
			include: ['*.ts'],
		}),
	);
});

test('the readme has the examples of the usage, its text, the pieces, the rendering and the source maps', () => {
	expect(blocks.length).toBe(5);
	expect(declaration).toMatch(/^type Piece</);
});

test('the examples of the readme type check, and its piece type is the one of the package', () => {
	const tsc = path.join(__dirname, '../node_modules/typescript/bin/tsc');
	const { stdout, stderr } = spawnSync(process.execPath, [tsc, '-p', dir], { encoding: 'utf8' });
	expect(stdout + stderr).toBe('');
});

test('the view of the readme renders the text that it shows', async () => {
	const { output } = await import('./.readme/text');
	expect(output.trimEnd()).toBe(shown(text!));
});

test('the pieces of the readme render the same text', async () => {
	const { pieces } = await import('./.readme/rendering');
	expect(pieces.map(rewritePieceText).join('').trimEnd()).toBe(shown(text!));
});

test('the source map of the readme is the one that it shows', async () => {
	const { output, sourceMap } = await import('./.readme/sourceMaps');
	expect(output.trimEnd()).toBe(shown(text!));
	expect(JSON.stringify(sourceMap)).toBe(shown(sourceMaps!));
});
