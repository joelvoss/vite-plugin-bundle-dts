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
});
