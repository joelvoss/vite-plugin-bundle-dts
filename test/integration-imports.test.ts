import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import ts from '@typescript/typescript6';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';

import dtsPlugin from '../src';
import {
	setupFixtureCleanup,
	rollupIntegrationTimeoutMs,
	expectConsumerTypecheck,
} from './integration-helpers';

const { createFixtureWorkspace } = setupFixtureCleanup();

describe('fixture integration', () => {
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
});
