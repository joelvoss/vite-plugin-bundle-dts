import { mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import ts from '@typescript/typescript6';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';

import dtsPlugin from '../src';
import {
	setupFixtureCleanup,
	rollupIntegrationTimeoutMs,
	expectFile,
	expectNoFile,
	expectConsumerTypecheck,
} from './integration-helpers';

const { createFixtureWorkspace } = setupFixtureCleanup();

describe('fixture integration', () => {
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
						]
				).join('\n'),
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
					lib: {
						entry: sourcePath,
						name: 'NodeTypesFixture',
						fileName: 'main',
					},
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
});
