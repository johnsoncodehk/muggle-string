// node bench/suite/run.mjs [options]: builds the working tree, and with --against a base, checks that every case gives
// the same output on each, then times each case and measures its memory in fresh processes, round by round, and
// writes bench/.results/suite/latest.json and latest.md. See bench/README.md.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFiles, refFiles, revision, root, srcIsDirty, variantFiles, workingTreeFiles } from '../build.mjs';
import { cases } from './cases/index.mjs';
import { markdown } from './report.mjs';
import { median } from './stats.mjs';

const usage = `node bench/suite/run.mjs [options]
  --filter <text>      only cases whose name contains <text>; repeat for more
  --group <micro|vue>  only the cases of one group
  --size <n>           only that size of each case
  --rounds <n>         fresh processes per case and build: 3, or 5 with --against
  --against <base>     also measure <base>, a git ref or variant:<name>, interleaved, and show the change
  --time-only          no memory runs
  --memory-only        no time runs
  --quick              1 round and shorter sampling, for a look while working
  --smoke              each case once at a tiny size, output checked only: for CI
  --allow-output-change  with --against, measure even where the outputs differ
  --out <file>         also write the JSON results to <file>
  --list               list the cases`;

const args = process.argv.slice(2);
const flags = { filter: [] };
for (let index = 0; index < args.length; index++) {
	const arg = args[index];
	const value = () => {
		const next = args[++index];
		if (next === undefined) {
			throw new Error(`${arg} needs a value.\n${usage}`);
		}
		return next;
	};
	switch (arg) {
		case '--filter':
			flags.filter.push(value());
			break;
		case '--group':
			flags.group = value();
			break;
		case '--size':
			flags.size = Number(value());
			break;
		case '--rounds':
			flags.rounds = Number(value());
			break;
		case '--against':
			flags.against = value();
			break;
		case '--out':
			flags.out = value();
			break;
		case '--time-only':
			flags.memory = false;
			break;
		case '--memory-only':
			flags.time = false;
			break;
		case '--quick':
			flags.quick = true;
			flags.rounds = 1;
			break;
		case '--smoke':
			flags.smoke = true;
			break;
		case '--allow-output-change':
			flags.allowOutputChange = true;
			break;
		case '--list':
			flags.list = true;
			break;
		case '--help':
		case '-h':
			console.log(usage);
			process.exit(0);
		default:
			throw new Error(`Unknown option ${arg}.\n${usage}`);
	}
}

const selected = cases.filter(c =>
	(!flags.group || c.group === flags.group)
	&& (!flags.filter.length || flags.filter.some(text => c.name.includes(text)))
);
if (flags.list) {
	for (const c of selected) {
		console.log(`${c.name.padEnd(32)} ${c.sizes.join(', ').padEnd(22)} ${c.description}`);
	}
	process.exit(0);
}
flags.rounds ??= flags.against ? 5 : 3;
if (!selected.length) {
	throw new Error('No case matches the filters.');
}

const here = path.dirname(fileURLToPath(import.meta.url));
const worker = path.join(here, 'worker.mjs');
const resultsDir = path.join(root, 'bench/.results/suite');
const log = text => process.stderr.write(text + '\n');

const builds = [];
if (flags.against) {
	const variant = flags.against.startsWith('variant:') ? flags.against.slice('variant:'.length) : undefined;
	builds.push({
		name: 'base',
		describe: variant ? `the working tree without ${variant}` : `${flags.against} (${revision(flags.against)})`,
		files: variant ? variantFiles(variant) : refFiles(flags.against),
	});
}
builds.push({
	name: 'current',
	describe: `the working tree at ${revision()}${srcIsDirty() ? ' with changes to src' : ''}`,
	files: workingTreeFiles(),
});
log(`building ${builds.map(build => build.name).join(' and ')}`);
for (const build of builds) {
	build.dir = buildFiles(`suite-${build.name}`, build.files);
	delete build.files;
}

const timeOptions = flags.quick ? { warmupMs: 100, samples: 10, budgetMs: 1500 } : {};

function work(build, name, size, mode) {
	const nodeArgs = ['--allow-natives-syntax', ...(mode === 'memory' ? ['--expose-gc'] : [])];
	const { status, stdout, stderr } = spawnSync(process.execPath, [...nodeArgs, worker, build.dir, name, String(size), mode], {
		encoding: 'utf8',
		env: { ...process.env, MUGGLE_BENCH_OPTIONS: JSON.stringify(timeOptions) },
		maxBuffer: 1 << 26,
	});
	if (status !== 0) {
		throw new Error(`${name} ${size} on ${build.name} in ${mode} mode failed:\n${stderr}`);
	}
	return JSON.parse(stdout.trim().split('\n').pop());
}

const runs = [];
for (const c of selected) {
	const sizes = flags.smoke ? [c.smoke] : c.sizes.filter(size => flags.size === undefined || size === flags.size);
	for (const size of sizes) {
		runs.push({ c, size });
	}
}

log(`checking the output of ${runs.length} runs`);
const differs = new Set();
for (const { c, size } of runs) {
	const hashes = builds.map(build => work(build, c.name, size, 'verify').hash);
	if (hashes.some(hash => hash !== hashes[0])) {
		if (!flags.allowOutputChange) {
			throw new Error(
				`${c.name} ${size} gives another output on ${builds[0].name} than on ${builds[1].name}; pass --allow-output-change to measure it anyway.`,
			);
		}
		differs.add(`${c.name} ${size}`);
	}
}
if (flags.smoke) {
	log(`every case runs and gives one output on ${builds.map(build => build.name).join(' and ')}`);
	process.exit(0);
}

const conditions = {
	node: process.version,
	v8: process.versions.v8,
	cpu: os.cpus()[0]?.model.trim(),
	cpus: os.cpus().length,
	memory: os.totalmem(),
	platform: `${os.platform()} ${os.release()} ${os.arch()}`,
	rounds: flags.rounds,
	quick: !!flags.quick,
	started: new Date().toISOString(),
};
const measures = { time: flags.time !== false, memory: flags.memory !== false };
const raw = new Map();
for (let round = 1; round <= flags.rounds; round++) {
	log(`round ${round} of ${flags.rounds}`);
	for (const { c, size } of runs) {
		// the builds take turns going first, so neither always runs on a machine that the other warmed or tired
		const order = round % 2 ? builds : [...builds].reverse();
		for (const build of order) {
			const key = `${c.name}\u0000${size}\u0000${build.name}`;
			const entry = raw.get(key) ?? { time: [], memory: [] };
			raw.set(key, entry);
			if (measures.time) {
				entry.time.push([round, work(build, c.name, size, 'time')]);
			}
			if (measures.memory) {
				entry.memory.push([round, work(build, c.name, size, 'memory')]);
			}
		}
		const times = builds.map(build => raw.get(`${c.name}\u0000${size}\u0000${build.name}`).time.at(-1)?.[1].median);
		log(`  ${c.name} ${size}: ${times.map(time => time === undefined ? '-' : `${time.toFixed(3)} ms`).join(' / ')}`);
	}
}

const entries = [];
for (const { c, size } of runs) {
	for (const build of builds) {
		const { time, memory } = raw.get(`${c.name}\u0000${size}\u0000${build.name}`);
		const of = (list, field) => median(list.map(([, result]) => result[field]).filter(value => value !== undefined));
		const medians = time.map(([, result]) => result.median);
		entries.push({
			case: c.name,
			group: c.group,
			description: c.description,
			size,
			unit: c.unit,
			units: c.units ? c.units(size) : size,
			build: build.name,
			outputDiffers: differs.has(`${c.name} ${size}`) || undefined,
			time: time.length
				? {
					median: median(medians),
					mad: of(time, 'mad'),
					min: Math.min(...medians),
					max: Math.max(...medians),
					cold: of(time, 'cold'),
					rounds: time.map(([round, result]) => [round, result.median]),
				}
				: undefined,
			memory: memory.length
				? {
					peakRssGrowth: of(memory, 'peakRssGrowth'),
					peakRssFromSetup: memory.some(([, result]) => result.peakRssFromSetup),
					allocated: of(memory, 'allocated'),
					peakHeap: of(memory, 'peakHeap'),
					gcTime: of(memory, 'gcTime'),
					retained: of(memory, 'retained'),
					rounds: memory.map(([round, result]) => [round, result.peakRssGrowth]),
				}
				: undefined,
		});
	}
}

const results = {
	format: 1,
	conditions,
	builds: builds.map(({ name, describe }) => ({ name, describe })),
	entries,
};
fs.mkdirSync(resultsDir, { recursive: true });
const json = JSON.stringify(results, null, '\t') + '\n';
const text = markdown(results);
fs.writeFileSync(path.join(resultsDir, 'latest.json'), json);
fs.writeFileSync(path.join(resultsDir, 'latest.md'), text);
if (flags.out) {
	fs.writeFileSync(path.resolve(flags.out), json);
}
console.log(text);
