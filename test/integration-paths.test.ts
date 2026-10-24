import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import ts from '@typescript/typescript6';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';

import dtsPlugin from '../src';
import {
	setupFixtureCleanup,
	expectFile,
	expectConsumerTypecheck,
} from './integration-helpers';

const { createFixtureWorkspace } = setupFixtureCleanup();

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
