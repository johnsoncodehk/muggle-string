// node bench/techniques/table.mjs: the markdown tables of bench/.results/techniques, which bench/techniques/run.mjs
// also writes to table.md.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { variants } from './variants.mjs';
import { workloads } from './workloads.mjs';

const median = values => {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = sorted.length >> 1;
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

function ms(value) {
	return value >= 1000
		? `${Math.round(value).toLocaleString('en-US')}`
		: value >= 100
		? value.toFixed(0)
		: value >= 10
		? value.toFixed(1)
		: value.toFixed(2);
}

/** Median and range over the processes of one implementation on one workload. */
function stats(results, field) {
	const values = results.map(result => result[field]).filter(value => value !== undefined);
	return values.length
		? { median: median(values), min: Math.min(...values), max: Math.max(...values), count: values.length }
		: undefined;
}

const show = (stat, single) =>
	single
		? stat ? `${ms(stat.median)} (single cold run)` : 'single cold run, not run warm'
		: stat
		? stat.count === 1 ? ms(stat.median) : `${ms(stat.median)} (${ms(stat.min)}–${ms(stat.max)})`
		: 'over 3 s cold, not run warm';
const short = stat => stat ? ms(stat.median) : '–';
const label = key => {
	const [workload, size] = key.split(' ');
	return `${workload} ${Number(size).toLocaleString('en-US')}`;
};

/**
 * How much slower `variant` is than `source`, by the runs of the same round, which ran one after the other: the median
 * of the ratios when every round agrees on which is faster and the median is at least 3% from 1, else undefined.
 */
function ratio(sourceRuns, variantRuns) {
	const ratios = [];
	for (const run of variantRuns) {
		const paired = sourceRuns.find(other => other.round === run.round);
		if (paired?.warm !== undefined && run.warm !== undefined) {
			ratios.push(run.warm / paired.warm);
		}
	}
	if (!ratios.length) {
		return undefined;
	}
	const middle = median(ratios);
	const slower = ratios.filter(value => value > 1).length;
	const agree = Math.max(slower, ratios.length - slower) >= Math.ceil(ratios.length * 0.8);
	return agree && Math.abs(middle - 1) >= 0.03 ? middle : undefined;
}

const times = value => `${value.toFixed(2)}×`;

export function table(jsonl, conditions) {
	const results = jsonl.trim().split('\n').map(line => JSON.parse(line));
	const groups = new Map();
	for (const result of results) {
		const key = `${result.workload} ${result.size}`;
		const byImplementation = groups.get(key) ?? new Map();
		groups.set(key, byImplementation);
		const list = byImplementation.get(result.implementation) ?? [];
		byImplementation.set(result.implementation, list);
		list.push(result);
	}
	const get = (key, implementation, field) => {
		const list = groups.get(key)?.get(implementation);
		return list && stats(list, field);
	};
	const lines = [];
	lines.push(
		`Node ${conditions.node}, ${conditions.cpu}, ${conditions.platform}. ${conditions.processes === 1 ? 'Each figure is a single round: one fresh process for each implementation on each workload, in ms.' : `Each cell is the median over ${conditions.processes} rounds of fresh processes, with the range in parentheses, in ms.`} Cold is the first run in a process; warm is the median of 20 runs after 20 more. Every implementation gives the same output, by hash, before it is timed.`,
		'',
		'## Baselines',
		'',
		'| Workload | | source | sorted array, spliced | 0.4 segment array |',
		'|---|---|---|---|---|',
	);
	for (const key of groups.keys()) {
		if (!groups.get(key).has('spliced')) {
			continue;
		}
		for (const field of ['warm', 'cold']) {
			const cells = ['source', 'spliced', 'segments-0.4'].map(implementation => {
				if (!groups.get(key).has(implementation)) {
					return 'cannot run it';
				}
				const single = conditions.processes > 1 && groups.get(key).get(implementation).length === 1;
				return show(get(key, implementation, field), single);
			});
			lines.push(`| ${label(key)} | ${field} | ${cells.join(' | ')} |`);
		}
	}
	lines.push('', '## Techniques', '');
	lines.push(
		conditions.processes === 1
			? 'A technique saves time on a workload when the variant without it is slower than the source by 3% or more, in a single round.'
			: 'A technique saves time on a workload when, in at least 80% of the rounds, which run each implementation one after the other, the source with it is faster than the variant without it, and by 3% or more in the median of the rounds.',
		'',
		'| Technique | Workload | Warm, with → without | Cold, with → without | Saves, warm | No measurable difference, warm |',
		'|---|---|---|---|---|---|',
	);
	const unearned = [];
	const runsOf = (key, implementation) => groups.get(key)?.get(implementation) ?? [];
	for (const variant of variants) {
		const same = [];
		const faster = [];
		let gains = false;
		for (const key of groups.keys()) {
			if (!groups.get(key).has(variant.name)) {
				continue;
			}
			const slower = ratio(runsOf(key, 'source'), runsOf(key, variant.name));
			if (slower === undefined) {
				same.push(label(key));
			}
			else if (slower < 1) {
				faster.push(`${label(key)} (${times(slower)}, faster without)`);
			}
			else {
				gains = true;
			}
		}
		if (!gains) {
			unearned.push(variant);
		}
		variant.targets.forEach((key, index) => {
			const warm = `${short(get(key, 'source', 'warm'))} → ${short(get(key, variant.name, 'warm'))}`;
			const cold = `${short(get(key, 'source', 'cold'))} → ${short(get(key, variant.name, 'cold'))}`;
			const slower = ratio(runsOf(key, 'source'), runsOf(key, variant.name));
			const saves = slower === undefined ? 'no measurable difference' : times(slower);
			const first = index === 0;
			const rest = [...same, ...faster].join(', ') || 'none';
			lines.push(
				`| ${first ? variant.technique : ''} | ${label(key)} | ${warm} | ${cold} | ${saves} | ${first ? rest : ''} |`,
			);
		});
	}
	lines.push('', '## Every technique on every workload, warm', '');
	const keys = [...groups.keys()];
	lines.push(`| Without | ${keys.map(label).join(' | ')} |`, `|---|${keys.map(() => '---').join('|')}|`);
	for (const implementation of ['source', ...variants.map(variant => variant.name)]) {
		const cells = keys.map(key => groups.get(key).has(implementation) ? show(get(key, implementation, 'warm')) : '');
		lines.push(`| ${implementation} | ${cells.join(' | ')} |`);
	}
	lines.push('', '## Workloads', '');
	for (const [name, { description }] of Object.entries(workloads)) {
		lines.push(`- ${name}: ${description}.`);
	}
	if (unearned.length) {
		lines.push('', '## No measurable gain on any workload', '');
		for (const variant of unearned) {
			lines.push(`- ${variant.technique}`);
		}
	}
	return lines.join('\n') + '\n';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.results/techniques');
	const conditions = JSON.parse(fs.readFileSync(path.join(dir, 'conditions.json'), 'utf8'));
	process.stdout.write(table(fs.readFileSync(path.join(dir, 'results.jsonl'), 'utf8'), conditions));
}
