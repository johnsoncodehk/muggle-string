import { describe, expect, it } from 'vitest';
import { create, update, toString, Segment } from '../';

describe('update', async () => {

	it(`problems = 99 -> var answer = 42;`, async () => {

		const s: Segment[] = ['problems = 99'];
		expect(toString(s)).toBe('problems = 99');

		update(s, 0, 8, 'answer');
		expect(toString(s)).toBe('answer = 99');

		update(s, 9, 11, '42');
		expect(toString(s)).toBe('answer = 42');

		s.unshift('var ');
		s.push(';');
		expect(toString(s)).toBe('var answer = 42;');
	});

	it(`problems = 99 -> problems - 99`, async () => {

		const s: Segment[] = ['problems = 99'];
		expect(toString(s)).toBe('problems = 99');

		update(s, 9, 10, '-');
		expect(toString(s)).toBe('problems - 99');
	});

	it(`problems = 99 -> problems+99`, async () => {

		const s: Segment[] = ['problems = 99'];
		expect(toString(s)).toBe('problems = 99');

		update(s, 9, 10, ['-', undefined, 123]);
		expect(s).toEqual(['problems ', ['-', undefined, 123], ' 99']);
		expect(toString(s)).toBe('problems - 99');

		update(s, 8, 11, ['+', undefined, 123]);
		expect(s).toEqual(['problems', ['+', undefined, 123], '99']);
		expect(toString(s)).toBe('problems+99');
	});

	it(`problems = 99 -> problems+99`, async () => {

		const s: Segment[] = ['problems = 99'];
		expect(toString(s)).toBe('problems = 99');

		update(s, 9, 10, ['-', undefined, 123]);
		expect(s).toEqual(['problems ', ['-', undefined, 123], ' 99']);
		expect(toString(s)).toBe('problems - 99');

		update(s, 8, 11, ['+', undefined, 123]);
		expect(s).toEqual(['problems', ['+', undefined, 123], '99']);
		expect(toString(s)).toBe('problems+99');
	});

	it(`problems = 99 -> var answer = 42; (with mapping)`, async () => {

		const s = create('problems = 99');
		expect(s).toEqual([['problems = 99', undefined, 0]]);
		expect(toString(s)).toBe('problems = 99');

		update(s, 0, 8, 'answer');
		expect(s).toEqual(['answer', [' = 99', undefined, 8]]);
		expect(toString(s)).toBe('answer = 99');

		update(s, 9, 11, '42');
		expect(s).toEqual(['answer', [' = ', undefined, 8], '42']);
		expect(toString(s)).toBe('answer = 42');
	});

	it(`problems = 99 -> problems+99 (with mapping)`, async () => {

		const s = create('problems = 99');
		expect(s).toEqual([['problems = 99', undefined, 0]]);
		expect(toString(s)).toBe('problems = 99');

		update(s, 9, 10, ['-', undefined, 123]);
		expect(s).toEqual([['problems ', undefined, 0], ['-', undefined, 123], [' 99', undefined, 10]]);
		expect(toString(s)).toBe('problems - 99');

		update(s, 8, 11, ['+', undefined, 123]);
		expect(s).toEqual([['problems', undefined, 0], ['+', undefined, 123], ['99', undefined, 11]]);
		expect(toString(s)).toBe('problems+99');
	});
});
