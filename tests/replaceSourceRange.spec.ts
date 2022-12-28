import { describe, expect, it } from 'vitest';
import { replaceSourceRange, toString, Segment } from '../out';

describe('replace source range', async () => {

	it(`problems = 99 -> var answer = 42;`, async () => {

		const s: Segment[] = [['problems = 99', undefined, 0]];

		expect(replaceSourceRange(s, undefined, 0, 8, 'answer')).toBe(true);
		expect(s).toEqual([
			'answer',
			[' = 99', undefined, 8],
		]);

		expect(replaceSourceRange(s, undefined, 11, 13, '42')).toBe(true);
		expect(s).toEqual([
			'answer',
			[' = ', undefined, 8],
			'42',
		]);

		s.unshift('var ');
		s.push(';');
		expect(s).toEqual([
			'var ',
			'answer',
			[' = ', undefined, 8],
			'42',
			';'],
		);

		expect(toString(s)).toBe('var answer = 42;');
	});

	it(`problems = 99 (fail replaces)`, async () => {

		const s: Segment[] = [['problems = 99', undefined, 0]];

		expect(replaceSourceRange(s, undefined, -1, 0)).toBe(false);
		expect(replaceSourceRange(s, undefined, -1, 1)).toBe(false);
		expect(replaceSourceRange(s, undefined, 0, 14)).toBe(false);
		expect(replaceSourceRange(s, undefined, 13, 14)).toBe(false);
		expect(replaceSourceRange(s, undefined, 14, 15)).toBe(false);

		// final
		expect(replaceSourceRange(s, undefined, 1, 12)).toBe(true);
		expect(s).toEqual([
			['p', undefined, 0],
			['9', undefined, 12],
		]);
		expect(toString(s)).toBe('p9');
	});
});
