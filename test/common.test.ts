import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

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

const execFileAsync = promisify(execFile);
const commonSourceUrl = new URL('../src/utils/common.ts', import.meta.url).href;

async function runParallelInSubprocess(body: string) {
	return execFileAsync(
		process.execPath,
		[
			'--unhandled-rejections=strict',
			'--experimental-strip-types',
			'--input-type=module',
			'--eval',
			`
				import assert from 'node:assert/strict';
				import { setImmediate } from 'node:timers/promises';
				import { runParallel } from ${JSON.stringify(commonSourceUrl)};
				${body}
				await setImmediate();
			`,
		],
		{ timeout: 10_000 },
	);
}

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

	it.each([1, 2, 0, -1])(
		'processes every item with runParallel concurrency %i',
		async (maxConcurrency) => {
			let activeCount = 0;
			let maxActiveCount = 0;
			const visited: number[] = [];

			await runParallel(maxConcurrency, [1, 2, 3, 4], async (item, source) => {
				expect(source).toEqual([1, 2, 3, 4]);
				activeCount += 1;
				maxActiveCount = Math.max(maxActiveCount, activeCount);
				visited.push(item);
				await delay(10);
				activeCount -= 1;
			});

			expect(maxActiveCount).toBe(maxConcurrency > 0 ? maxConcurrency : 4);
			expect(activeCount).toBe(0);
			expect(visited.sort()).toEqual([1, 2, 3, 4]);
		},
	);

	it('resolves runParallel with an empty source', async () => {
		for (const maxConcurrency of [1, 0, -1]) {
			await expect(
				runParallel(maxConcurrency, [], async () => {
					throw new Error('an empty source must not schedule tasks');
				}),
			).resolves.toBeUndefined();
		}
	});

	it.each(
		[1, 2, 0, -1].flatMap((maxConcurrency) =>
			[false, true].map((asynchronous) => ({ maxConcurrency, asynchronous })),
		),
	)(
		'propagates failures safely with concurrency $maxConcurrency and asynchronous=$asynchronous',
		async ({ maxConcurrency, asynchronous }) => {
			await expect(
				runParallelInSubprocess(`
					const failure = new Error('task failed');
					const iterator = ${asynchronous}
						? async () => {
							await Promise.resolve();
							throw failure;
						}
						: () => { throw failure; };
					await assert.rejects(
						runParallel(${maxConcurrency}, [1], iterator),
						(error) => error === failure,
					);
				`),
			).resolves.toHaveProperty('stdout', '');
		},
	);

	it('preserves failure when a successful task wins the concurrency race', async () => {
		await expect(
			runParallelInSubprocess(`
				const failure = new Error('second task failed');
				const completed = [];
				await assert.rejects(
					runParallel(2, [1, 2], async (item) => {
						if (item === 2) throw failure;
						completed.push(item);
					}),
					(error) => error === failure,
				);
				assert.deepEqual(completed, [1]);
			`),
		).resolves.toHaveProperty('stdout', '');
	});

	it('propagates failure after earlier tasks finish and free concurrency slots', async () => {
		await expect(
			runParallelInSubprocess(`
				const failure = new Error('pending task failed');
				const completed = [];
				let release;
				const gate = new Promise((resolve) => { release = resolve; });
				await assert.rejects(
					runParallel(2, [1, 2, 3], async (item) => {
						if (item === 2) {
							await gate;
							throw failure;
						}
						completed.push(item);
						if (item === 3) release();
					}),
					(error) => error === failure,
				);
				assert.deepEqual(completed, [1, 3]);
			`),
		).resolves.toHaveProperty('stdout', '');
	});

	it.each([3, 5, 0, -1])(
		'observes later failures from already-scheduled tasks with concurrency %i',
		async (maxConcurrency) => {
			await expect(
				runParallelInSubprocess(`
					const firstFailure = new Error('first task failed');
					const laterFailure = new Error('already-scheduled tasks failed');
					const started = [];
					let rejectLater;
					const later = new Promise((_, reject) => { rejectLater = reject; });
					await assert.rejects(
						runParallel(${maxConcurrency}, [1, 2, 3, 4], async (item) => {
							started.push(item);
							if (item === 1) {
								await setImmediate();
								throw firstFailure;
							}
							await later;
						}),
						(error) => error === firstFailure,
					);
					assert.deepEqual(started, ${maxConcurrency === 3 ? '[1, 2, 3]' : '[1, 2, 3, 4]'});
					rejectLater(laterFailure);
				`),
			).resolves.toHaveProperty('stdout', '');
		},
	);
});
