import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { build } from 'vite';
import { describe, expect, it } from 'vitest';

import dtsPlugin from '../src';
import {
	setupFixtureCleanup,
	expectFile,
	expectNoFile,
} from './integration-helpers';

const { createFixtureWorkspace, runFixtureBuild } = setupFixtureCleanup();

describe('fixture integration', () => {
	it('builds a single-entry library with alias rewriting and json declarations', async () => {
		const root = await runFixtureBuild('single-entry-json', (fixtureRoot) => ({
			resolve: {
				alias: {
					'@': resolve(fixtureRoot, 'src'),
				},
			},
			build: {
				lib: {
					entry: resolve(fixtureRoot, 'src/index.ts'),
					name: 'SingleEntryJson',
					fileName: 'index',
				},
			},
			plugins: [
				dtsPlugin({
					insertTypesEntry: true,
					declarationOnly: true,
				}),
			],
		}));

		const distIndex = resolve(root, 'dist/index.d.ts');
		const distJson = resolve(root, 'dist/data.json.d.ts');

		await expectFile(distIndex);
		await expectFile(distJson);

		const indexContent = await readFile(distIndex, 'utf8');
		const jsonContent = await readFile(distJson, 'utf8');

		expect(indexContent).toContain("export type { Example } from './types';");
		expect(indexContent).toContain(
			"export { default as data } from './data.json';",
		);
		expect(jsonContent).toContain('declare const _default:');
		expect(jsonContent).toContain('"label": "fixture"');
	});

	it('builds a multi-entry library and emits declarations for each entry', async () => {
		const root = await runFixtureBuild('multi-entry', (fixtureRoot) => ({
			build: {
				lib: {
					entry: {
						index: resolve(fixtureRoot, 'src/index.ts'),
						extra: resolve(fixtureRoot, 'src/extra.ts'),
					},
					name: 'MultiEntryFixture',
					fileName: 'index',
				},
			},
			plugins: [
				dtsPlugin({
					declarationOnly: true,
				}),
			],
		}));

		const indexDts = resolve(root, 'dist/index.d.ts');
		const extraDts = resolve(root, 'dist/extra.d.ts');

		await expectFile(indexDts);
		await expectFile(extraDts);

		const indexContent = await readFile(indexDts, 'utf8');
		const extraContent = await readFile(extraDts, 'utf8');

		expect(indexContent).toContain("export { extraValue } from './extra';");
		expect(extraContent).toContain('export declare const extraValue = 42;');
	});

	it('writes a custom package types shim when insertTypesEntry is enabled', async () => {
		const root = await runFixtureBuild('insert-types-entry', (fixtureRoot) => ({
			build: {
				lib: {
					entry: resolve(fixtureRoot, 'src/index.ts'),
					name: 'InsertTypesFixture',
					fileName: 'main',
				},
			},
			plugins: [
				dtsPlugin({
					declarationOnly: true,
					insertTypesEntry: true,
				}),
			],
		}));

		const entryDts = resolve(root, 'dist/index.d.ts');
		const shimDts = resolve(root, 'dist/types/entry.d.ts');

		await expectFile(entryDts);
		await expectFile(shimDts);

		const shimContent = await readFile(shimDts, 'utf8');
		expect(shimContent).toContain("export * from '../index'");
		expect(shimContent).toContain('export default InsertTypesFixture');
	});
});

describe('filter integration', () => {
	it.each([false, true])(
		'honors single-star includes with test-file exclusion set to %s',
		async (excludeTestFiles) => {
			const root = await createFixtureWorkspace('hooks-basic');
			await writeFile(
				resolve(root, 'src/index.test.ts'),
				'export const testValue = 42;\n',
				'utf8',
			);

			await build({
				configFile: false,
				root,
				logLevel: 'silent',
				build: {
					lib: {
						entry: resolve(root, 'src/index.ts'),
						name: 'SingleStarFilterFixture',
						fileName: 'index',
					},
				},
				plugins: [
					dtsPlugin({
						declarationOnly: true,
						include: ['src/*.ts'],
						exclude: excludeTestFiles ? ['src/*.test.ts'] : undefined,
					}),
				],
			});

			await expectFile(resolve(root, 'dist/index.d.ts'));
			const testDeclaration = resolve(root, 'dist/index.test.d.ts');
			if (excludeTestFiles) {
				await expectNoFile(testDeclaration);
			} else {
				await expectFile(testDeclaration);
			}
		},
	);
});
