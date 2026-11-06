// node bench/suite/compare.mjs <base.json> <head.json>: the change between two result files of bench/suite/run.mjs,
// such as one saved with --out on master and one of a branch. Prefer run.mjs --against, which interleaves the builds
// in one session; results of separate sessions also differ by what else the machine did.
import * as fs from 'node:fs';
import { comparison } from './report.mjs';

const [basePath, headPath] = process.argv.slice(2);
if (!basePath || !headPath) {
	console.error('node bench/suite/compare.mjs <base.json> <head.json>');
	process.exit(1);
}
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const base = read(basePath);
const head = read(headPath);
// the last build of a file is the one that it measured; with --against, its first build is the base
const pick = (results, name) => {
	const build = results.builds[results.builds.length - 1].name;
	return results.entries.filter(entry => entry.build === build).map(entry => ({ ...entry, build: name }));
};

const lines = [];
const differences = ['node', 'cpu', 'platform']
	.filter(field => base.conditions[field] !== head.conditions[field])
	.map(field => `${field}: ${base.conditions[field]} → ${head.conditions[field]}`);
if (differences.length) {
	lines.push(`**The results come from different conditions, so the change is not only of the code.** ${differences.join('; ')}.`, '');
}
lines.push(`- base: ${basePath}, ${base.builds.at(-1).describe}, ${base.conditions.started}`);
lines.push(`- head: ${headPath}, ${head.builds.at(-1).describe}, ${head.conditions.started}`, '');
lines.push(...comparison(pick(head, 'head'), 'base', 'head', false, pick(base, 'base')));
console.log(lines.join('\n'));
