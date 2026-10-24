import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import dtsPlugin from '../src';
import {
	setupFixtureCleanup,
	rollupIntegrationTimeoutMs,
	expectFile,
	expectNoFile,
} from './integration-helpers';

const { runFixtureBuild } = setupFixtureCleanup();

describe('plugin hooks', () => {
	it('invokes afterDiagnostic with reported diagnostics', async () => {
		const receivedDiagnostics: unknown[] = [];

		await runFixtureBuild('diagnostics-basic', (fixtureRoot) => ({
			build: {
				lib: {
					entry: resolve(fixtureRoot, 'src/index.ts'),
					name: 'DiagnosticsBasicFixture',
					fileName: 'index',
				},
			},
			plugins: [
				dtsPlugin({
					declarationOnly: true,
					afterDiagnostic(diagnostics) {
						receivedDiagnostics.push(...diagnostics);
					},
				}),
			],
		}));

		expect(receivedDiagnostics.length).toBeGreaterThan(0);
	});

	it('lets beforeWriteFile redirect the output path and content', async () => {
		const seenFiles: string[] = [];

		const root = await runFixtureBuild('hooks-basic', (fixtureRoot) => ({
			build: {
				lib: {
					entry: resolve(fixtureRoot, 'src/index.ts'),
					name: 'HooksBasicFixture',
					fileName: 'index',
				},
			},
			plugins: [
				dtsPlugin({
					declarationOnly: true,
					beforeWriteFile(filePath, content) {
						seenFiles.push(filePath);
						if (filePath.endsWith('index.d.ts')) {
							return {
								filePath: filePath.replace('index.d.ts', 'renamed.d.ts'),
								content: `${content}\n// rewritten by beforeWriteFile\n`,
							};
						}
						return undefined;
					},
				}),
			],
		}));

		expect(seenFiles.some((filePath) => filePath.endsWith('index.d.ts'))).toBe(
			true,
		);

		const renamedDts = resolve(root, 'dist/renamed.d.ts');
		await expectFile(renamedDts);
		await expectNoFile(resolve(root, 'dist/index.d.ts'));

		const renamedContent = await readFile(renamedDts, 'utf8');
		expect(renamedContent).toContain('// rewritten by beforeWriteFile');
	});

	it('lets beforeWriteFile suppress a write by returning false', async () => {
		const root = await runFixtureBuild('hooks-basic', (fixtureRoot) => ({
			build: {
				lib: {
					entry: resolve(fixtureRoot, 'src/index.ts'),
					name: 'HooksBasicSuppressFixture',
					fileName: 'index',
				},
			},
			plugins: [
				dtsPlugin({
					declarationOnly: true,
					beforeWriteFile(filePath) {
						if (filePath.endsWith('index.d.ts')) {
							return false;
						}
						return undefined;
					},
				}),
			],
		}));

		await expectNoFile(resolve(root, 'dist/index.d.ts'));
	});

	it('invokes afterBuild with the emitted file map', async () => {
		let emitted: ReadonlyMap<string, string> | undefined;

		const root = await runFixtureBuild('hooks-basic', (fixtureRoot) => ({
			build: {
				lib: {
					entry: resolve(fixtureRoot, 'src/index.ts'),
					name: 'HooksBasicAfterBuildFixture',
					fileName: 'index',
				},
			},
			plugins: [
				dtsPlugin({
					declarationOnly: true,
					afterBuild(emittedFiles) {
						emitted = emittedFiles;
					},
				}),
			],
		}));

		expect(emitted).toBeDefined();
		const indexDts = resolve(root, 'dist/index.d.ts');
		expect(emitted?.has(indexDts)).toBe(true);
		expect(emitted?.get(indexDts)).toContain('export interface Shape');
	});

	it(
		'invokes afterRollup when rollupTypes is enabled',
		async () => {
			let rollupResult: unknown;

			await runFixtureBuild('rollup-types', (fixtureRoot) => ({
				build: {
					lib: {
						entry: resolve(fixtureRoot, 'src/index.ts'),
						name: 'AfterRollupFixture',
						fileName: 'index',
					},
				},
				plugins: [
					dtsPlugin({
						declarationOnly: true,
						rollupTypes: true,
						afterRollup(result) {
							rollupResult = result;
						},
					}),
				],
			}));

			expect(rollupResult).toBeDefined();
		},
		rollupIntegrationTimeoutMs,
	);

	it('rejects writes outside the output directory when strictOutput is enabled', async () => {
		const root = await runFixtureBuild('hooks-basic', (fixtureRoot) => ({
			build: {
				lib: {
					entry: resolve(fixtureRoot, 'src/index.ts'),
					name: 'StrictOutputFixture',
					fileName: 'index',
				},
			},
			plugins: [
				dtsPlugin({
					declarationOnly: true,
					strictOutput: true,
					beforeWriteFile(filePath, content) {
						if (filePath.endsWith('index.d.ts')) {
							return {
								filePath: resolve(dirname(filePath), '../escaped.d.ts'),
								content,
							};
						}
						return undefined;
					},
				}),
			],
		}));

		await expectNoFile(resolve(root, 'escaped.d.ts'));
		await expectNoFile(resolve(root, 'dist/index.d.ts'));
	});

	it('allows writes outside the output directory when strictOutput is disabled', async () => {
		const root = await runFixtureBuild('hooks-basic', (fixtureRoot) => ({
			build: {
				lib: {
					entry: resolve(fixtureRoot, 'src/index.ts'),
					name: 'StrictOutputDisabledFixture',
					fileName: 'index',
				},
			},
			plugins: [
				dtsPlugin({
					declarationOnly: true,
					strictOutput: false,
					beforeWriteFile(filePath, content) {
						if (filePath.endsWith('index.d.ts')) {
							return {
								filePath: resolve(dirname(filePath), '../escaped.d.ts'),
								content,
							};
						}
						return undefined;
					},
				}),
			],
		}));

		await expectFile(resolve(root, 'escaped.d.ts'));
	});
});
