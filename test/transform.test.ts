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
});
