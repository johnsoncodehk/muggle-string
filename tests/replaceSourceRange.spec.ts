import { describe, expect, it } from 'vitest';
import { create, replaceSourceRange, toString, Segment } from '../out';

describe('replace source range', async () => {

	it(`problems = 99 -> var answer = 42;`, async () => {

		const s: Segment[] = [['problems = 99', undefined, 0]];
		expect(toString(s)).toBe('problems = 99');

		replaceSourceRange(s, undefined, 0, 8, 'answer');
		expect(toString(s)).toBe('answer = 99');
		expect(s).toEqual(['answer', [' = 99', undefined, 8]]);

		replaceSourceRange(s, undefined, 11, 13, '42');
		expect(toString(s)).toBe('answer = 42');
		expect(s).toEqual(['answer', [' = ', undefined, 8], '42']);

		s.unshift('var ');
		s.push(';');
		expect(toString(s)).toBe('var answer = 42;');
		expect(s).toEqual(['var ', 'answer', [' = ', undefined, 8], '42', ';']);
	});
});
