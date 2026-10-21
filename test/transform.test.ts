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
