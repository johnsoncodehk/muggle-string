import { describe, expect, it } from 'vitest';
import { binarySearch } from '../out/binarySearch';

describe('binarySearch', async () => {

	it('search', async () => {
		expect(binarySearch([0, 5, 10], -1)).toEqual(0);
		expect(binarySearch([0, 5, 10], 0)).toEqual(0);
		expect(binarySearch([0, 5, 10], 1)).toEqual(0);
		expect(binarySearch([0, 5, 10], 4)).toEqual(0);
		expect(binarySearch([0, 5, 10], 5)).toEqual(1);
		expect(binarySearch([0, 5, 10], 6)).toEqual(1);
		expect(binarySearch([0, 5, 10], 9)).toEqual(1);
		expect(binarySearch([0, 5, 10], 10)).toEqual(2);
		expect(binarySearch([0, 5, 10], 11)).toEqual(2);
	});
});
