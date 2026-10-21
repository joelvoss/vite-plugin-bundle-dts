import { describe, expect, it } from 'vitest';

import { createFilter } from '../src/utils/filter';

describe('filter utils', () => {
	it('matches include globs', () => {
		const filter = createFilter('src/**/*.ts', undefined);

		expect(filter('src/index.ts')).toBe(true);
		expect(filter('src/nested/value.ts')).toBe(true);
		expect(filter('src/nested/deeper/value.ts')).toBe(true);
		expect(filter('test/index.ts')).toBe(false);
		expect(filter('src/index.js')).toBe(false);
	});

	it.each(['src/*.ts', 'src/*'])(
		'matches single stars without crossing separators: %s',
		(pattern) => {
			const filter = createFilter(pattern, undefined);

			expect(filter('src/index.ts')).toBe(true);
			expect(filter('src/.ts')).toBe(true);
			expect(filter('src/index.js')).toBe(pattern === 'src/*');
			expect(filter('src/README')).toBe(pattern === 'src/*');
			expect(filter('src/nested/index.ts')).toBe(false);
			expect(filter('src-prefix/index.ts')).toBe(false);
			expect(filter('other/src/index.ts')).toBe(false);
			expect(filter('src/index.ts/extra')).toBe(false);
		},
	);

	it('preserves the literal suffix after a single star', () => {
		const filter = createFilter('src/*.ts', undefined);

		expect(filter('src/index.ts')).toBe(true);
		expect(filter('src/index.js')).toBe(false);
		expect(filter('src/indexxts')).toBe(false);
		expect(filter('src/index.tsx')).toBe(false);
	});

	it('applies single-star excludes only within their directory', () => {
		const filter = createFilter('src/**/*.ts', 'src/*.test.ts');

		expect(filter('src/index.ts')).toBe(true);
		expect(filter('src/index.test.ts')).toBe(false);
		expect(filter('src/.test.ts')).toBe(false);
		expect(filter('src/nested/index.test.ts')).toBe(true);
	});

	it('matches globstars with zero or more directory segments', () => {
		const filter = createFilter('**/*.ts', undefined);

		expect(filter('index.ts')).toBe(true);
		expect(filter('src/index.ts')).toBe(true);
		expect(filter('src/nested/deeper/index.ts')).toBe(true);
		expect(filter('/index.ts')).toBe(true);
		expect(filter('/workspace/src/index.ts')).toBe(true);
		expect(filter('src/index.js')).toBe(false);
		expect(filter('src/index.tsx')).toBe(false);
		expect(filter('src/index.ts/extra')).toBe(false);
	});

	it('matches trailing globstars recursively', () => {
		const filter = createFilter('src/**', undefined);

		expect(filter('src/index.ts')).toBe(true);
		expect(filter('src/nested/deeper/index.ts')).toBe(true);
		expect(filter('src-prefix/index.ts')).toBe(false);
		expect(filter('other/src/index.ts')).toBe(false);
	});

	it.each(['src/**.ts', 'src/i**.ts'])(
		'only treats a complete segment as a globstar: %s',
		(pattern) => {
			const filter = createFilter(pattern, undefined);

			expect(filter('src/index.ts')).toBe(true);
			expect(filter('src/index/nested.ts')).toBe(false);
		},
	);

	it('matches question marks as exactly one nonseparator character', () => {
		const filter = createFilter('src/file?.ts', undefined);

		expect(filter('src/file1.ts')).toBe(true);
		expect(filter('src/filea.ts')).toBe(true);
		expect(filter('src/file.ts')).toBe(false);
		expect(filter('src/file12.ts')).toBe(false);
		expect(filter('src/file/.ts')).toBe(false);
		expect(filter('src/file1.tsx')).toBe(false);
	});

	it.each(['|', '{', '}', '(', ')', '[', ']', '^', '$', '+', '.'])(
		'preserves literal regexp metacharacters: %s',
		(metacharacter) => {
			const filter = createFilter(`src/file${metacharacter}.ts`, undefined);

			expect(filter(`src/file${metacharacter}.ts`)).toBe(true);
			expect(filter('src/file.ts')).toBe(false);
			expect(filter('src/filex.ts')).toBe(false);
		},
	);

	it('matches absolute paths without losing the root or directory boundaries', () => {
		const filter = createFilter('/workspace/src/*.ts', undefined);
		const recursiveFilter = createFilter('/workspace/src/**/*.ts', undefined);

		expect(filter('/workspace/src/index.ts')).toBe(true);
		expect(filter('workspace/src/index.ts')).toBe(false);
		expect(filter('/other/workspace/src/index.ts')).toBe(false);
		expect(filter('/workspace/src/nested/index.ts')).toBe(false);
		expect(recursiveFilter('/workspace/src/index.ts')).toBe(true);
		expect(recursiveFilter('/workspace/src/nested/deeper/index.ts')).toBe(true);
		expect(recursiveFilter('/workspace/src-prefix/index.ts')).toBe(false);
	});

	it('normalizes Windows separators in patterns and ids', () => {
		const filter = createFilter(
			'C:\\workspace\\src\\*.ts',
			'C:\\workspace\\src\\*.test.ts',
		);
		const recursiveFilter = createFilter(
			'C:\\workspace\\src\\**\\?.ts',
			undefined,
		);

		expect(filter('C:\\workspace\\src\\index.ts')).toBe(true);
		expect(filter('C:/workspace/src/index.ts')).toBe(true);
		expect(filter('C:\\workspace\\src\\index.test.ts')).toBe(false);
		expect(filter('C:/workspace/src/index.test.ts')).toBe(false);
		expect(filter('C:\\workspace\\src\\nested\\index.ts')).toBe(false);
		expect(filter('D:\\workspace\\src\\index.ts')).toBe(false);
		expect(recursiveFilter('C:\\workspace\\src\\a.ts')).toBe(true);
		expect(recursiveFilter('C:/workspace/src/nested/deeper/a.ts')).toBe(true);
		expect(recursiveFilter('C:\\workspace\\src\\ab.ts')).toBe(false);
	});

	it('supports regexp patterns', () => {
		const filter = createFilter(/^src\/.*\.ts$/u, undefined);

		expect(filter('src/index.ts')).toBe(true);
		expect(filter('src/index.js')).toBe(false);
	});

	it('supports regexp includes and excludes against normalized paths', () => {
		const filter = createFilter(/^src\/.*\.ts$/u, /^src\/.*\.test\.ts$/u);

		expect(filter('src\\index.ts')).toBe(true);
		expect(filter('src\\nested\\index.test.ts')).toBe(false);
		expect(filter('other\\index.ts')).toBe(false);
	});

	it('applies exclude patterns after includes', () => {
		const filter = createFilter(
			['src/**/*.ts', 'test/**/*.ts'],
			['src/**/ignored.ts', /test\/skip/u],
		);

		expect(filter('src/feature/index.ts')).toBe(true);
		expect(filter('src/ignored.ts')).toBe(false);
		expect(filter('src/feature/ignored.ts')).toBe(false);
		expect(filter('src/feature/deeper/ignored.ts')).toBe(false);
		expect(filter('src/feature/not-ignored.ts')).toBe(true);
		expect(filter('src/ignored.ts/index.ts')).toBe(true);
		expect(filter('test/skip/example.ts')).toBe(false);
	});
});
