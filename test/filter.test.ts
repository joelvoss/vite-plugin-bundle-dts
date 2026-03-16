import { describe, expect, it } from 'vitest';

import { createFilter } from '../src/utils/filter';

describe('filter utils', () => {
	it('matches include globs', () => {
		const filter = createFilter('src/**/*.ts', undefined);

		expect(filter('src/index.ts')).toBe(true);
		expect(filter('src/nested/value.ts')).toBe(true);
		expect(filter('test/index.ts')).toBe(false);
	});

	it('supports regexp patterns', () => {
		const filter = createFilter(/^src\/.*\.ts$/u, undefined);

		expect(filter('src/index.ts')).toBe(true);
		expect(filter('src/index.js')).toBe(false);
	});

	it('applies exclude patterns after includes', () => {
		const filter = createFilter(
			['src/**/*.ts', 'test/**/*.ts'],
			['src/**/ignored.ts', /test\/skip/u],
		);

		expect(filter('src/feature/index.ts')).toBe(true);
		expect(filter('src/feature/ignored.ts')).toBe(false);
		expect(filter('test/skip/example.ts')).toBe(false);
	});
});
