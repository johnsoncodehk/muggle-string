// The markdown of results of bench/suite/run.mjs: each case with its time and memory, and with a base, the change.
import { pairedRatio } from './stats.mjs';

export function ms(value) {
	if (value === undefined) {
		return '–';
	}
	return value >= 1000
		? Math.round(value).toLocaleString('en-US')
		: value >= 100
		? value.toFixed(0)
		: value >= 10
		? value.toFixed(1)
		: value >= 1
		? value.toFixed(2)
		: value.toPrecision(2);
}

function ns(value) {
	return value >= 1000 ? `${(value / 1000).toPrecision(3)} µs` : `${value.toPrecision(3)} ns`;
}

export function mb(bytes) {
	return bytes === undefined ? '–' : (bytes / 1048576).toFixed(Math.abs(bytes) >= 10 * 1048576 ? 0 : 1);
}

const percent = value => `${(value * 100).toFixed(1)}%`;

/**
 * The time change from `base` to `head`, entries of one case and size. Paired, the builds ran round by round in one
 * session; else the two come from separate sessions, and a change needs the ranges of their rounds apart as well.
 */
export function timeChange(base, head, paired) {
	if (!base?.time || !head?.time) {
		return undefined;
	}
	const noise = Math.max(base.time.mad, head.time.mad);
	if (paired) {
		return pairedRatio(new Map(base.time.rounds), new Map(head.time.rounds), 0.03, noise);
	}
	const ratio = head.time.median / base.time.median;
	const floor = Math.max(0.03, 2 * noise);
	const apart = head.time.min > base.time.max || head.time.max < base.time.min;
	const rounds = Math.min(base.time.rounds.length, head.time.rounds.length);
	return { ratio, rounds, floor, change: rounds >= 3 && apart && Math.abs(ratio - 1) >= floor };
}

/** Heap allocation of one cold run is close to deterministic: 1% is a change. */
export function allocationChange(base, head) {
	if (base?.memory?.allocated === undefined || head?.memory?.allocated === undefined) {
		return undefined;
	}
	const ratio = head.memory.allocated / base.memory.allocated;
	return { ratio, change: Math.abs(ratio - 1) >= 0.01 };
}

const cell = change => !change ? '–' : change.change ? `**${change.ratio.toFixed(2)}×**` : `${change.ratio.toFixed(2)}×`;

function header(conditions) {
	return `Node ${conditions.node}, ${conditions.cpu} (${conditions.cpus} threads), ${conditions.platform}, ${mb(conditions.memory)} MB of memory; ${conditions.rounds} round${conditions.rounds === 1 ? '' : 's'} of fresh processes per case${conditions.quick ? ', quick sampling' : ''}.`;
}

const groups = [['micro', 'Micro cases'], ['vue', 'Vue traces']];

/** The table of one build, or of the change from the first build to the last. */
export function markdown(results) {
	const { conditions, builds, entries } = results;
	const lines = [header(conditions), ''];
	lines.push(...builds.map(build => `- ${build.name}: ${build.describe}`), '');
	if (builds.length > 1) {
		lines.push(...comparison(entries, builds[0].name, builds[builds.length - 1].name, true));
		return lines.join('\n');
	}
	lines.push(
		'Warm is the median over rounds of the median sample of each round; spread is the median absolute deviation of the samples in a round, and with more rounds the range of their medians. Cold is the first run in a process. Memory is of one cold run in a fresh process: growth of peak RSS over the RSS before the run, bytes allocated on the V8 heap, GC time, and the heap that stays with the output held.',
		'',
	);
	for (const [group, title] of groups) {
		const groupEntries = entries.filter(entry => entry.group === group);
		if (!groupEntries.length) {
			continue;
		}
		lines.push(
			`## ${title}`,
			'',
			'| Case | Size | Warm, ms | Per unit | Spread | Cold, ms | Peak RSS growth, MB | Allocated, MB | GC, ms | Retained, MB |',
			'|---|---:|---:|---:|---|---:|---:|---:|---:|---:|',
		);
		for (const { case: name, size, unit, units, time, memory } of groupEntries) {
			const perUnit = time ? `${ns((time.median * 1e6) / units)}/${unit}` : '–';
			const spread = time
				? `±${percent(time.mad)}${time.rounds.length > 1 ? `, ${ms(time.min)}–${ms(time.max)}` : ''}`
				: '–';
			const rss = memory ? `${mb(memory.peakRssGrowth)}${memory.peakRssFromSetup ? ' (≤)' : ''}` : '–';
			lines.push(
				`| ${name} | ${size.toLocaleString('en-US')} | ${ms(time?.median)} | ${perUnit} | ${spread} | ${ms(time?.cold)} | ${rss} | ${mb(memory?.allocated)} | ${ms(memory?.gcTime)} | ${mb(memory?.retained)} |`,
			);
		}
		lines.push('');
	}
	lines.push('(≤): the setup of the case set the peak RSS of the process, so the run grew it by at most that.', '');
	return lines.join('\n');
}

/** The rows of the change from the entries of build `base` to those of build `head`. */
export function comparison(entries, base, head, paired, baseEntries = entries) {
	const lines = [];
	for (const [group, title] of groups) {
		const groupEntries = entries.filter(entry => entry.group === group && entry.build === head);
		if (!groupEntries.length) {
			continue;
		}
		lines.push(
			`## ${title}`,
			'',
			`| Case | Size | ${base}, ms | ${head}, ms | Time | ${base}, allocated MB | ${head}, allocated MB | Allocated | ${base}, peak RSS MB | ${head}, peak RSS MB |`,
			'|---|---:|---:|---:|---|---:|---:|---|---:|---:|',
		);
		for (const entry of groupEntries) {
			const other = baseEntries.find(e => e.case === entry.case && e.size === entry.size && e.build === base);
			const differs = entry.outputDiffers ? ' (output differs)' : '';
			lines.push(
				`| ${entry.case}${differs} | ${entry.size.toLocaleString('en-US')} | ${ms(other?.time?.median)} | ${ms(entry.time?.median)} | ${cell(timeChange(other, entry, paired))} | ${mb(other?.memory?.allocated)} | ${mb(entry.memory?.allocated)} | ${cell(allocationChange(other, entry))} | ${mb(other?.memory?.peakRssGrowth)} | ${mb(entry.memory?.peakRssGrowth)} |`,
			);
		}
		lines.push('');
	}
	lines.push(
		paired
			? 'A ratio above 1 is slower or more. A time ratio is in bold, a change, when at least 80% of the rounds, each of which ran both builds one after the other, agree on its direction, and it is at least 3% from 1 and at least twice the spread of the samples; with fewer than 3 rounds none is. An allocation ratio is in bold from 1% on, as allocation barely varies between runs. Peak RSS is shown, not judged: it moves by megabytes between runs of one build.'
			: 'A ratio above 1 is slower or more. The results come from separate sessions, so a time ratio is in bold only when the ranges of the medians of their rounds are apart as well, with 3 rounds or more each, and it is at least 3% from 1 and twice the spread of the samples. An allocation ratio is in bold from 1% on. Peak RSS is shown, not judged.',
		'',
	);
	return lines;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
	const fs = await import('node:fs');
	const file = process.argv[2] ?? new URL('../.results/suite/latest.json', import.meta.url);
	console.log(markdown(JSON.parse(fs.readFileSync(file, 'utf8'))));
}
