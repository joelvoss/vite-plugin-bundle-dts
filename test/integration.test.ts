import {
	access,
	cp,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from '@typescript/typescript6';
import { build, type InlineConfig } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';

import dtsPlugin from '../src';

const currentDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(currentDir, 'fixtures');
const testRequire = createRequire(import.meta.url);
const rollupIntegrationTimeoutMs = 15000;
const tempRoots: string[] = [];
const watchers: Array<{ close(): Promise<void> | void }> = [];

interface WatcherEvent {
	code: string;
	error?: unknown;
}

interface BuildWatcher {
	close(): Promise<void> | void;
	invalidate?(): void;
	on?(event: 'event', listener: (event: WatcherEvent) => void): void;
	off?(event: 'event', listener: (event: WatcherEvent) => void): void;
}

async function createFixtureWorkspace(name: string): Promise<string> {
	const templateRoot = resolve(fixturesDir, name);
	const tempRoot = await mkdtemp(
		resolve(tmpdir(), `vite-plugin-bundle-dts-${name}-`),
	);
	await cp(templateRoot, tempRoot, { recursive: true });
	tempRoots.push(tempRoot);
	return tempRoot;
}

async function runFixtureBuild(
	name: string,
	configFactory: (root: string) => InlineConfig,
): Promise<string> {
	const root = await createFixtureWorkspace(name);
	const config = configFactory(root);
	await build({
		configFile: false,
		root,
		logLevel: 'silent',
		...config,
	});
	return root;
}

async function expectFile(path: string): Promise<void> {
	await expect(access(path)).resolves.toBeUndefined();
}

async function expectNoFile(path: string): Promise<void> {
	await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

async function expectConsumerTypecheck(
	root: string,
	content: string,
): Promise<void> {
	const consumerPath = resolve(root, 'consumer.ts');
	await writeFile(consumerPath, content, 'utf8');
	const consumerOptions: ts.CompilerOptions = {
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		target: ts.ScriptTarget.ESNext,
		strict: true,
		noEmit: true,
		skipLibCheck: false,
		types: [],
	};
	const consumerHost = ts.createCompilerHost(consumerOptions);
	const consumerProgram = ts.createProgram({
		rootNames: [consumerPath],
		options: consumerOptions,
		host: consumerHost,
	});
	expect(
		ts.formatDiagnostics(
			ts.getPreEmitDiagnostics(consumerProgram),
			consumerHost,
		),
	).toBe('');
}

async function waitFor(
	predicate: () => Promise<boolean>,
	timeoutMs = 10000,
): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (await predicate()) {
			return;
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
	}
	throw new Error(
		`Timed out after ${timeoutMs}ms while waiting for condition.`,
	);
}

async function waitForFileContent(
	path: string,
	expectedText: string,
	timeoutMs = 10000,
): Promise<string> {
	let lastContent = '';
	await waitFor(async () => {
		try {
			lastContent = await readFile(path, 'utf8');
			return lastContent.includes(expectedText);
		} catch {
			return false;
		}
	}, timeoutMs);
	return lastContent;
}

async function waitForWatcherRebuild(
	watcher: BuildWatcher,
	timeoutMs = 15000,
): Promise<void> {
	const subscribe = watcher.on;
	if (!subscribe) {
		return;
	}

	await new Promise<void>((resolvePromise, rejectPromise) => {
		const timer = setTimeout(() => {
			watcher.off?.('event', onEvent);
			rejectPromise(
				new Error(
					`Timed out after ${timeoutMs}ms while waiting for watcher rebuild.`,
				),
			);
		}, timeoutMs);

		const onEvent = (event: WatcherEvent): void => {
			if (event.code === 'ERROR') {
				clearTimeout(timer);
				watcher.off?.('event', onEvent);
				rejectPromise(
					event.error instanceof Error
						? event.error
						: new Error(String(event.error)),
				);
				return;
			}

			if (event.code === 'BUNDLE_END' || event.code === 'END') {
				clearTimeout(timer);
				watcher.off?.('event', onEvent);
				resolvePromise();
			}
		};

		subscribe.call(watcher, 'event', onEvent);
	});
}

afterEach(async () => {
	await Promise.all(watchers.splice(0).map((watcher) => watcher.close()));
	await Promise.all(
		tempRoots
			.splice(0)
			.map((root) => rm(root, { recursive: true, force: true })),
	);
});

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
			expect(bundledContent).toContain(
				'Promise<ReadonlyArray<MessageShape>>',
			);
		},
		rollupIntegrationTimeoutMs,
	);

	it(
		'builds declarations with the packaged plugin and TypeScript 7',
		async () => {
			const packageRoot = await mkdtemp(
				resolve(tmpdir(), 'vite-plugin-bundle-dts-package-'),
			);
			tempRoots.push(packageRoot);
			await cp(resolve(currentDir, '../package.json'), resolve(packageRoot, 'package.json'));
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
			expect(bundledContent).toContain(
				'Promise<ReadonlyArray<MessageShape>>',
			);
		},
		30000,
	);

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

	it('rebuilds declaration output in watch mode after source changes', async () => {
		const root = await createFixtureWorkspace('watch-basic');
		const watcher = (await build({
			configFile: false,
			root,
			logLevel: 'silent',
			build: {
				watch: {},
				lib: {
					entry: resolve(root, 'src/index.ts'),
					name: 'WatchFixture',
					fileName: 'index',
				},
			},
			plugins: [
				dtsPlugin({
					declarationOnly: true,
				}),
			],
		})) as BuildWatcher;
		watchers.push(watcher);

		const dtsPath = resolve(root, 'dist/index.d.ts');
		const initialContent = await waitForFileContent(dtsPath, 'message', 15000);
		expect(initialContent).toContain('"one"');

		await writeFile(
			resolve(root, 'src/index.ts'),
			[
				'export const message = "two";',
				'export interface WatchState {',
				'  ready: true;',
				'}',
			].join('\n'),
			'utf8',
		);

		watcher.invalidate?.();
		await waitForWatcherRebuild(watcher);
		const rebuiltContent = await waitForFileContent(dtsPath, '"two"', 15000);
		expect(rebuiltContent).toContain('export interface WatchState');
	}, 20000);

	it('rebuilds resolver-backed json declarations in watch mode after data changes', async () => {
		const root = await createFixtureWorkspace('watch-json');
		const watcher = (await build({
			configFile: false,
			root,
			logLevel: 'silent',
			build: {
				watch: {},
				lib: {
					entry: resolve(root, 'src/index.ts'),
					name: 'WatchJsonFixture',
					fileName: 'index',
				},
			},
			plugins: [
				dtsPlugin({
					declarationOnly: true,
				}),
			],
		})) as BuildWatcher;
		watchers.push(watcher);

		const jsonDtsPath = resolve(root, 'dist/data.json.d.ts');
		const initialJsonContent = await waitForFileContent(
			jsonDtsPath,
			'"label": "before"',
			15000,
		);
		expect(initialJsonContent).toContain('"count": 1');

		await writeFile(
			resolve(root, 'src/data.json'),
			JSON.stringify({ label: 'after', count: 2 }, null, 2),
			'utf8',
		);

		watcher.invalidate?.();
		await waitForWatcherRebuild(watcher);
		const rebuiltJsonContent = await waitForFileContent(
			jsonDtsPath,
			'"label": "after"',
			15000,
		);
		expect(rebuiltJsonContent).toContain('"count": 2');
	}, 20000);
});

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

describe('multiple outDirs', () => {
	it('copies emitted declarations and rewrites source maps into secondary outDirs', async () => {
		const root = await runFixtureBuild('multi-outdir', (fixtureRoot) => ({
			build: {
				lib: {
					entry: resolve(fixtureRoot, 'src/index.ts'),
					name: 'MultiOutdirFixture',
					fileName: 'index',
				},
			},
			plugins: [
				dtsPlugin({
					declarationOnly: true,
					outDir: ['dist', 'nested/dist-secondary'],
				}),
			],
		}));

		const primaryDts = resolve(root, 'dist/index.d.ts');
		const secondaryDts = resolve(root, 'nested/dist-secondary/index.d.ts');
		const primaryMap = resolve(root, 'dist/index.d.ts.map');
		const secondaryMap = resolve(root, 'nested/dist-secondary/index.d.ts.map');

		await expectFile(primaryDts);
		await expectFile(secondaryDts);
		await expectFile(primaryMap);
		await expectFile(secondaryMap);

		const primaryContent = await readFile(primaryDts, 'utf8');
		const secondaryContent = await readFile(secondaryDts, 'utf8');
		expect(secondaryContent).toBe(primaryContent);
		expect(secondaryContent).toContain('export interface Shape');

		const primaryMapContent = JSON.parse(await readFile(primaryMap, 'utf8'));
		const secondaryMapContent = JSON.parse(
			await readFile(secondaryMap, 'utf8'),
		);
		expect(Array.isArray(secondaryMapContent.sources)).toBe(true);
		expect(secondaryMapContent.sources).not.toEqual(primaryMapContent.sources);
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

describe('tsconfig paths integration', () => {
	const fixtures: Array<{
		name: string;
		tsconfigPath?: string;
		config?: Record<string, unknown>;
		parentConfig?: Record<string, unknown>;
		pluginPaths?: Record<string, string[]>;
		separatePluginRoot?: boolean;
	}> = [
		{
			name: 'project root different from cwd',
			tsconfigPath: 'tsconfig.json',
			config: { paths: { '@/*': ['./src/*'] } },
		},
		{
			name: 'plugin root different from Vite root',
			tsconfigPath: 'tsconfig.json',
			config: { paths: { '@/*': ['./src/*'] } },
			separatePluginRoot: true,
		},
		{
			name: 'nested tsconfigPath',
			tsconfigPath: 'config/tsconfig.json',
			config: { paths: { '@/*': ['../src/*'] } },
		},
		{
			name: 'paths inherited from a parent tsconfig',
			tsconfigPath: 'config/nested/tsconfig.json',
			parentConfig: { paths: { '@/*': ['../src/*'] } },
		},
		{
			name: 'parsed baseUrl instead of the paths defining directory',
			tsconfigPath: 'config/tsconfig.json',
			config: { baseUrl: '../src', paths: { '@/*': ['*'] } },
		},
		{
			name: 'inherited baseUrl with paths defined in a child tsconfig',
			tsconfigPath: 'config/nested/tsconfig.json',
			config: { paths: { '@/*': ['*'] } },
			parentConfig: { baseUrl: '../src' },
		},
		{
			name: 'plugin paths overriding inherited paths',
			tsconfigPath: 'config/nested/tsconfig.json',
			parentConfig: { paths: { '@/*': ['../src/wrong/*'] } },
			pluginPaths: { '@/*': ['./src/*'] },
			separatePluginRoot: true,
		},
		{
			name: 'plugin paths overriding inherited paths and baseUrl',
			tsconfigPath: 'config/nested/tsconfig.json',
			parentConfig: {
				baseUrl: '../src/wrong',
				paths: { '@/*': ['*'] },
			},
			pluginPaths: { '@/*': ['./src/*'] },
		},
		{
			name: 'plugin paths without a tsconfig',
			pluginPaths: { '@/*': ['./src/*'] },
		},
	];

	it.each(fixtures)('resolves $name without Vite aliases', async (fixture) => {
		const workspace = await createFixtureWorkspace('hooks-basic');
		const root = fixture.separatePluginRoot
			? resolve(workspace, 'project')
			: workspace;
		expect(root).not.toBe(process.cwd());
		await mkdir(resolve(root, 'src/wrong'), { recursive: true });
		await writeFile(
			resolve(root, 'src/index.ts'),
			[
				"export type { Example } from '@/types';",
				"export const example = { label: 'fixture' } satisfies import('@/types').Example;",
			].join('\n'),
			'utf8',
		);
		await writeFile(
			resolve(root, 'src/types.ts'),
			'export interface Example { label: string; }\n',
			'utf8',
		);
		await writeFile(
			resolve(root, 'src/wrong/types.ts'),
			'export interface Example { label: number; }\n',
			'utf8',
		);

		const configPath = fixture.tsconfigPath
			? resolve(root, fixture.tsconfigPath)
			: undefined;
		if (configPath) {
			await mkdir(dirname(configPath), { recursive: true });
			await writeFile(
				configPath,
				JSON.stringify({
					extends: fixture.parentConfig ? '../tsconfig.base.json' : undefined,
					compilerOptions: {
						module: 'ESNext',
						moduleResolution: 'Bundler',
						strict: true,
						...fixture.config,
					},
					include: [resolve(root, 'src')],
				}),
				'utf8',
			);
			if (fixture.parentConfig) {
				await writeFile(
					resolve(root, 'config/tsconfig.base.json'),
					JSON.stringify({ compilerOptions: fixture.parentConfig }),
					'utf8',
				);
			}
		} else {
			await rm(resolve(root, 'tsconfig.json'));
		}
		expect(Boolean(ts.findConfigFile(root, ts.sys.fileExists))).toBe(
			Boolean(configPath),
		);

		const compilerDiagnostics: ts.Diagnostic[] = [];
		await build({
			configFile: false,
			root: workspace,
			logLevel: 'silent',
			build: {
				lib: {
					entry: configPath
						? resolve(root, 'src/index.ts')
						: {
								index: resolve(root, 'src/index.ts'),
								types: resolve(root, 'src/types.ts'),
							},
					name: 'TsconfigPathsFixture',
					fileName: 'index',
				},
			},
			plugins: [
				dtsPlugin({
					root: fixture.separatePluginRoot ? root : undefined,
					tsconfigPath: fixture.tsconfigPath,
					outDir: 'dist',
					declarationOnly: true,
					compilerOptions: {
						module: ts.ModuleKind.ESNext,
						moduleResolution: ts.ModuleResolutionKind.Bundler,
						strict: true,
						types: [],
						...(fixture.pluginPaths ? { paths: fixture.pluginPaths } : {}),
					},
					afterDiagnostic(diagnostics) {
						compilerDiagnostics.push(...diagnostics);
					},
				}),
			],
		});

		expect(
			compilerDiagnostics.map((diagnostic) =>
				ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
			),
		).toEqual([]);
		const indexContent = await readFile(
			resolve(root, 'dist/index.d.ts'),
			'utf8',
		);
		expect(indexContent).toContain("export type { Example } from './types';");
		await expectFile(resolve(root, 'dist/types.d.ts'));

		const consumerPath = resolve(root, 'consumer.ts');
		await writeFile(
			consumerPath,
			[
				"import type { Example } from './dist/index';",
				"import { example } from './dist/index';",
				"const value: Example = { label: 'consumer' };",
				'const label: string = example.label;',
				'export { value, label };',
			].join('\n'),
			'utf8',
		);
		const consumerOptions: ts.CompilerOptions = {
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			target: ts.ScriptTarget.ESNext,
			strict: true,
			noEmit: true,
			skipLibCheck: false,
			types: [],
		};
		const consumerHost = ts.createCompilerHost(consumerOptions);
		const consumerProgram = ts.createProgram({
			rootNames: [consumerPath],
			options: consumerOptions,
			host: consumerHost,
		});
		expect(
			ts.formatDiagnostics(
				ts.getPreEmitDiagnostics(consumerProgram),
				consumerHost,
			),
		).toBe('');
	});
});
