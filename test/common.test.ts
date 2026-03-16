import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import {
	ensureAbsolute,
	ensureArray,
	isNativeObject,
	isPromise,
	isRegExp,
	normalizePath,
	resolvePath,
	runParallel,
	slash,
	unwrapPromise,
} from '../src/utils/common';

describe('common utils', () => {
	it('normalizes windows-style slashes', () => {
		expect(slash('foo\\bar\\baz')).toBe('foo/bar/baz');
		expect(normalizePath('foo\\bar/../baz')).toBe('foo/baz');
	});

	it('resolves and absolutizes paths', () => {
		expect(resolvePath('/repo', 'src', 'index.ts')).toBe('/repo/src/index.ts');
		expect(ensureAbsolute('src/index.ts', '/repo')).toBe('/repo/src/index.ts');
		expect(ensureAbsolute('/repo/src/index.ts', '/other')).toBe(
			'/repo/src/index.ts',
		);
		expect(ensureAbsolute(undefined, '/repo')).toBe('/repo');
	});

	it('coerces values into arrays', () => {
		expect(ensureArray('value')).toEqual(['value']);
		expect(ensureArray(['value'])).toEqual(['value']);
		expect(ensureArray(null)).toEqual([]);
		expect(ensureArray(undefined)).toEqual([]);
	});

	it('detects native objects, regexes, and promises', async () => {
		const thenable = Reflect.construct(Function, [
			'this.then = () => {}; return this;',
		])() as {
			then: () => void;
		};

		expect(isNativeObject({ a: 1 })).toBe(true);
		expect(isNativeObject([1, 2, 3])).toBe(false);
		expect(isRegExp(/test/u)).toBe(true);
		expect(isRegExp('test')).toBe(false);
		expect(isPromise(Promise.resolve('value'))).toBe(true);
		expect(isPromise(thenable)).toBe(true);
		expect(isPromise('value')).toBe(false);
		await expect(unwrapPromise(Promise.resolve('value'))).resolves.toBe(
			'value',
		);
		await expect(unwrapPromise('value')).resolves.toBe('value');
	});

	it('limits runParallel concurrency and processes every item', async () => {
		let activeCount = 0;
		let maxActiveCount = 0;
		const visited: number[] = [];

		await runParallel(2, [1, 2, 3, 4], async (item) => {
			activeCount += 1;
			maxActiveCount = Math.max(maxActiveCount, activeCount);
			visited.push(item);
			await delay(10);
			activeCount -= 1;
		});

		expect(maxActiveCount).toBeLessThanOrEqual(2);
		expect(visited.sort()).toEqual([1, 2, 3, 4]);
	});
});
