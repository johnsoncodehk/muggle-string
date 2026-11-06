// node bench/techniques/run.mjs [rounds]: one round by default, a fresh process for each implementation on each workload
// Builds the source and its variants, checks that every implementation gives the output of the source on every
// workload it runs, then times each in fresh processes, interleaved, and writes bench/.results/techniques/results.jsonl
// and bench/.results/techniques/table.md.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../build.mjs';
import { table } from './table.mjs';
import { variants } from './variants.mjs';
import { workloads } from './workloads.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const resultsDir = path.join(here, '../.results/techniques');
const processes = Number(process.argv[2] ?? 1);

const sizes = {
	'random': [10_000, 100_000],
	'ordered': [10_000, 100_000],
	'random-map': [100_000],
	'ordered-map': [100_000],
	'non-ascii-map': [100_000],
	'views': [100_000],
	'spans': [100_000],
	'cuts': [10_000],
};
const rewrites = ['source', ...variants.map(variant => variant.name)];
const runs = [];
for (const [workload, { kinds }] of Object.entries(workloads)) {
	for (const size of sizes[workload]) {
		for (const implementation of [...rewrites, 'spliced', 'segments-0.4']) {
			const kind = rewrites.includes(implementation) ? 'rewrite' : implementation;
			if (kinds.includes(kind)) {
				runs.push({ implementation, workload, size });
			}
		}
	}
}

// a run of the 0.4 segment array at 100,000 edits takes tens of seconds, so one cold run in the first round shows it
const single = ({ implementation, size }) => implementation === 'segments-0.4' && size === 100_000;

function work({ implementation, workload, size }, verify) {
	const args = ['--allow-natives-syntax', path.join(here, 'worker.mjs'), implementation, workload, String(size)];
	const { status, stdout, stderr } = spawnSync(process.execPath, verify ? [...args, 'verify'] : args, {
		encoding: 'utf8',
	});
	if (status !== 0) {
		throw new Error(`${implementation} ${workload} ${size} failed:\n${stderr}`);
	}
	return JSON.parse(stdout);
}

console.log('building');
build();
console.log(`checking the output of ${runs.length} runs`);
const expected = new Map();
for (const run of runs) {
	const { hash } = work(run, true);
	const key = `${run.workload} ${run.size}`;
	if (run.implementation === 'source') {
		expected.set(key, hash);
	}
	else if (hash !== expected.get(key)) {
		throw new Error(`${run.implementation} gives another output than the source for ${key}.`);
	}
}

fs.mkdirSync(resultsDir, { recursive: true });
const conditions = {
	node: process.version,
	cpu: os.cpus()[0]?.model,
	platform: `${os.platform()} ${os.arch()}`,
	processes,
	started: new Date().toISOString(),
};
fs.writeFileSync(path.join(resultsDir, 'conditions.json'), JSON.stringify(conditions, null, '\t') + '\n');
const resultsFile = path.join(resultsDir, 'results.jsonl');
fs.writeFileSync(resultsFile, '');
for (let round = 1; round <= processes; round++) {
	console.log(`round ${round} of ${processes}`);
	for (const run of runs) {
		if (round > 1 && single(run)) {
			continue;
		}
		const result = work(run, false);
		if (result.hash !== expected.get(`${run.workload} ${run.size}`)) {
			throw new Error(`${run.implementation} gives another output for ${run.workload} ${run.size}.`);
		}
		fs.appendFileSync(resultsFile, JSON.stringify({ round, ...result }) + '\n');
	}
}
const markdown = table(fs.readFileSync(resultsFile, 'utf8'), conditions);
fs.writeFileSync(path.join(resultsDir, 'table.md'), markdown);
console.log(markdown);
