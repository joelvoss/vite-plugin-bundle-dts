import {
	access,
	cp,
	mkdir,
	mkdtemp,
	readFile,
	rename,
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
	nodeMode?: { extension: 'mts' | 'cts'; module: 'NodeNext' | 'Node16' },
): Promise<void> {
	const consumerPath = resolve(root, `consumer.${nodeMode?.extension ?? 'ts'}`);
	await writeFile(consumerPath, content, 'utf8');
	const consumerOptions: ts.CompilerOptions = {
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		target: ts.ScriptTarget.ESNext,
		strict: true,
		noEmit: true,
		skipLibCheck: false,
		types: [],
		...(nodeMode
			? {
					module: ts.ModuleKind[nodeMode.module],
					moduleResolution: ts.ModuleResolutionKind[nodeMode.module],
				}
			: {}),
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

	it.each(['', 'type '])(
		'emits consumer-valid declarations for multiple %sdefault imports',
		async (importKind) => {
			const root = await createFixtureWorkspace('hooks-basic');
			await writeFile(
				resolve(root, 'src/index.ts'),
				[
					`import ${importKind}First from './types';`,
					`import ${importKind}Second from './types';`,
					'export type Both = [First, Second];',
				].join('\n'),
				'utf8',
			);
			await writeFile(
				resolve(root, 'src/types.ts'),
				'export default interface Shape { label: string; }\n',
				'utf8',
			);

			const compilerDiagnostics: ts.Diagnostic[] = [];
			await build({
				configFile: false,
				root,
				logLevel: 'silent',
				build: {
					lib: {
						entry: resolve(root, 'src/index.ts'),
						name: 'MultipleDefaultImportsFixture',
						fileName: 'index',
					},
				},
				plugins: [
					dtsPlugin({
						declarationOnly: true,
						afterDiagnostic(diagnostics) {
							compilerDiagnostics.push(...diagnostics);
						},
					}),
				],
			});
			expect(compilerDiagnostics).toEqual([]);

			await expectConsumerTypecheck(
				root,
				[
					"import type { Both } from './dist/index';",
					"const both: Both = [{ label: 'first' }, { label: 'second' }];",
					'const firstLabel: string = both[0].label;',
					'const secondLabel: string = both[1].label;',
					'export { both, firstLabel, secondLabel };',
				].join('\n'),
			);

			const content = await readFile(resolve(root, 'dist/index.d.ts'), 'utf8');
			expect(content).toContain(
				"import { default as First, default as Second } from './types';",
			);
			expect(content).toContain('export type Both = [First, Second];');
		},
	);

	it.each([false, true])(
		'keeps static import bindings distinct and consumer-valid with rollupTypes=%s',
		async (rollupTypes) => {
			const root = await createFixtureWorkspace('hooks-basic');
			await writeFile(
				resolve(root, 'src/index.ts'),
				[
					"export type Both = [import('./one').Foo, import('./two').Foo, import('./one').Foo, import('./two').Foo];",
					"export type Aliased = [import('./one').Aliased, import('./one').Aliased];",
					"export type Defaults = [import('./one').DefaultConflict, import('./one').default, import('./one').default];",
					"export type NamespaceType = [import('./one').NamespaceConflict, NamespaceConflict.Other];",
					"export type Local = [import('./one').LocalConflict, LocalConflict];",
					"export type Scoped<ScopedAlias, ExistingDefault, __DTS_DEFAULT_1__> = [import('./one').Scoped, import('./two').default, ScopedAlias, ExistingDefault, __DTS_DEFAULT_1__];",
					"import type { Aliased as ExistingAlias, Scoped as ScopedAlias } from './one';",
					"import type DefaultConflict from './two';",
					"import type ExistingDefault from './two';",
					"import type * as NamespaceConflict from './two';",
					'export interface Foo_1 { later: true; }',
					'export interface LocalConflict { local: true; }',
					'export interface __DTS_DEFAULT_0__ { reserved: true; }',
					'export type Explicit = [ExistingAlias, ScopedAlias, DefaultConflict, ExistingDefault];',
				].join('\n'),
				'utf8',
			);
			await writeFile(
				resolve(root, 'src/one.ts'),
				[
					"export interface Foo { kind: 'one'; }",
					"export interface Aliased { alias: 'one'; }",
					"export interface DefaultConflict { named: 'one'; }",
					"export interface NamespaceConflict { namespace: 'one'; }",
					"export interface LocalConflict { imported: 'one'; }",
					"export interface Scoped { scoped: 'one'; }",
					"export default interface Shape { default: 'one'; }",
				].join('\n'),
				'utf8',
			);
			await writeFile(
				resolve(root, 'src/two.ts'),
				[
					"export interface Foo { kind: 'two'; }",
					"export interface Other { other: 'two'; }",
					"export default interface Shape { default: 'two'; }",
				].join('\n'),
				'utf8',
			);

			const compilerDiagnostics: ts.Diagnostic[] = [];
			await build({
				configFile: false,
				root,
				logLevel: 'silent',
				build: {
					lib: {
						entry: resolve(root, 'src/index.ts'),
						name: 'StaticImportBindingsFixture',
						fileName: 'index',
					},
				},
				plugins: [
					dtsPlugin({
						declarationOnly: true,
						staticImport: true,
						rollupTypes,
						afterDiagnostic(diagnostics) {
							compilerDiagnostics.push(...diagnostics);
						},
					}),
				],
			});
			expect(compilerDiagnostics).toEqual([]);

			await expectConsumerTypecheck(
				root,
				[
					"import type { Both, Aliased, Defaults, NamespaceType, Local, Scoped, Explicit } from './dist/index';",
					"const both: Both = [{ kind: 'one' }, { kind: 'two' }, { kind: 'one' }, { kind: 'two' }];",
					"const firstKind: 'one' = both[0].kind;",
					"const secondKind: 'two' = both[1].kind;",
					"const aliased: Aliased = [{ alias: 'one' }, { alias: 'one' }];",
					"const defaults: Defaults = [{ named: 'one' }, { default: 'one' }, { default: 'one' }];",
					"const namespaceType: NamespaceType = [{ namespace: 'one' }, { other: 'two' }];",
					"const local: Local = [{ imported: 'one' }, { local: true }];",
					"const scoped: Scoped<'alias', 'default', 'reserved'> = [{ scoped: 'one' }, { default: 'two' }, 'alias', 'default', 'reserved'];",
					"const explicit: Explicit = [{ alias: 'one' }, { scoped: 'one' }, { default: 'two' }, { default: 'two' }];",
					'export { both, firstKind, secondKind, aliased, defaults, namespaceType, local, scoped, explicit };',
				].join('\n'),
			);

			if (!rollupTypes) {
				const content = await readFile(
					resolve(root, 'dist/index.d.ts'),
					'utf8',
				);
				expect(content).toContain(
					'export type Both = [ Foo, Foo_2, Foo, Foo_2];',
				);
				expect(content).toContain(
					'export type Aliased = [ ExistingAlias, ExistingAlias];',
				);
				expect(content).toContain('default as __DTS_DEFAULT_2__');
				expect(content).toContain(
					'export type Defaults = [ DefaultConflict_1, __DTS_DEFAULT_2__, __DTS_DEFAULT_2__];',
				);
				expect(content).toContain('Scoped as Scoped_1');
				expect(content).toContain(
					'export type Scoped<ScopedAlias, ExistingDefault, __DTS_DEFAULT_1__> = [ Scoped_1, __DTS_DEFAULT_3__, ScopedAlias, ExistingDefault, __DTS_DEFAULT_1__];',
				);
			}
		},
		rollupIntegrationTimeoutMs,
	);

	it.each([false, true])(
		'preserves callable and constructor typeof import types with rollupTypes=%s',
		async (rollupTypes) => {
			const root = await createFixtureWorkspace('hooks-basic');
			await writeFile(
				resolve(root, 'src/index.ts'),
				[
					"import type { Foo as ExistingFunction } from './functions';",
					"import type ExistingDefault from './functions';",
					"export type NamedFunction = typeof import('./functions').Foo;",
					"export type DefaultFunction = typeof import('./functions').default;",
					"export type NamedConstructor = typeof import('./classes').Foo;",
					"export type DefaultConstructor = typeof import('./classes').default;",
					"export type ClassInstances = [import('./classes').Foo, import('./classes').default];",
					"export type Nested = import('./types').Pair<typeof import('./functions').Foo, import('./types').Pair<import('./classes').Foo, typeof import('./classes').default>>;",
					"export type GenericFunction = typeof import('./functions').identity<import('./classes').Foo>;",
					'export type ExistingBindings = [typeof ExistingFunction, typeof ExistingDefault];',
					'export interface Foo { local: true; }',
					'export interface __DTS_DEFAULT_0__ { reserved: true; }',
				].join('\n'),
				'utf8',
			);
			await writeFile(
				resolve(root, 'src/functions.ts'),
				[
					'export function Foo(label: string, count: number): { label: string; count: number } { return { label, count }; }',
					'export default function createDefault(value: number): string { return String(value); }',
					'export function identity<T>(value: T): T { return value; }',
				].join('\n'),
				'utf8',
			);
			await writeFile(
				resolve(root, 'src/classes.ts'),
				[
					"export class Foo { static readonly kind = 'named'; constructor(public label: string, public count: number) {} }",
					"export default class Shape { static readonly kind = 'default'; constructor(public enabled: boolean) {} }",
				].join('\n'),
				'utf8',
			);
			await writeFile(
				resolve(root, 'src/types.ts'),
				'export type Pair<A, B> = [A, B];\n',
				'utf8',
			);

			const compilerDiagnostics: ts.Diagnostic[] = [];
			await build({
				configFile: false,
				root,
				logLevel: 'silent',
				build: {
					lib: {
						entry: resolve(root, 'src/index.ts'),
						name: 'TypeofImportFixture',
						fileName: 'index',
					},
				},
				plugins: [
					dtsPlugin({
						declarationOnly: true,
						staticImport: true,
						rollupTypes,
						afterDiagnostic(diagnostics) {
							compilerDiagnostics.push(...diagnostics);
						},
					}),
				],
			});
			expect(compilerDiagnostics).toEqual([]);

			await expectConsumerTypecheck(
				root,
				[
					"import type { NamedFunction, DefaultFunction, NamedConstructor, DefaultConstructor, ClassInstances, Nested, GenericFunction, ExistingBindings } from './dist/index';",
					'declare const namedFunction: NamedFunction;',
					"const namedArgs: Parameters<NamedFunction> = ['named', 2];",
					'const namedResult: ReturnType<NamedFunction> = namedFunction(...namedArgs);',
					'const label: string = namedResult.label;',
					'declare const defaultFunction: DefaultFunction;',
					'const defaultArgs: Parameters<DefaultFunction> = [3];',
					'const defaultResult: ReturnType<DefaultFunction> = defaultFunction(...defaultArgs);',
					'const text: string = defaultResult;',
					'declare const Named: NamedConstructor;',
					"const namedConstructorArgs: ConstructorParameters<NamedConstructor> = ['class', 4];",
					'const namedInstance: InstanceType<NamedConstructor> = new Named(...namedConstructorArgs);',
					"const namedKind: 'named' = Named.kind;",
					'declare const Default: DefaultConstructor;',
					'const defaultConstructorArgs: ConstructorParameters<DefaultConstructor> = [true];',
					'const defaultInstance: InstanceType<DefaultConstructor> = new Default(...defaultConstructorArgs);',
					"const defaultKind: 'default' = Default.kind;",
					'const instances: ClassInstances = [namedInstance, defaultInstance];',
					'const nested: Nested = [namedFunction, [namedInstance, Default]];',
					'declare const genericFunction: GenericFunction;',
					'const genericResult: InstanceType<NamedConstructor> = genericFunction(namedInstance);',
					'const existing: ExistingBindings = [namedFunction, defaultFunction];',
					'// @ts-expect-error Named function parameters must not be erased.',
					"namedFunction(1, 'wrong');",
					'// @ts-expect-error Default function parameters must not be erased.',
					"defaultFunction('wrong');",
					'// @ts-expect-error Named constructor parameters must not be erased.',
					'new Named(true);',
					'// @ts-expect-error Default constructor parameters must not be erased.',
					"new Default('wrong');",
					'// @ts-expect-error Ordinary class import types remain instance types.',
					'const invalidInstances: ClassInstances = [Named, Default];',
					'export { namedResult, label, defaultResult, text, namedInstance, namedKind, defaultInstance, defaultKind, instances, nested, genericResult, existing, invalidInstances };',
				].join('\n'),
			);
		},
		rollupIntegrationTimeoutMs,
	);

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

	it.each([
		['mts', 'module', 'm', 'NodeNext', false],
		['cts', 'commonjs', 'c', 'NodeNext', false],
		['mjs', 'commonjs', 'm', 'NodeNext', false],
		['cjs', 'module', 'c', 'NodeNext', false],
		['ts', 'module', '', 'NodeNext', false],
		['js', 'module', '', 'NodeNext', false],
		['mts', 'module', 'm', 'Node16', false],
		['cts', 'commonjs', 'c', 'Node16', false],
		['mts', 'module', 'm', 'NodeNext', true],
		['cts', 'commonjs', 'c', 'NodeNext', true],
	] as const)(
		'forwards .%s APIs with type=%s, flavor=%s, module=%s, rollupTypes=%s',
		async (extension, type, flavor, module, rollupTypes) => {
			const root = await createFixtureWorkspace('insert-types-entry');
			const sourcePath = resolve(root, `src/index.${extension}`);
			if (extension !== 'ts') {
				await rename(resolve(root, 'src/index.ts'), sourcePath);
			}
			await writeFile(
				sourcePath,
				(extension === 'cjs'
					? [
							'const namedValue = 7;',
							'exports.namedValue = namedValue;',
							'exports.default = function createValue() { return namedValue; };',
						]
					: [
							'export const namedValue = 7;',
							'export default function createValue() { return namedValue; }',
						]).join('\n'),
				'utf8',
			);
			await writeFile(
				resolve(root, 'package.json'),
				JSON.stringify({
					name: 'node-types-entry-fixture',
					type,
					types: `dist/types/entry.d.${flavor}ts`,
				}),
				'utf8',
			);
			await writeFile(
				resolve(root, 'tsconfig.json'),
				JSON.stringify({
					compilerOptions: {
						module,
						moduleResolution: module,
						strict: true,
						allowJs: extension.endsWith('js'),
					},
					include: ['src'],
				}),
				'utf8',
			);

			const compilerDiagnostics: ts.Diagnostic[] = [];
			await build({
				configFile: false,
				root,
				logLevel: 'silent',
				build: {
					lib: { entry: sourcePath, name: 'NodeTypesFixture', fileName: 'main' },
				},
				plugins: [
					dtsPlugin({
						declarationOnly: true,
						insertTypesEntry: true,
						rollupTypes,
						afterDiagnostic(diagnostics) {
							compilerDiagnostics.push(...diagnostics);
						},
					}),
				],
			});
			expect(compilerDiagnostics).toEqual([]);
			const shimContent = await readFile(
				resolve(root, `dist/types/entry.d.${flavor}ts`),
				'utf8',
			);
			if (rollupTypes) {
				await expectNoFile(resolve(root, `dist/index.d.${flavor}ts`));
				expect(shimContent).toContain('export declare const namedValue = 7;');
				expect(shimContent).toContain('export default createValue;');
				expect(shimContent).not.toMatch(/\bfrom\s+['"]\./);
			} else {
				const entryContent = await readFile(
					resolve(root, `dist/index.d.${flavor}ts`),
					'utf8',
				);
				expect(entryContent).toMatch(
					/export (?:declare )?const namedValue(?: = 7|: 7);/,
				);
				expect(entryContent).toContain('default');
				expect(shimContent).toContain(`export * from '../index.${flavor}js'`);
				expect(shimContent).toContain(
					`import NodeTypesFixture from '../index.${flavor}js'`,
				);
				expect(shimContent).toContain('export default NodeTypesFixture');
			}

			await mkdir(resolve(root, 'node_modules'), { recursive: true });
			await symlink(
				root,
				resolve(root, 'node_modules/node-types-entry-fixture'),
				'dir',
			);
			await expectConsumerTypecheck(
				root,
				[
					"import createValue, { namedValue } from 'node-types-entry-fixture';",
					'const value: number = createValue();',
					'const literal: 7 = namedValue;',
					'// @ts-expect-error The default function accepts no arguments.',
					"createValue('wrong');",
					'export { value, literal };',
				].join('\n'),
				{ extension: flavor === 'c' ? 'cts' : 'mts', module },
			);
		},
		rollupIntegrationTimeoutMs,
	);

	it('forwards a CommonJS export assignment through a .d.cts types entry', async () => {
		const root = await createFixtureWorkspace('insert-types-entry');
		await rename(resolve(root, 'src/index.ts'), resolve(root, 'src/index.cts'));
		await writeFile(
			resolve(root, 'src/index.cts'),
			[
				'function createValue(label: string) { return { label }; }',
				'namespace createValue { export const namedValue = 7; }',
				'export = createValue;',
			].join('\n'),
			'utf8',
		);
		await writeFile(
			resolve(root, 'package.json'),
			JSON.stringify({ type: 'commonjs', types: 'dist/types/entry.d.cts' }),
			'utf8',
		);
		await writeFile(
			resolve(root, 'tsconfig.json'),
			JSON.stringify({
				compilerOptions: {
					module: 'NodeNext',
					moduleResolution: 'NodeNext',
					strict: true,
				},
				include: ['src'],
			}),
			'utf8',
		);
		const compilerDiagnostics: ts.Diagnostic[] = [];
		await build({
			configFile: false,
			root,
			logLevel: 'silent',
			build: {
				lib: {
					entry: resolve(root, 'src/index.cts'),
					name: 'CommonJsTypesFixture',
					fileName: 'main',
				},
			},
			plugins: [
				dtsPlugin({
					declarationOnly: true,
					insertTypesEntry: true,
					afterDiagnostic(diagnostics) {
						compilerDiagnostics.push(...diagnostics);
					},
				}),
			],
		});
		expect(compilerDiagnostics).toEqual([]);
		await expectFile(resolve(root, 'dist/index.d.cts'));
		const shimContent = await readFile(
			resolve(root, 'dist/types/entry.d.cts'),
			'utf8',
		);
		expect(shimContent).toBe(
			"import CommonJsTypesFixture = require('../index.cjs')\nexport = CommonJsTypesFixture\n",
		);
		await expectConsumerTypecheck(
			root,
			[
				"import createValue = require('./dist/types/entry.cjs');",
				"const value: { label: string } = createValue('consumer');",
				'const literal: 7 = createValue.namedValue;',
				'// @ts-expect-error The callable API keeps its parameter type.',
				'createValue(123);',
				'export { value, literal };',
			].join('\n'),
			{ extension: 'cts', module: 'NodeNext' },
		);
	});

	it('keeps unsuffixed multi-entry names while forwarding module-flavored sources', async () => {
		const root = await createFixtureWorkspace('insert-types-entry');
		await rename(resolve(root, 'src/index.ts'), resolve(root, 'src/index.mts'));
		await writeFile(
			resolve(root, 'src/extra.cts'),
			'export const extraValue = 42;\n',
			'utf8',
		);
		await writeFile(
			resolve(root, 'tsconfig.json'),
			JSON.stringify({
				compilerOptions: {
					module: 'NodeNext',
					moduleResolution: 'NodeNext',
					strict: true,
				},
				include: ['src'],
			}),
			'utf8',
		);
		await build({
			configFile: false,
			root,
			logLevel: 'silent',
			build: {
				lib: {
					entry: {
						'nested/index': resolve(root, 'src/index.mts'),
						'nested/extra': resolve(root, 'src/extra.cts'),
					},
					name: 'MultiNodeTypesFixture',
					fileName: 'main',
				},
			},
			plugins: [dtsPlugin({ declarationOnly: true, insertTypesEntry: true })],
		});
		await expectFile(resolve(root, 'dist/index.d.mts'));
		await expectFile(resolve(root, 'dist/extra.d.cts'));
		expect(
			await readFile(resolve(root, 'dist/nested/index.d.ts'), 'utf8'),
		).toContain("export * from '../index.mjs'");
		expect(
			await readFile(resolve(root, 'dist/nested/extra.d.ts'), 'utf8'),
		).toContain("export * from '../extra.cjs'");
		await expectConsumerTypecheck(
			root,
			[
				"import createValue, { namedValue } from './dist/nested/index.js';",
				"import { extraValue } from './dist/nested/extra.js';",
				'const value: number = createValue();',
				'const named: 7 = namedValue;',
				'const extra: 42 = extraValue;',
				'export { value, named, extra };',
			].join('\n'),
			{ extension: 'mts', module: 'NodeNext' },
		);
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
	it.each([false, true])(
		'emits consumer-valid namespace and qualified import types without Vite aliases with staticImport=%s',
		async (staticImport) => {
			const root = await createFixtureWorkspace('hooks-basic');
			await writeFile(
				resolve(root, 'tsconfig.json'),
				JSON.stringify({
					compilerOptions: {
						target: 'ES2022',
						module: 'ESNext',
						moduleResolution: 'Bundler',
						strict: true,
						paths: { '@/*': ['./src/*'] },
					},
					include: ['src'],
				}),
				'utf8',
			);
			await writeFile(
				resolve(root, 'src/index.ts'),
				[
					"import * as Regular from '@/types';",
					"import type * as Types from '@/types';",
					"import Default, * as Combined from '@/types';",
					'export type NamespaceBindings = [Regular.Namespace.Shape, Types.Namespace.Shape, Combined.Namespace.Shape, Default];',
					"export type Qualified = import('@/types').Namespace.Shape;",
					"export type QualifiedClass = import('@/types').Namespace.Foo;",
					"export type QualifiedConstructor = typeof import('@/types').Namespace.Foo;",
					"export type QualifiedFunction = typeof import('@/types').Namespace.create;",
					"export type Module = typeof import('@/types');",
					"export type Nested = import('@/types').Pair<import('@/types').Namespace.Shape, import('@/types').Namespace.Pair<import('@/types').Leaf, typeof import('@/types')>>;",
					"export type Instantiated = typeof import('@/types').Namespace.identity<import('@/types').Leaf>;",
					"export type SimpleFunction = typeof import('@/types').create;",
				].join('\n'),
				'utf8',
			);
			await writeFile(
				resolve(root, 'src/types.ts'),
				[
					'export default interface DefaultShape { default: true; }',
					'export interface Leaf { leaf: true; }',
					'export type Pair<A, B> = [A, B];',
					'export function create(label: string): { label: string } { return { label }; }',
					'export namespace Namespace {',
					'  export interface Shape { label: string; }',
					"  export class Foo { static readonly kind = 'namespace'; constructor(public label: string) {} }",
					'  export function create(label: string): Shape { return { label }; }',
					'  export type Pair<A, B> = [A, B];',
					'  export function identity<T>(value: T): T { return value; }',
					'}',
				].join('\n'),
				'utf8',
			);

			const compilerDiagnostics: ts.Diagnostic[] = [];
			await build({
				configFile: false,
				root,
				logLevel: 'silent',
				build: {
					lib: {
						entry: resolve(root, 'src/index.ts'),
						name: 'NamespacePathsFixture',
						fileName: 'index',
					},
				},
				plugins: [
					dtsPlugin({
						declarationOnly: true,
						staticImport,
						afterDiagnostic(diagnostics) {
							compilerDiagnostics.push(...diagnostics);
						},
					}),
				],
			});
			expect(compilerDiagnostics).toEqual([]);

			await expectConsumerTypecheck(
				root,
				[
					"import type { NamespaceBindings, Qualified, QualifiedClass, QualifiedConstructor, QualifiedFunction, Module, Nested, Instantiated, SimpleFunction } from './dist/index';",
					"const shape: Qualified = { label: 'consumer' };",
					'const bindings: NamespaceBindings = [shape, shape, shape, { default: true }];',
					'declare const Constructor: QualifiedConstructor;',
					"const instance: QualifiedClass = new Constructor('instance');",
					"const kind: 'namespace' = Constructor.kind;",
					'declare const create: QualifiedFunction;',
					"const created: Qualified = create('function');",
					'declare const module: Module;',
					"const moduleShape: Qualified = module.Namespace.create('module');",
					"const moduleInstance: QualifiedClass = new module.Namespace.Foo('module');",
					"const simple: ReturnType<SimpleFunction> = module.create('simple');",
					'const nested: Nested = [shape, [{ leaf: true }, module]];',
					'declare const identity: Instantiated;',
					'const leaf: { leaf: true } = identity({ leaf: true });',
					'// @ts-expect-error Qualified constructors keep their parameters.',
					'new Constructor(123);',
					'// @ts-expect-error Qualified functions keep their parameters.',
					'create(123);',
					'// @ts-expect-error Whole-module typeof retains the namespace function signature.',
					'module.Namespace.create(123);',
					'// @ts-expect-error Qualified generic functions retain rewritten type arguments.',
					'identity({ leaf: false });',
					'export { bindings, instance, kind, created, moduleShape, moduleInstance, simple, nested, leaf };',
				].join('\n'),
			);

			const content = await readFile(resolve(root, 'dist/index.d.ts'), 'utf8');
			expect(content).not.toContain('@/');
			expect(content).toContain("import * as Regular from './types';");
			expect(content).toContain("import type * as Types from './types';");
			expect(content).toContain(
				"import Default, * as Combined from './types';",
			);
			expect(content).toContain("typeof import('./types').Namespace.Foo");
			expect(content).toContain("typeof import('./types');");
		},
	);

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
