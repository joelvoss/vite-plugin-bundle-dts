import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { PathAlias } from '../src/types';
import {
	ctjsRE,
	extPrefix,
	findTypesPath,
	fullRelativeRE,
	importResolves,
	isAliasGlobal,
	isAliasMatch,
	mtjsRE,
	normalizeGlob,
	parseTsAliases,
	queryPublicPath,
	removeDirIfEmpty,
	toCapitalCase,
	toEntryMap,
	transformAlias,
	tryGetPkgPath,
	tsRE,
	tsToDts,
} from '../src/utils/path';

const tempRoots: string[] = [];

async function createTempRoot(): Promise<string> {
	const root = await mkdtemp(resolve(tmpdir(), 'vite-plugin-bundle-dts-path-'));
	tempRoots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(
		tempRoots
			.splice(0)
			.map((root) => rm(root, { recursive: true, force: true })),
	);
});

describe('path utils', () => {
	it('finds the shared public path', () => {
		expect(queryPublicPath([])).toBe('');
		expect(queryPublicPath(['/repo/src/index.ts'])).toBe('/repo/src');
		expect(
			queryPublicPath([
				'/repo/src/index.ts',
				'/repo/src/nested/util.ts',
				'/repo/src/types.ts',
			]),
		).toBe('/repo/src');
	});

	it('removes directories only when they contain no files', async () => {
		const root = await createTempRoot();
		const emptyDir = resolve(root, 'empty/nested');
		await mkdir(emptyDir, { recursive: true });

		expect(removeDirIfEmpty(resolve(root, 'empty'))).toBe(true);

		const nonEmptyDir = resolve(root, 'non-empty');
		await mkdir(nonEmptyDir, { recursive: true });
		await writeFile(resolve(nonEmptyDir, 'file.txt'), 'value', 'utf8');

		expect(removeDirIfEmpty(nonEmptyDir)).toBe(false);
	});

	it('parses tsconfig aliases and identifies global aliases', () => {
		const aliases = parseTsAliases('/repo', {
			'@/*': ['src/*'],
			'*': ['generated/*'],
		});

		expect(aliases).toHaveLength(2);
		expect(aliases[0]?.replacement).toBe('/repo/src/$1');
		expect(isAliasGlobal(aliases[1] as PathAlias)).toBe(true);
	});

	it('matches aliases for both string and regexp forms', () => {
		expect(
			isAliasMatch({ find: '@/', replacement: '/repo/src/' }, '@/types'),
		).toBe(true);
		expect(
			isAliasMatch({ find: '@/', replacement: '/repo/src/' }, '~/types'),
		).toBe(false);
		expect(
			isAliasMatch({ find: /^~\//u, replacement: '/repo/src/' }, '~/types'),
		).toBe(true);
	});

	it('resolves import paths for known extensions', async () => {
		const root = await createTempRoot();
		const moduleBase = resolve(root, 'src/module');
		await mkdir(dirname(moduleBase), { recursive: true });
		await writeFile(`${moduleBase}.ts`, 'export {}', 'utf8');

		expect(importResolves(moduleBase)).toBe(true);
		expect(importResolves(resolve(root, 'missing/module'))).toBe(false);
	});

	it('transforms aliases and honors exclusions', async () => {
		const root = await createTempRoot();
		await mkdir(resolve(root, 'src'), { recursive: true });
		await writeFile(
			resolve(root, 'src/types.ts'),
			'export interface Example {}',
			'utf8',
		);

		const aliases: PathAlias[] = [
			{ find: '@/', replacement: resolve(root, 'src') + '/' },
		];
		expect(transformAlias('@/types', resolve(root, 'src'), aliases, [])).toBe(
			'./types',
		);
		expect(
			transformAlias('@/types', resolve(root, 'src'), aliases, ['@/types']),
		).toBe('@/types');

		const globalAlias: PathAlias[] = parseTsAliases(root, { '*': ['src/*'] });
		expect(transformAlias('types', resolve(root, 'src'), globalAlias, [])).toBe(
			'./types',
		);
		expect(
			transformAlias('missing', resolve(root, 'src'), globalAlias, []),
		).toBe('missing');
	});

	it('normalizes glob suffixes', () => {
		expect(normalizeGlob('src')).toBe('src/**');
		expect(normalizeGlob('src/')).toBe('src/**');
		expect(normalizeGlob('src/**/*.ts')).toBe('src/**/*.ts');
	});

	it('finds the nearest package.json when walking upward', async () => {
		const root = await createTempRoot();
		const nestedDir = resolve(root, 'packages/demo/src');
		await mkdir(nestedDir, { recursive: true });
		await writeFile(resolve(root, 'packages/demo/package.json'), '{}', 'utf8');

		expect(tryGetPkgPath(nestedDir)).toBe(
			resolve(root, 'packages/demo/package.json'),
		);
	});

	it('formats names and type paths helpers', () => {
		expect(toCapitalCase('my plugin name')).toBe('MyPluginName');
		expect(
			findTypesPath({ exports: { '.': { types: 'dist/index.d.ts' } } }),
		).toBe('dist/index.d.ts');
		expect(extPrefix('index.mts')).toBe('m');
		expect(extPrefix('index.cts')).toBe('c');
		expect(extPrefix('index.ts')).toBe('');
		expect(tsToDts('src/index.ts')).toBe('src/index.d.ts');
		expect(toEntryMap('src/index.ts')).toEqual({ 'index.ts': 'src/index.ts' });
		expect(toEntryMap(['src/index.ts', 'src/extra.ts'])).toEqual({
			'extra.ts': 'src/extra.ts',
			'index.ts': 'src/index.ts',
		});
		expect(toEntryMap({ index: 'src/index.ts' })).toEqual({
			index: 'src/index.ts',
		});
		expect(fullRelativeRE.test('./file')).toBe(true);
		expect(mtjsRE.test('file.mts')).toBe(true);
		expect(ctjsRE.test('file.cts')).toBe(true);
		expect(tsRE.test('file.ts')).toBe(true);
	});
});
