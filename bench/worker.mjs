// node --allow-natives-syntax bench/worker.mjs <implementation> <workload> <size> [verify]
// Prints one JSON line: the hash of the output and, unless verifying, the time of the first iteration (cold) and the
// median of 20 iterations after 20 more (warm), in ms.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workloads } from './workloads.mjs';

const [implementation, workload, sizeArg, mode] = process.argv.slice(2);
const size = Number(sizeArg);
const here = path.dirname(fileURLToPath(import.meta.url));
const build = name => import(path.join(here, '.build', name, 'out/index.js'));

let M;
let kind = 'rewrite';
if (implementation === 'segments-0.4') {
	M = createRequire(import.meta.url)('muggle-string-0.4');
	kind = 'segments-0.4';
}
else if (implementation === 'spliced') {
	M = { ...await build('source'), ...await import('./baselines/spliced.mjs') };
}
else {
	M = await build(implementation);
}

// outputs are flat strings, as a concatenation left for later would move work out of the timing
const flat = new Function('text', '%FlattenString(text); return text');
const run = workloads[workload].prepare(size, flat)[kind];
const hash = output => createHash('sha1').update(output).digest('hex').slice(0, 16);

const once = () => {
	const start = performance.now();
	const output = flat(run(M));
	return [performance.now() - start, output];
};

const [cold, output] = once();
const result = { implementation, workload, size, hash: hash(output) };
if (mode !== 'verify') {
	result.cold = cold;
	// one slow cold run is enough to show the cost; its warm runs would take minutes
	if (cold < 3000) {
		for (let index = 0; index < 20; index++) {
			once();
		}
		const times = [];
		for (let index = 0; index < 20; index++) {
			const [time, again] = once();
			if (hash(again) !== result.hash) {
				throw new Error(`${implementation} gives another output for ${workload} ${size} at a later run.`);
			}
			times.push(time);
		}
		times.sort((a, b) => a - b);
		result.warm = (times[9] + times[10]) / 2;
	}
}
console.log(JSON.stringify(result));
