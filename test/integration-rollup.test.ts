import { cp, mkdir, mkdtemp, readFile, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { build } from 'vite';
import { describe, expect, it } from 'vitest';

import dtsPlugin from '../src';
import {
	setupFixtureCleanup,
	currentDir,
	testRequire,
	rollupIntegrationTimeoutMs,
	expectFile,
	expectNoFile,
	expectConsumerTypecheck,
} from './integration-helpers';

const { runFixtureBuild, tempRoots } = setupFixtureCleanup();

describe('fixture integration', () => {
	it(
		'rolls up declaration output and removes intermediate declaration files',
		async () => {
			const root = await runFixtureBuild('rollup-types', (fixtureRoot) => ({
				build: {
					lib: {
						entry: resolve(fixtureRoot, 'src/index.ts'),
						name: 'RollupTypesFixture',
						fileName: 'index',
					},
				},
				plugins: [
					dtsPlugin({
						declarationOnly: true,
						rollupTypes: true,
					}),
				],
			}));

			const bundledDts = resolve(root, 'dist/index.d.ts');
			const helperDts = resolve(root, 'dist/helper.d.ts');

			await expectFile(bundledDts);
			await expectNoFile(helperDts);

			const bundledContent = await readFile(bundledDts, 'utf8');
			expect(bundledContent).toContain('export declare function createMessage');
			expect(bundledContent).toContain('export declare interface MessageShape');
		},
		rollupIntegrationTimeoutMs,
	);

	it(
		'rolls up declarations with TypeScript 7 using the compatibility compiler',
		async () => {
			const { version } = JSON.parse(
				await readFile(testRequire.resolve('typescript/package.json'), 'utf8'),
			) as { version: string };
			expect(version).toMatch(/^7\./);

			const root = await runFixtureBuild('rollup-types', (fixtureRoot) => ({
				build: {
					lib: {
						entry: resolve(fixtureRoot, 'src/index.ts'),
						name: 'TypeScript7CompatibilityFixture',
						fileName: 'index',
					},
				},
				plugins: [
					dtsPlugin({
						declarationOnly: true,
						rollupTypes: true,
					}),
				],
			}));

			const bundledDts = resolve(root, 'dist/index.d.ts');
			await expectFile(bundledDts);

			const bundledContent = await readFile(bundledDts, 'utf8');
			expect(bundledContent).toContain('export declare function createMessage');
			expect(bundledContent).toContain('export declare interface MessageShape');
			expect(bundledContent).toContain('Promise<ReadonlyArray<MessageShape>>');
		},
		rollupIntegrationTimeoutMs,
	);

	it('builds declarations with the packaged plugin and TypeScript 7', async () => {
		const packageRoot = await mkdtemp(
			resolve(tmpdir(), 'vite-plugin-bundle-dts-package-'),
		);
		tempRoots.push(packageRoot);
		await cp(
			resolve(currentDir, '../package.json'),
			resolve(packageRoot, 'package.json'),
		);
		await symlink(
			resolve(currentDir, '../node_modules'),
			resolve(packageRoot, 'node_modules'),
			'dir',
		);

		await build({
			configFile: resolve(currentDir, '../vite.config.ts'),
			root: resolve(currentDir, '..'),
			logLevel: 'silent',
			build: {
				outDir: resolve(packageRoot, 'dist'),
				emptyOutDir: true,
			},
		});

		const consumerRoot = resolve(packageRoot, 'consumer');
		const consumerNodeModules = resolve(consumerRoot, 'node_modules');
		await mkdir(consumerNodeModules, { recursive: true });
		await symlink(
			packageRoot,
			resolve(consumerNodeModules, 'vite-plugin-bundle-dts'),
			'dir',
		);
		const consumerRequire = createRequire(resolve(consumerRoot, 'entry.cjs'));
		const packagedPlugin = (
			consumerRequire('vite-plugin-bundle-dts') as {
				default: typeof dtsPlugin;
			}
		).default;

		const root = await runFixtureBuild('rollup-types', (fixtureRoot) => ({
			build: {
				lib: {
					entry: resolve(fixtureRoot, 'src/index.ts'),
					name: 'PackagedPluginFixture',
					fileName: 'index',
				},
			},
			plugins: [
				packagedPlugin({
					declarationOnly: true,
					rollupTypes: true,
				}),
			],
		}));

		const bundledContent = await readFile(
			resolve(root, 'dist/index.d.ts'),
			'utf8',
		);
		expect(bundledContent).toContain('export declare function createMessage');
		expect(bundledContent).toContain('Promise<ReadonlyArray<MessageShape>>');
	}, 30000);

	it(
		'rolls up a nested package types entry and preserves its path in secondary outDirs',
		async () => {
			let emitted: ReadonlyMap<string, string> | undefined;
			const root = await runFixtureBuild(
				'insert-types-entry',
				(fixtureRoot) => ({
					build: {
						lib: {
							entry: resolve(fixtureRoot, 'src/index.ts'),
							name: 'NestedTypesRollupFixture',
							fileName: 'main',
						},
					},
					plugins: [
						dtsPlugin({
							declarationOnly: true,
							rollupTypes: true,
							outDir: ['dist', 'nested/dist-secondary'],
							afterBuild(emittedFiles) {
								emitted = emittedFiles;
							},
						}),
					],
				}),
			);

			const bundledDts = resolve(root, 'dist/types/entry.d.ts');
			const bundledContent = await readFile(bundledDts, 'utf8');
			expect(bundledContent).toContain('export declare const namedValue = 7;');
			expect(bundledContent).toContain(
				'declare function createValue(): number;',
			);
			expect(bundledContent).toContain('export default createValue;');
			expect(bundledContent).not.toMatch(/\bfrom\s+['"]\./);
			expect(Array.from(emitted?.keys() ?? [])).toEqual([bundledDts]);
			expect(emitted?.get(bundledDts)).toBe(bundledContent);

			for (const outDir of ['dist', 'nested/dist-secondary']) {
				expect(
					await readFile(resolve(root, outDir, 'types/entry.d.ts'), 'utf8'),
				).toBe(bundledContent);
				await expectNoFile(resolve(root, outDir, 'index.d.ts'));
				await expectNoFile(resolve(root, outDir, 'entry.d.ts'));
			}

			await expectConsumerTypecheck(
				root,
				[
					"import createValue, { namedValue } from '.';",
					"import createSecondaryValue, { namedValue as secondaryNamedValue } from './nested/dist-secondary/types/entry';",
					'const value: number = createValue();',
					'const literal: 7 = namedValue;',
					'const secondaryValue: number = createSecondaryValue();',
					'const secondaryLiteral: 7 = secondaryNamedValue;',
					'export { value, literal, secondaryValue, secondaryLiteral };',
				].join('\n'),
			);
		},
		rollupIntegrationTimeoutMs,
	);

	it(
		'rolls up declarations for multiple entries and cleans shared intermediates',
		async () => {
			const root = await runFixtureBuild(
				'multi-entry-rollup',
				(fixtureRoot) => ({
					build: {
						lib: {
							entry: {
								index: resolve(fixtureRoot, 'src/index.ts'),
								extra: resolve(fixtureRoot, 'src/extra.ts'),
							},
							name: 'MultiEntryRollupFixture',
							fileName: 'index',
						},
					},
					plugins: [
						dtsPlugin({
							declarationOnly: true,
							rollupTypes: true,
						}),
					],
				}),
			);

			const indexDts = resolve(root, 'dist/index.d.ts');
			const extraDts = resolve(root, 'dist/extra.d.ts');
			const sharedDts = resolve(root, 'dist/shared.d.ts');

			await expectFile(indexDts);
			await expectFile(extraDts);
			await expectNoFile(sharedDts);

			const indexContent = await readFile(indexDts, 'utf8');
			const extraContent = await readFile(extraDts, 'utf8');

			expect(indexContent).toContain('export declare const primaryLabel');
			expect(indexContent).toContain('SharedShape');
			expect(extraContent).toContain('export declare function buildExtra');
			expect(extraContent).toContain('SharedShape');
		},
		rollupIntegrationTimeoutMs,
	);

	it(
		'rolls up nested multi-entry declarations in place and tracks the exact bundle paths',
		async () => {
			let emitted: ReadonlyMap<string, string> | undefined;
			const root = await runFixtureBuild(
				'multi-entry-rollup',
				(fixtureRoot) => ({
					build: {
						lib: {
							entry: {
								'nested/index': resolve(fixtureRoot, 'src/index.ts'),
								'nested/extra': resolve(fixtureRoot, 'src/extra.ts'),
							},
							name: 'NestedMultiEntryRollupFixture',
							fileName: 'index',
						},
					},
					plugins: [
						dtsPlugin({
							declarationOnly: true,
							rollupTypes: true,
							afterBuild(emittedFiles) {
								emitted = emittedFiles;
							},
						}),
					],
				}),
			);

			const indexDts = resolve(root, 'dist/nested/index.d.ts');
			const extraDts = resolve(root, 'dist/nested/extra.d.ts');
			const indexContent = await readFile(indexDts, 'utf8');
			const extraContent = await readFile(extraDts, 'utf8');
			expect(indexContent).toContain('export declare const primaryLabel');
			expect(indexContent).toContain('export declare interface SharedShape');
			expect(extraContent).toContain('export declare function buildExtra');
			expect(extraContent).toContain('interface SharedShape');
			expect(indexContent).not.toMatch(/\bfrom\s+['"]\./);
			expect(extraContent).not.toMatch(/\bfrom\s+['"]\./);
			expect(Array.from(emitted?.keys() ?? []).sort()).toEqual([
				extraDts,
				indexDts,
			]);
			expect(emitted?.get(indexDts)).toBe(indexContent);
			expect(emitted?.get(extraDts)).toBe(extraContent);
			for (const fileName of ['index.d.ts', 'extra.d.ts', 'shared.d.ts']) {
				await expectNoFile(resolve(root, 'dist', fileName));
			}

			await expectConsumerTypecheck(
				root,
				[
					"import { primaryLabel, type SharedShape } from './dist/nested/index';",
					"import { buildExtra } from './dist/nested/extra';",
					'const shape: SharedShape = buildExtra();',
					'const label: string = primaryLabel;',
					'const enabled: boolean = shape.enabled;',
					'export { shape, label, enabled };',
				].join('\n'),
			);
		},
		rollupIntegrationTimeoutMs,
	);
});
