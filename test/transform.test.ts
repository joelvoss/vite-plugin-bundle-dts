import { describe, expect, it } from 'vitest';

import { transformDeclarationContent } from '../src/core/transform';

describe('transformDeclarationContent', () => {
	it('rewrites aliased imports and hoists static type imports', () => {
		const result = transformDeclarationContent({
			filePath: '/repo/src/feature.d.ts',
			content: [
				"import type { Foo } from '@/types';",
				"export type Example = import('@/types').Foo;",
			].join('\n'),
			aliases: [
				{
					find: '@/',
					replacement: '/repo/src/',
				},
			],
			aliasesExclude: [],
			staticImport: true,
			clearPureImport: true,
		});

		expect(result.content).toContain("import { Foo } from './types';");
		expect(result.content).toContain('export type Example = Foo;');
	});

	it('keeps same-named exports from different modules distinct and reuses each binding', () => {
		const result = transformDeclarationContent({
			filePath: '/repo/src/feature.d.ts',
			content:
				"export type Both = [import('./one').Foo, import('./two').Foo, import('./one').Foo, import('./two').Foo];",
			aliases: [],
			aliasesExclude: [],
			staticImport: true,
			clearPureImport: true,
		});

		expect(result.content).toBe(
			[
				"import { Foo } from './one';",
				"import { Foo as Foo_1 } from './two';",
				'export type Both = [ Foo, Foo_1, Foo, Foo_1];',
			].join('\n'),
		);
	});

	it('reuses an existing named alias even when its import appears later', () => {
		const result = transformDeclarationContent({
			filePath: '/repo/src/feature.d.ts',
			content: [
				"export type Both = [import('./one').Foo, import('./one').Foo];",
				"import type { Foo as One } from './one';",
				'export type Explicit = One;',
			].join('\n'),
			aliases: [],
			aliasesExclude: [],
			staticImport: true,
			clearPureImport: true,
		});

		expect(result.content).toBe(
			[
				"import { Foo as One } from './one';",
				'export type Both = [ One, One];',
				'export type Explicit = One;',
			].join('\n'),
		);
	});

	it.each([
		"import type { Other as Foo } from './other';",
		"import Foo from './other';",
		"import * as Foo from './other';",
		'export interface Foo { local: true; }',
	])('avoids a later conflicting binding: %s', (declaration) => {
		const result = transformDeclarationContent({
			filePath: '/repo/src/feature.d.ts',
			content: [
				"export type Both = [import('./one').Foo, import('./one').Foo];",
				declaration,
			].join('\n'),
			aliases: [],
			aliasesExclude: [],
			staticImport: true,
			clearPureImport: true,
		});

		expect(result.content).toContain("import { Foo as Foo_1 } from './one';");
		expect(result.content).toContain('export type Both = [ Foo_1, Foo_1];');
	});

	it.each([
		"export type Scoped<Foo> = import('./one').Foo;",
		"export type Scoped = { [Foo in 'key']: import('./one').Foo };",
		"export type Scoped<T> = T extends infer Foo ? import('./one').Foo : never;",
		"export declare namespace Scope { interface Foo {} type Scoped = import('./one').Foo; }",
	])('does not reuse a named binding shadowed in a nested scope: %s', (content) => {
		const result = transformDeclarationContent({
			filePath: '/repo/src/feature.d.ts',
			content: ["import type { Foo } from './one';", content].join('\n'),
			aliases: [],
			aliasesExclude: [],
			staticImport: true,
			clearPureImport: true,
		});

		expect(result.content).toContain("import { Foo, Foo as Foo_1 } from './one';");
		expect(result.content).toContain(
			content.replace("import('./one').Foo", 'Foo_1'),
		);
	});

	it('avoids shadowed default bindings while keeping one generated canonical binding', () => {
		const result = transformDeclarationContent({
			filePath: '/repo/src/feature.d.ts',
			content: [
				"import First from './types';",
				"export type Scoped<First> = import('./types').default;",
				"export type Both = [First, import('./types').default];",
			].join('\n'),
			aliases: [],
			aliasesExclude: [],
			staticImport: true,
			clearPureImport: true,
		});

		expect(result.content).toBe(
			[
				"import { default as First, default as __DTS_DEFAULT_0__ } from './types';",
				'export type Scoped<First> = __DTS_DEFAULT_0__;',
				'export type Both = [First, __DTS_DEFAULT_0__];',
			].join('\n'),
		);
	});

	it('reserves later declarations, imports and type parameters before allocating names', () => {
		const result = transformDeclarationContent({
			filePath: '/repo/src/feature.d.ts',
			content: [
				"export type Both = [import('./one').Foo, import('./types').default, import('./types').default];",
				'export interface Foo { local: true; }',
				"import type { Other as Foo_1, Other as __DTS_DEFAULT_1__ } from './other';",
				'export interface __DTS_DEFAULT_0__ { local: true; }',
				'export type Scoped<__DTS_DEFAULT_2__> = [Foo_1, __DTS_DEFAULT_1__, __DTS_DEFAULT_2__];',
			].join('\n'),
			aliases: [],
			aliasesExclude: [],
			staticImport: true,
			clearPureImport: true,
		});

		expect(result.content).toContain("import { Foo as Foo_2 } from './one';");
		expect(result.content).toContain(
			"import { default as __DTS_DEFAULT_3__ } from './types';",
		);
		expect(result.content).toContain(
			"import { Other as Foo_1, Other as __DTS_DEFAULT_1__ } from './other';",
		);
		expect(result.content).toContain(
			'export type Both = [ Foo_2, __DTS_DEFAULT_3__, __DTS_DEFAULT_3__];',
		);
	});

	it.each([false, true])(
		'keeps named exports distinct from generated default bindings with defaultFirst=%s',
		(defaultFirst) => {
			const importTypes = [
				"import('./types').__DTS_DEFAULT_0__",
				"import('./types').default",
			];
			if (defaultFirst) {
				importTypes.reverse();
			}
			const result = transformDeclarationContent({
				filePath: '/repo/src/feature.d.ts',
				content: `export type Both = [${[...importTypes, ...importTypes].join(', ')}];`,
				aliases: [],
				aliasesExclude: [],
				staticImport: true,
				clearPureImport: true,
			});

			expect(result.content).toBe(
				defaultFirst
					? [
							"import { default as __DTS_DEFAULT_0__, __DTS_DEFAULT_0__ as __DTS_DEFAULT_0___1 } from './types';",
							'export type Both = [ __DTS_DEFAULT_0__, __DTS_DEFAULT_0___1, __DTS_DEFAULT_0__, __DTS_DEFAULT_0___1];',
						].join('\n')
					: [
							"import { __DTS_DEFAULT_0__, default as __DTS_DEFAULT_1__ } from './types';",
							'export type Both = [ __DTS_DEFAULT_0__, __DTS_DEFAULT_1__, __DTS_DEFAULT_0__, __DTS_DEFAULT_1__];',
						].join('\n'),
			);
		},
	);

	it('does not replace an existing reference to a global type with a new import', () => {
		const result = transformDeclarationContent({
			filePath: '/repo/src/feature.d.ts',
			content: "export type Both = [Date, import('./types').Date];",
			aliases: [],
			aliasesExclude: [],
			staticImport: true,
			clearPureImport: true,
		});

		expect(result.content).toBe(
			[
				"import { Date as Date_1 } from './types';",
				'export type Both = [Date, Date_1];',
			].join('\n'),
		);
	});

	it.each(['', 'type '])(
		'preserves distinct local bindings from multiple %sdefault imports',
		(importKind) => {
			const result = transformDeclarationContent({
				filePath: '/repo/src/feature.d.ts',
				content: [
					`import ${importKind}First from './types';`,
					`import ${importKind}Second from './types';`,
					'export type Both = [First, Second];',
				].join('\n'),
				aliases: [],
				aliasesExclude: [],
				staticImport: false,
				clearPureImport: true,
			});

			expect(result.content).toBe(
				[
					"import { default as First, default as Second } from './types';",
					'export type Both = [First, Second];',
				].join('\n'),
			);
		},
	);

	it('preserves multiple defaults combined with named imports', () => {
		const result = transformDeclarationContent({
			filePath: '/repo/src/feature.d.ts',
			content: [
				"import First, { Named } from './types';",
				"import Second, { Named as Alias } from './types';",
				'export type Both = [First, Second, Named, Alias];',
			].join('\n'),
			aliases: [],
			aliasesExclude: [],
			staticImport: false,
			clearPureImport: true,
		});

		expect(result.content).toBe(
			[
				"import { default as First, Named, default as Second, Named as Alias } from './types';",
				'export type Both = [First, Second, Named, Alias];',
			].join('\n'),
		);
	});

	it('deduplicates repeated default bindings without dropping distinct ones', () => {
		const result = transformDeclarationContent({
			filePath: '/repo/src/feature.d.ts',
			content: [
				"import First from './types';",
				"import First from './types';",
				"import Second from './types';",
				"import Second from './types';",
				'export type Both = [First, Second];',
			].join('\n'),
			aliases: [],
			aliasesExclude: [],
			staticImport: false,
			clearPureImport: true,
		});

		expect(result.content).toBe(
			[
				"import { default as First, default as Second } from './types';",
				'export type Both = [First, Second];',
			].join('\n'),
		);
	});

	it('reuses the first default binding for static import types and preserves others', () => {
		const result = transformDeclarationContent({
			filePath: '/repo/src/feature.d.ts',
			content: [
				"import First from './types';",
				"import Second from './types';",
				"export type Both = [First, Second, import('./types').default, import('./types').default];",
			].join('\n'),
			aliases: [],
			aliasesExclude: [],
			staticImport: true,
			clearPureImport: true,
		});

		expect(result.content).toBe(
			[
				"import { default as First, default as Second } from './types';",
				'export type Both = [First, Second, First, First];',
			].join('\n'),
		);
	});

	it('preserves later default bindings without replacing a generated canonical binding', () => {
		const result = transformDeclarationContent({
			filePath: '/repo/src/feature.d.ts',
			content: [
				"export type Initial = import('./types').default;",
				"import First from './types';",
				"import Second from './types';",
				"export type Both = [First, Second, import('./types').default];",
			].join('\n'),
			aliases: [],
			aliasesExclude: [],
			staticImport: true,
			clearPureImport: true,
		});

		expect(result.content).toBe(
			[
				"import { default as __DTS_DEFAULT_0__, default as First, default as Second } from './types';",
				'export type Initial = __DTS_DEFAULT_0__;',
				'export type Both = [First, Second, __DTS_DEFAULT_0__];',
			].join('\n'),
		);
	});

	it('removes pure imports when requested', () => {
		const result = transformDeclarationContent({
			filePath: '/repo/src/feature.d.ts',
			content: [
				"import 'side-effect';",
				'export interface Example { value: string }',
			].join('\n'),
			aliases: [],
			aliasesExclude: [],
			staticImport: false,
			clearPureImport: true,
		});

		expect(result.content).not.toContain('side-effect');
		expect(result.content).toContain('export interface Example');
	});

	it('rewrites aliased specifiers inside dynamic import() calls', () => {
		const result = transformDeclarationContent({
			filePath: '/repo/src/feature.d.ts',
			content: [
				'export declare function load(): void;',
				"void import('@/dynamic');",
			].join('\n'),
			aliases: [
				{
					find: '@/',
					replacement: '/repo/src/',
				},
			],
			aliasesExclude: [],
			staticImport: false,
			clearPureImport: true,
		});

		expect(result.content).toContain("void import('./dynamic');");
	});

	it('rewrites aliased specifiers in re-export declarations', () => {
		const result = transformDeclarationContent({
			filePath: '/repo/src/feature.d.ts',
			content: "export { Foo } from '@/types';\n",
			aliases: [
				{
					find: '@/',
					replacement: '/repo/src/',
				},
			],
			aliasesExclude: [],
			staticImport: false,
			clearPureImport: true,
		});

		expect(result.content).toContain("export { Foo } from './types';");
	});

	it('preserves ambient declare module blocks for non-relative module names', () => {
		const result = transformDeclarationContent({
			filePath: '/repo/src/feature.d.ts',
			content: "declare module 'my-lib' {\n\texport const value: string;\n}\n",
			aliases: [],
			aliasesExclude: [],
			staticImport: false,
			clearPureImport: true,
		});

		expect(result.declareModules).toHaveLength(1);
		expect(result.declareModules[0]).toContain("declare module 'my-lib'");
		expect(result.content).toContain("declare module 'my-lib'");
	});

	it('rewrites aliased declare module names but does not preserve them as ambient', () => {
		const result = transformDeclarationContent({
			filePath: '/repo/src/feature.d.ts',
			content:
				"declare module '@/generated' {\n\texport const value: string;\n}\n",
			aliases: [
				{
					find: '@/',
					replacement: '/repo/src/',
				},
			],
			aliasesExclude: [],
			staticImport: false,
			clearPureImport: true,
		});

		expect(result.content).toContain("declare module './generated'");
		expect(result.declareModules).toHaveLength(0);
	});
});
