import {
	cp,
	mkdir,
	mkdtemp,
	readFile,
	rename,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';

import ts from '@typescript/typescript6';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';

import dtsPlugin from '../src';
import {
	setupFixtureCleanup,
	fixturesDir,
	expectFile,
	expectSourceMapTargets,
} from './integration-helpers';

const { createFixtureWorkspace, runFixtureBuild, tempRoots } =
	setupFixtureCleanup();

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
		for (const mapPath of [primaryMap, secondaryMap]) {
			await expectSourceMapTargets(mapPath, [resolve(root, 'src/index.ts')]);
		}
	});
});

describe('declaration map source paths', () => {
	it('emits raw compiler sources relative to the compiler map filename, not the project root', async () => {
		const workspace = await mkdtemp(
			resolve(tmpdir(), 'vite-plugin-bundle-dts-compiler-cwd-'),
		);
		tempRoots.push(workspace);
		const root = resolve(workspace, 'fixture');
		// Unequal depths prevent the wrong root from accidentally reaching the source.
		const compilerRoot = resolve(workspace, 'compiler/cwd');
		await mkdir(compilerRoot, { recursive: true });
		await cp(resolve(fixturesDir, 'multi-outdir'), root, { recursive: true });
		const sourcePath = resolve(root, 'src/index.ts');
		const compilerOptions: ts.CompilerOptions = {
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			target: ts.ScriptTarget.ESNext,
			declaration: true,
			declarationMap: true,
			emitDeclarationOnly: true,
			outDir: '.',
			declarationDir: '.',
		};
		const host = ts.createCompilerHost(compilerOptions);
		host.getCurrentDirectory = () => compilerRoot;
		const program = ts.createProgram({
			rootNames: [sourcePath],
			options: compilerOptions,
			host,
		});
		const maps = new Map<string, string>();
		program.emit(undefined, (name, content) => {
			if (name.endsWith('.map')) {
				maps.set(name, content);
			}
		});

		expect(maps.size).toBe(1);
		const [name, content] = Array.from(maps.entries())[0];
		const sourceMap = JSON.parse(content) as { sources: string[] };
		expect(sourceMap.sources).toEqual(['../../fixture/src/index.ts']);
		const mapDir = dirname(resolve(host.getCurrentDirectory(), name));
		expect(mapDir).toBe(host.getCurrentDirectory());
		expect(mapDir).not.toBe(root);
		const resolvedSource = resolve(mapDir, sourceMap.sources[0]);
		expect(resolvedSource).toBe(sourcePath);
		await expectFile(resolvedSource);
		expect(await readFile(resolvedSource, 'utf8')).toContain(
			'export interface Shape',
		);
		expect(resolve(root, sourceMap.sources[0])).not.toBe(sourcePath);
	});

	it.each([
		{ name: 'inferred source root', outputPrefix: '' },
		{ name: 'project rootDir', rootDir: '.', outputPrefix: 'src/' },
		{
			name: 'entryRoot narrower than rootDir',
			rootDir: '.',
			entryRoot: 'src',
			outputPrefix: '',
		},
		{
			name: 'entryRoot wider than rootDir',
			rootDir: 'src',
			entryRoot: '.',
			outputPrefix: 'src/',
		},
		{
			name: 'plugin root different from Vite root',
			rootDir: 'src',
			entryRoot: '.',
			outputPrefix: 'src/',
			separatePluginRoot: true,
		},
		{
			name: 'absolute compiler sourceRoot',
			rootDir: 'src',
			outputPrefix: '',
			sourceRoot: true,
		},
	])('resolves nested maps to original sources with $name', async (fixture) => {
		const root = await createFixtureWorkspace('multi-outdir');
		const viteRoot = fixture.separatePluginRoot
			? resolve(root, 'vite-app')
			: root;
		await mkdir(viteRoot, { recursive: true });
		await mkdir(resolve(root, 'src/nested'), { recursive: true });
		await writeFile(
			resolve(root, 'src/index.ts'),
			[
				"export { value } from './nested/value';",
				"export type { Shape } from './nested/types';",
			].join('\n'),
			'utf8',
		);
		await writeFile(
			resolve(root, 'src/nested/value.ts'),
			'export const value = 42;\n',
			'utf8',
		);
		await writeFile(
			resolve(root, 'src/nested/types.ts'),
			'export interface Shape { nested: true; }\n',
			'utf8',
		);
		await writeFile(
			resolve(root, 'tsconfig.json'),
			JSON.stringify({
				compilerOptions: {
					module: 'ESNext',
					moduleResolution: 'Bundler',
					declarationMap: true,
					rootDir: fixture.rootDir,
					sourceMap: fixture.sourceRoot,
					sourceRoot: fixture.sourceRoot ? resolve(root, 'src') : undefined,
				},
				include: ['src'],
			}),
			'utf8',
		);
		const compilerDiagnostics: ts.Diagnostic[] = [];
		await build({
			configFile: false,
			root: viteRoot,
			logLevel: 'silent',
			build: {
				lib: {
					entry: {
						index: resolve(root, 'src/index.ts'),
						'nested/value': resolve(root, 'src/nested/value.ts'),
					},
					name: 'DeclarationMapsFixture',
					fileName: 'index',
				},
			},
			plugins: [
				dtsPlugin({
					root,
					entryRoot: fixture.entryRoot,
					declarationOnly: true,
					outDir: ['dist', 'nested/dist-secondary'],
					afterDiagnostic(diagnostics) {
						compilerDiagnostics.push(...diagnostics);
					},
				}),
			],
		});
		expect(compilerDiagnostics).toEqual([]);

		for (const outDir of ['dist', 'nested/dist-secondary']) {
			for (const entry of ['index', 'nested/value', 'nested/types']) {
				const mapPath = resolve(
					root,
					outDir,
					`${fixture.outputPrefix}${entry}.d.ts.map`,
				);
				await expectSourceMapTargets(mapPath, [
					resolve(root, `src/${entry}.ts`),
				]);
				const declaration = await readFile(mapPath.slice(0, -4), 'utf8');
				expect(declaration).toContain(
					`sourceMappingURL=${entry.split('/').pop()}.d.ts.map`,
				);
			}
		}
	});

	it('keeps a relative compiler sourceRoot anchored to its original map', async () => {
		const root = await createFixtureWorkspace('multi-outdir');
		await build({
			configFile: false,
			root,
			logLevel: 'silent',
			build: {
				lib: {
					entry: resolve(root, 'src/index.ts'),
					name: 'RelativeSourceRootFixture',
					fileName: 'index',
				},
			},
			plugins: [
				dtsPlugin({
					declarationOnly: true,
					outDir: ['dist', 'nested/dist-secondary'],
					compilerOptions: {
						sourceMap: true,
						sourceRoot: relative(process.cwd(), resolve(root, 'src')),
					},
				}),
			],
		});

		for (const outDir of ['dist', 'nested/dist-secondary']) {
			await expectSourceMapTargets(resolve(root, outDir, 'index.d.ts.map'), [
				resolve(root, 'src/index.ts'),
			]);
		}
	});

	it('resolves nested maps in a secondary output outside the project root', async () => {
		const workspace = await createFixtureWorkspace('multi-outdir');
		const root = resolve(workspace, 'project');
		await mkdir(root);
		await rename(resolve(workspace, 'src'), resolve(root, 'src'));
		await rename(
			resolve(workspace, 'tsconfig.json'),
			resolve(root, 'tsconfig.json'),
		);
		await mkdir(resolve(root, 'src/nested'));
		await writeFile(
			resolve(root, 'src/nested/value.ts'),
			'export const value = 42;\n',
			'utf8',
		);
		await build({
			configFile: false,
			root,
			logLevel: 'silent',
			build: {
				lib: {
					entry: {
						index: resolve(root, 'src/index.ts'),
						'nested/value': resolve(root, 'src/nested/value.ts'),
					},
					name: 'ExternalSecondaryMapsFixture',
					fileName: 'index',
				},
			},
			plugins: [
				dtsPlugin({
					declarationOnly: true,
					outDir: ['dist', resolve(workspace, 'secondary')],
				}),
			],
		});

		for (const outDir of [
			resolve(root, 'dist'),
			resolve(workspace, 'secondary'),
		]) {
			for (const entry of ['index', 'nested/value']) {
				await expectSourceMapTargets(resolve(outDir, `${entry}.d.ts.map`), [
					resolve(root, `src/${entry}.ts`),
				]);
			}
		}
	});

	it('rebases maps after beforeWriteFile moves primary and secondary writes', async () => {
		const root = await createFixtureWorkspace('multi-outdir');
		await build({
			configFile: false,
			root,
			logLevel: 'silent',
			build: {
				lib: {
					entry: resolve(root, 'src/index.ts'),
					name: 'RedirectedMapsFixture',
					fileName: 'index',
				},
			},
			plugins: [
				dtsPlugin({
					declarationOnly: true,
					outDir: ['dist', 'nested/dist-secondary'],
					beforeWriteFile(filePath) {
						return {
							filePath: resolve(
								dirname(filePath),
								'moved',
								filePath.split('/').pop()!,
							),
						};
					},
				}),
			],
		});

		for (const outDir of ['dist/moved', 'nested/dist-secondary/moved/moved']) {
			await expectSourceMapTargets(resolve(root, outDir, 'index.d.ts.map'), [
				resolve(root, 'src/index.ts'),
			]);
			await expectFile(resolve(root, outDir, 'index.d.ts'));
		}
	});

	it('resolves custom resolver maps from their declared output paths', async () => {
		const root = await createFixtureWorkspace('multi-outdir');
		await mkdir(resolve(root, 'src/nested'), { recursive: true });
		await writeFile(
			resolve(root, 'src/nested/value.ts'),
			'export const value = 42;\n',
			'utf8',
		);
		await build({
			configFile: false,
			root,
			logLevel: 'silent',
			build: {
				lib: {
					entry: resolve(root, 'src/index.ts'),
					name: 'ResolverMapsFixture',
					fileName: 'index',
				},
			},
			plugins: [
				dtsPlugin({
					declarationOnly: true,
					outDir: ['dist', 'nested/dist-secondary'],
					resolvers: [
						{
							name: 'mapped-source',
							supports: (id) => id.endsWith('/nested/value.ts'),
							transform() {
								return [
									{
										path: 'nested/value.d.ts',
										content:
											'export declare const value = 42;\n//# sourceMappingURL=value.d.ts.map',
									},
									{
										path: 'nested/value.d.ts.map',
										content: JSON.stringify({
											version: 3,
											file: 'value.d.ts',
											sources: ['../../src/nested/value.ts'],
											names: [],
											mappings: 'AAAA',
										}),
									},
								];
							},
						},
					],
				}),
			],
		});

		for (const outDir of ['dist', 'nested/dist-secondary']) {
			await expectSourceMapTargets(
				resolve(root, outDir, 'nested/value.d.ts.map'),
				[resolve(root, 'src/nested/value.ts')],
			);
		}
	});
});
