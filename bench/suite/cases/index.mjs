import { micro } from './micro.mjs';
import { vue } from './vue.mjs';

/** Every case, micro cases first; a name is a stable id that results and comparisons key on. */
export const cases = [...micro.map(c => ({ group: 'micro', ...c })), ...vue.map(c => ({ group: 'vue', ...c }))];

const names = new Set();
for (const { name } of cases) {
	if (names.has(name)) {
		throw new Error(`Two cases are named ${name}.`);
	}
	names.add(name);
}

export function findCase(name) {
	const found = cases.find(c => c.name === name);
	if (!found) {
		throw new Error(`There is no case ${name}.`);
	}
	return found;
}
