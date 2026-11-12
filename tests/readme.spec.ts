import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeAll, expect, test } from 'vitest';

const readme = fs.readFileSync(path.join(__dirname, '../README.md'), 'utf8').replace(/\r\n/g, '\n');
const blocks = [...readme.matchAll(/^```ts\n(.*?)^```$/gms)].map(([, code]) => code!);
const declaration = blocks.find(block => block.startsWith('type Piece<'))!;
const examples = blocks.filter(block => block !== declaration);
const dir = path.join(__dirname, '.readme');

/** The lines that the comments of `example` show it logs, in order: every comment at the start of a line. */
function shown(example: string) {
	return example.split('\n').filter(line => line.startsWith('// ')).map(line => line.slice('// '.length));
}

beforeAll(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir);
	examples.forEach((example, index) => {
		fs.writeFileSync(
			path.join(dir, `example${index}.ts`),
			'export const logged: string[] = [];\n'
				// what console.log prints for these values, without the empty lines that a trailing newline adds
				+ 'const console = { log(...values: (string | number | boolean)[]) { logged.push(...values.join(" ").replace(/\\n+$/, "").split("\\n")); } };\n'
				+ example.replaceAll(`from 'muggle-string'`, `from '../../src'`),
		);
	});
	fs.writeFileSync(
		path.join(dir, 'declaration.ts'),
		`import type { Piece as Declared, Source } from '../../src';\n${declaration}`
			+ 'type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;\n'
			+ 'type Named = Source & { name: string };\n'
			+ 'export const same: [\n'
			+ '\tEqual<Piece, Declared>,\n'
			+ '\tEqual<Piece<Named>, Declared<Named>>,\n'
			+ '\tEqual<Piece<Named, { feature: string }>, Declared<Named, { feature: string }>>,\n'
			+ '\tEqual<Piece<Source | undefined, unknown>, Declared<Source | undefined, unknown>>,\n'
			+ '] = [true, true, true, true];\n',
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

test('the readme declares the piece type, and every other example shows what it logs', () => {
	expect(declaration).toBeDefined();
	expect(examples.length).toBeGreaterThan(0);
	for (const example of examples) {
		expect(example).toMatch(/console\.log\(/);
		expect(shown(example).length).toBeGreaterThan(0);
	}
});

test('the examples of the readme type check, and its piece type is the one of the package', () => {
	const tsc = path.join(__dirname, '../node_modules/typescript/bin/tsc');
	const { stdout, stderr } = spawnSync(process.execPath, [tsc, '-p', dir], { encoding: 'utf8' });
	expect(stdout + stderr).toBe('');
});

test.each(examples.map((example, index) => [index, example] as const))(
	'example %i of the readme logs what its comments show',
	async (index, example) => {
		const { logged } = await import(/* @vite-ignore */ path.join(dir, `example${index}.ts`));
		expect(logged).toEqual(shown(example));
	},
);
