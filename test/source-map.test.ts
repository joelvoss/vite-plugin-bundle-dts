import { describe, expect, it } from 'vitest';

import { editSourceMapDir } from '../src/utils/source-map';

describe('editSourceMapDir', () => {
	it('returns true when the output directory does not change', () => {
		expect(
			editSourceMapDir(
				JSON.stringify({ sources: ['src/index.ts'] }),
				'/repo/dist',
				'/repo/dist',
			),
		).toBe(true);
	});

	it('rewrites source entries when copying to another outDir', () => {
		const updated = editSourceMapDir(
			JSON.stringify({ sources: ['../src/index.ts'], mappings: 'AAAA' }),
			'/repo/dist',
			'/repo/secondary-dist',
		);

		expect(typeof updated).toBe('string');
		expect(JSON.parse(updated as string).sources).toEqual(['../src/index.ts']);
	});

	it('returns false for invalid source maps', () => {
		expect(editSourceMapDir('{', '/repo/dist', '/repo/secondary-dist')).toBe(
			false,
		);
	});

	it('rebases nested sources from the original map directory', () => {
		const updated = editSourceMapDir(
			JSON.stringify({
				sources: ['../../src/nested/value.ts', '../../src/shared.ts'],
				mappings: 'AAAA',
			}),
			'/repo/dist/nested',
			'/repo/publish/types/nested',
		);

		expect(JSON.parse(updated as string)).toEqual({
			sources: ['../../../src/nested/value.ts', '../../../src/shared.ts'],
			mappings: 'AAAA',
		});
	});

	it('rebases nested maps when the target is outside the project root', () => {
		const updated = editSourceMapDir(
			JSON.stringify({ sources: ['../../src/nested/value.ts'] }),
			'/repo/project/dist/nested',
			'/repo/secondary/nested',
		);

		expect(JSON.parse(updated as string).sources).toEqual([
			'../../project/src/nested/value.ts',
		]);
	});

	it('rebases a relative sourceRoot without applying it twice to sources', () => {
		const updated = editSourceMapDir(
			JSON.stringify({
				sourceRoot: '../../src/',
				sources: ['nested/value.ts', 'shared.ts'],
			}),
			'/repo/dist/nested',
			'/repo/publish/types/nested',
		);

		expect(JSON.parse(updated as string)).toEqual({
			sourceRoot: '../../../src/',
			sources: ['nested/value.ts', 'shared.ts'],
		});
	});

	it.each(['/repo/src/', 'https://example.com/src/', 'file:///repo/src/'])(
		'preserves an absolute sourceRoot %s',
		(sourceRoot) => {
			const sourceMap = { sourceRoot, sources: ['nested/value.ts'] };
			const updated = editSourceMapDir(
				JSON.stringify(sourceMap),
				'/repo/dist/nested',
				'/repo/publish/types/nested',
			);

			expect(JSON.parse(updated as string)).toEqual(sourceMap);
		},
	);

	it('preserves absolute source URLs while rebasing local sources', () => {
		const updated = editSourceMapDir(
			JSON.stringify({
				sources: [
					'../../src/nested/value.ts',
					'https://example.com/src/remote.ts',
					'file:///repo/src/remote.ts',
					'//example.com/src/remote.ts',
				],
			}),
			'/repo/dist/nested',
			'/repo/publish/types/nested',
		);

		expect(JSON.parse(updated as string).sources).toEqual([
			'../../../src/nested/value.ts',
			'https://example.com/src/remote.ts',
			'file:///repo/src/remote.ts',
			'//example.com/src/remote.ts',
		]);
	});
});
