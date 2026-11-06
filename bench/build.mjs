// Builds copies of `src` into bench/.build/<name>/out: the working tree, the `src` of a git ref, or the working tree
// with the exact replacements of a technique variant. Each copy is compiled by the TypeScript of the repo with the
// compiler options of the repo, so two builds differ only by their sources.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { variants } from './techniques/variants.mjs';

export const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const buildDir = path.join(root, 'bench/.build');
const tsc = path.join(root, 'node_modules/typescript/bin/tsc');

function replaceOnce(text, find, replace, where) {
	if (typeof find === 'string') {
		const at = text.indexOf(find);
		if (at < 0 || text.indexOf(find, at + 1) >= 0) {
			throw new Error(`${where}: the text to replace is not found exactly once:\n${find}`);
		}
		return text.slice(0, at) + replace + text.slice(at + find.length);
	}
	const matches = [...text.matchAll(new RegExp(find.source, find.flags.includes('g') ? find.flags : find.flags + 'g'))];
	if (matches.length !== 1) {
		throw new Error(`${where}: ${find} matches ${matches.length} times, not once.`);
	}
	const [match] = matches;
	return text.slice(0, match.index) + replace + text.slice(match.index + match[0].length);
}

function git(args) {
	const { status, stdout, stderr } = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
	if (status !== 0) {
		throw new Error(`git ${args.join(' ')} failed:\n${stderr}`);
	}
	return stdout;
}

/** The files of `src` in the working tree, by name. */
export function workingTreeFiles() {
	const files = new Map();
	for (const file of fs.readdirSync(path.join(root, 'src'))) {
		files.set(file, fs.readFileSync(path.join(root, 'src', file), 'utf8'));
	}
	return files;
}

/** The files of `src` at the git ref `ref`, by name. */
export function refFiles(ref) {
	const files = new Map();
	for (const file of git(['ls-tree', '--name-only', `${ref}:src`]).split('\n').filter(Boolean)) {
		files.set(file, git(['show', `${ref}:src/${file}`]));
	}
	return files;
}

/** The commit of `ref`, short. */
export function revision(ref = 'HEAD') {
	return git(['rev-parse', '--short', ref]).trim();
}

/** Whether `src` in the working tree differs from HEAD. */
export function srcIsDirty() {
	return git(['status', '--porcelain', '--', 'src']).trim() !== '';
}

/** The working tree with the replacements of the variant `name`. */
export function variantFiles(name) {
	const variant = variants.find(variant => variant.name === name);
	if (!variant) {
		throw new Error(`There is no variant ${name}; the variants are ${variants.map(variant => variant.name).join(', ')}.`);
	}
	const files = workingTreeFiles();
	for (const [file, text] of files) {
		let replaced = text;
		for (const { file: target, find, replace } of variant.replacements) {
			if (target === file) {
				replaced = replaceOnce(replaced, find, replace, `${variant.name} in ${file}`);
			}
		}
		files.set(file, replaced);
	}
	return files;
}

/** Compiles `files` into bench/.build/`name`/out, replacing an earlier build of that name, and returns that dir. */
export function buildFiles(name, files) {
	const dir = path.join(buildDir, name);
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
	for (const [file, text] of files) {
		fs.writeFileSync(path.join(dir, 'src', file), text);
	}
	fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }) + '\n');
	fs.writeFileSync(
		path.join(dir, 'tsconfig.json'),
		JSON.stringify({
			extends: path.join(root, 'tsconfig.json'),
			compilerOptions: {
				outDir: 'out',
				rootDir: 'src',
				declaration: false,
				sourceMap: false,
				noUnusedLocals: false,
				noUnusedParameters: false,
			},
			include: ['src'],
		}),
	);
	const { status, stdout, stderr } = spawnSync(process.execPath, [tsc, '-p', dir], { encoding: 'utf8' });
	if (status !== 0) {
		throw new Error(`${name} does not compile:\n${stdout}${stderr}`);
	}
	return dir;
}

/** The source and each variant of the techniques bench. */
export function build() {
	fs.rmSync(buildDir, { recursive: true, force: true });
	buildFiles('source', workingTreeFiles());
	for (const variant of variants) {
		buildFiles(variant.name, variantFiles(variant.name));
	}
	return buildDir;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	build();
}
