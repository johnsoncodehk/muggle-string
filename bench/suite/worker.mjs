// node --allow-natives-syntax [--expose-gc] bench/suite/worker.mjs <build dir> <case> <size> <time|memory|verify>
// Runs one case at one size on one build in this fresh process, and prints one line of JSON. The options of the time
// mode come as JSON in the environment variable MUGGLE_BENCH_OPTIONS.
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as v8 from 'node:v8';
import { findCase } from './cases/index.mjs';
import { summarize } from './stats.mjs';

const [buildDir, caseName, sizeArg, mode] = process.argv.slice(2);
const size = Number(sizeArg);
const options = {
	warmupMs: 300,
	minWarmup: 5,
	samples: 25,
	sampleMs: 10,
	budgetMs: 4000,
	...JSON.parse(process.env.MUGGLE_BENCH_OPTIONS ?? '{}'),
};

const M = await import(pathToFileURL(path.join(buildDir, 'out/index.js')).href);
const benchCase = findCase(caseName);
const { prepare, run, output = benchCase.output } = benchCase.setup(M, size);

// A string built by concatenation is a rope until it is read; flattening it in the timed code keeps that work from
// moving out of the timing, or into the hash.
let flat = text => text;
try {
	flat = new Function('text', '%FlattenString(text); return text');
}
catch {}
function finish(result) {
	if (typeof result === 'string') {
		flat(result);
	}
	else if (result && typeof result === 'object') {
		if (typeof result.text === 'string') {
			flat(result.text);
		}
		if (typeof result.map?.mappings === 'string') {
			flat(result.map.mappings);
		}
	}
	return result;
}
const hash = result => {
	const text = output ? output(result) : typeof result === 'string' ? result : JSON.stringify(result);
	return createHash('sha1').update(String(text)).digest('hex').slice(0, 16);
};

const now = () => performance.now();
// a global, so no result is dead code
globalThis.__muggleBenchSink = undefined;
const report = result => process.stdout.write(JSON.stringify({ case: caseName, size, mode, ...result }) + '\n');

if (mode === 'verify') {
	const first = hash(finish(run(prepare?.())));
	const second = hash(finish(run(prepare?.())));
	if (first !== second) {
		throw new Error(`${caseName} ${size} gives another output when it runs again.`);
	}
	report({ hash: first });
}
else if (mode === 'memory') {
	if (typeof gc !== 'function') {
		throw new Error('The memory mode needs --expose-gc.');
	}
	const state = prepare?.();
	gc();
	gc();
	const before = process.memoryUsage();
	const peakBefore = process.resourceUsage().maxRSS * 1024;
	const heapBefore = v8.getHeapStatistics().used_heap_size;
	const profiler = typeof v8.GCProfiler === 'function' ? new v8.GCProfiler() : undefined;
	profiler?.start();
	const start = now();
	const result = finish(run(state));
	const time = now() - start;
	const profile = profiler?.stop();
	const heapEnd = v8.getHeapStatistics().used_heap_size;
	const peakAfter = process.resourceUsage().maxRSS * 1024;
	let allocated;
	let gcTime;
	let peakHeap = heapEnd - heapBefore;
	if (profile) {
		// what each collection freed was allocated in the run, as the heap was collected right before it
		allocated = heapEnd - heapBefore;
		gcTime = 0;
		for (const { cost, beforeGC, afterGC } of profile.statistics) {
			allocated += beforeGC.heapStatistics.usedHeapSize - afterGC.heapStatistics.usedHeapSize;
			gcTime += cost / 1000;
			peakHeap = Math.max(peakHeap, beforeGC.heapStatistics.usedHeapSize - heapBefore);
		}
	}
	const outputHash = hash(result);
	gc();
	gc();
	const after = process.memoryUsage();
	globalThis.__muggleBenchSink = [state, result];
	report({
		hash: outputHash,
		time,
		rssBefore: before.rss,
		// the high-water mark of the process, from the RSS after the setup was collected; when the run did not raise
		// it, the setup did, and the growth is at most this
		peakRssGrowth: Math.max(0, peakAfter - before.rss),
		peakRssFromSetup: peakAfter === peakBefore,
		allocated,
		peakHeap,
		gcTime,
		retained: after.heapUsed + after.arrayBuffers - before.heapUsed - before.arrayBuffers,
	});
}
else if (mode === 'time') {
	const once = () => {
		const state = prepare?.();
		const start = now();
		const result = finish(run(state));
		return [now() - start, result];
	};
	const [cold, coldResult] = once();
	const expected = hash(coldResult);
	const warm = [];
	const warmStart = now();
	let warmup = 0;
	while (warmup < options.minWarmup || now() - warmStart < options.warmupMs) {
		// the last runs only, which show the code once it is optimized
		warm[warmup++ % 64] = once()[0];
		if (now() - warmStart > options.budgetMs) {
			break;
		}
	}
	const estimate = Math.max(1e-6, summarize(warm).median);
	const batch = Math.max(1, Math.min(10_000, Math.round(options.sampleMs / estimate)));
	const samples = [];
	const sampleStart = now();
	let last;
	while (samples.length < options.samples && (samples.length < 5 || now() - sampleStart < options.budgetMs)) {
		const states = prepare ? Array.from({ length: batch }, prepare) : undefined;
		const start = now();
		for (let index = 0; index < batch; index++) {
			last = finish(run(states?.[index]));
		}
		samples.push((now() - start) / batch);
		globalThis.__muggleBenchSink = last;
	}
	if (hash(last) !== expected) {
		throw new Error(`${caseName} ${size} gives another output once warm.`);
	}
	report({ hash: expected, cold, batch, warmup, ...summarize(samples), samples });
}
else {
	throw new Error(`There is no mode ${mode}.`);
}
