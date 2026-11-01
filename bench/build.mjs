// Builds the source and each variant of it into bench/.build/<name>/out.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { variants } from './variants.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(root, 'bench/.build');
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

export function build() {
	fs.rmSync(buildDir, { recursive: true, force: true });
	for (const variant of [{ name: 'source', replacements: [] }, ...variants]) {
		const dir = path.join(buildDir, variant.name);
		fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
		for (const file of fs.readdirSync(path.join(root, 'src'))) {
			let text = fs.readFileSync(path.join(root, 'src', file), 'utf8');
			for (const { file: target, find, replace } of variant.replacements) {
				if (target === file) {
					text = replaceOnce(text, find, replace, `${variant.name} in ${file}`);
				}
			}
			fs.writeFileSync(path.join(dir, 'src', file), text);
		}
		fs.writeFileSync(path.join(dir, 'package.json'), '{ "type": "module" }\n');
		fs.writeFileSync(
			path.join(dir, 'tsconfig.json'),
			JSON.stringify({
				extends: path.join(root, 'tsconfig.json'),
				compilerOptions: { outDir: 'out', rootDir: 'src', declaration: false, sourceMap: false, noUnusedLocals: false, noUnusedParameters: false },
				include: ['src'],
			}),
		);
		const { status, stdout, stderr } = spawnSync(process.execPath, [tsc, '-p', dir], { encoding: 'utf8' });
		if (status !== 0) {
			throw new Error(`${variant.name} does not compile:\n${stdout}${stderr}`);
		}
	}
	return buildDir;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	build();
}
