import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import ts from '@typescript/typescript6';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';

import dtsPlugin from '../src';
import {
	setupFixtureCleanup,
	expectFile,
	expectNoFile,
	expectConsumerTypecheck,
	waitForWatcherRebuild,
	waitForFileContent,
	type BuildWatcher,
} from './integration-helpers';

const { createFixtureWorkspace, watchers } = setupFixtureCleanup();

describe('fixture integration', () => {
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

	it('emits and watches newly introduced type-only dependency chains', async () => {
		const root = await createFixtureWorkspace('watch-basic');
		await writeFile(
			resolve(root, 'tsconfig.json'),
			JSON.stringify({
				compilerOptions: {
					module: 'ESNext',
					moduleResolution: 'Bundler',
					strict: true,
				},
				files: ['src/index.ts'],
			}),
			'utf8',
		);
		let emitted: ReadonlyMap<string, string> = new Map();
		let compilerDiagnostics: readonly ts.Diagnostic[] = [];
		const watcher = (await build({
			configFile: false,
			root,
			logLevel: 'silent',
			build: {
				watch: {},
				lib: {
					entry: resolve(root, 'src/index.ts'),
					name: 'WatchTypeOnlyFixture',
					fileName: 'index',
				},
			},
			plugins: [
				dtsPlugin({
					declarationOnly: true,
					include: ['src'],
					afterDiagnostic(diagnostics) {
						compilerDiagnostics = [...diagnostics];
					},
					afterBuild(emittedFiles) {
						emitted = new Map(emittedFiles);
					},
				}),
			],
		})) as BuildWatcher;
		watchers.push(watcher);
		await waitForWatcherRebuild(watcher);
		expect(compilerDiagnostics).toEqual([]);
		expect(Array.from(emitted.keys())).toEqual([
			resolve(root, 'dist/index.d.ts'),
		]);

		await writeFile(
			resolve(root, 'src/added.ts'),
			"export interface Added { label: 'added'; }\n",
			'utf8',
		);
		const addedRebuild = waitForWatcherRebuild(watcher);
		await writeFile(
			resolve(root, 'src/index.ts'),
			"export type { Added } from './added';\n",
			'utf8',
		);
		await addedRebuild;
		expect(compilerDiagnostics).toEqual([]);
		await expectFile(resolve(root, 'dist/added.d.ts'));
		expect(emitted.has(resolve(root, 'dist/added.d.ts'))).toBe(true);
		await expectConsumerTypecheck(
			root,
			[
				"import type { Added } from './dist/index';",
				"const added: Added = { label: 'added' };",
				'export { added };',
			].join('\n'),
		);

		await mkdir(resolve(root, 'src/nested'), { recursive: true });
		await writeFile(
			resolve(root, 'src/nested/dependency.ts'),
			"export interface Dependency { value: 'first'; }\n",
			'utf8',
		);
		const dependencyRebuild = waitForWatcherRebuild(watcher);
		await writeFile(
			resolve(root, 'src/added.ts'),
			[
				"import type { Dependency } from './nested/dependency';",
				'export interface Added { dependency: Dependency; }',
			].join('\n'),
			'utf8',
		);
		await dependencyRebuild;
		expect(compilerDiagnostics).toEqual([]);
		await expectFile(resolve(root, 'dist/nested/dependency.d.ts'));
		expect(emitted.has(resolve(root, 'dist/nested/dependency.d.ts'))).toBe(
			true,
		);
		await expectConsumerTypecheck(
			root,
			[
				"import type { Added } from './dist/index';",
				"const added: Added = { dependency: { value: 'first' } };",
				"const value: 'first' = added.dependency.value;",
				'export { added, value };',
			].join('\n'),
		);

		await writeFile(
			resolve(root, 'src/nested/detail.ts'),
			'export type Detail = string;\n',
			'utf8',
		);
		const transitiveRebuild = waitForWatcherRebuild(watcher);
		await writeFile(
			resolve(root, 'src/nested/dependency.ts'),
			[
				"import type { Detail } from './detail';",
				'export interface Dependency { value: Detail; }',
			].join('\n'),
			'utf8',
		);
		await transitiveRebuild;
		expect(compilerDiagnostics).toEqual([]);
		await expectFile(resolve(root, 'dist/nested/detail.d.ts'));
		expect(emitted.has(resolve(root, 'dist/nested/detail.d.ts'))).toBe(true);

		const detailRebuild = waitForWatcherRebuild(watcher);
		await writeFile(
			resolve(root, 'src/nested/detail.ts'),
			'export type Detail = number;\n',
			'utf8',
		);
		await detailRebuild;
		expect(compilerDiagnostics).toEqual([]);
		expect(emitted.get(resolve(root, 'dist/nested/detail.d.ts'))).toContain(
			'export type Detail = number;',
		);
		await expectConsumerTypecheck(
			root,
			[
				"import type { Added } from './dist/index';",
				'const added: Added = { dependency: { value: 42 } };',
				'const value: number = added.dependency.value;',
				'// @ts-expect-error The transitive dependency no longer accepts strings.',
				"const invalid: Added = { dependency: { value: 'stale' } };",
				'export { added, value, invalid };',
			].join('\n'),
		);

		const detachedRebuild = waitForWatcherRebuild(watcher);
		await writeFile(
			resolve(root, 'src/added.ts'),
			'export interface Added { removed: true; }\n',
			'utf8',
		);
		await detachedRebuild;
		expect(compilerDiagnostics).toEqual([]);
		expect(emitted.has(resolve(root, 'dist/nested/dependency.d.ts'))).toBe(
			false,
		);
		expect(emitted.has(resolve(root, 'dist/nested/detail.d.ts'))).toBe(false);
		await rm(resolve(root, 'src/nested/dependency.ts'));
		await rm(resolve(root, 'src/nested/detail.ts'));
		const removedRebuild = waitForWatcherRebuild(watcher);
		await writeFile(
			resolve(root, 'src/added.ts'),
			'export interface Added { removed: true; ready: true; }\n',
			'utf8',
		);
		await removedRebuild;
		expect(compilerDiagnostics).toEqual([]);
		expect(emitted.has(resolve(root, 'dist/nested/dependency.d.ts'))).toBe(
			false,
		);
		expect(emitted.has(resolve(root, 'dist/nested/detail.d.ts'))).toBe(false);
		await expectConsumerTypecheck(
			root,
			[
				"import type { Added } from './dist/index';",
				'const added: Added = { removed: true, ready: true };',
				'export { added };',
			].join('\n'),
		);
	}, 30000);

	it('refreshes included roots after configured files are removed or added', async () => {
		const root = await createFixtureWorkspace('watch-basic');
		await writeFile(
			resolve(root, 'src/configured.ts'),
			'export interface Configured { ready: true; }\n',
			'utf8',
		);
		await writeFile(
			resolve(root, 'src/index.ts'),
			"export type { Configured } from './configured';\n",
			'utf8',
		);
		let emitted: ReadonlyMap<string, string> = new Map();
		let compilerDiagnostics: readonly ts.Diagnostic[] = [];
		const watcher = (await build({
			configFile: false,
			root,
			logLevel: 'silent',
			build: {
				watch: {},
				lib: {
					entry: resolve(root, 'src/index.ts'),
					name: 'WatchConfiguredRootsFixture',
					fileName: 'index',
				},
			},
			plugins: [
				dtsPlugin({
					declarationOnly: true,
					exclude: ['src/**/*.test.ts'],
					afterDiagnostic(diagnostics) {
						compilerDiagnostics = [...diagnostics];
					},
					afterBuild(emittedFiles) {
						emitted = new Map(emittedFiles);
					},
				}),
			],
		})) as BuildWatcher;
		watchers.push(watcher);
		await waitForWatcherRebuild(watcher);
		expect(compilerDiagnostics).toEqual([]);
		expect(emitted.has(resolve(root, 'dist/configured.d.ts'))).toBe(true);

		const entryRebuild = waitForWatcherRebuild(watcher);
		await writeFile(
			resolve(root, 'src/index.ts'),
			"export const message = 'two';\n",
			'utf8',
		);
		await entryRebuild;
		expect(compilerDiagnostics).toEqual([]);
		const removedRebuild = waitForWatcherRebuild(watcher);
		await rm(resolve(root, 'src/configured.ts'));
		await removedRebuild;
		expect(compilerDiagnostics).toEqual([]);
		expect(emitted.has(resolve(root, 'dist/configured.d.ts'))).toBe(false);
		expect(emitted.get(resolve(root, 'dist/index.d.ts'))).toContain('"two"');

		await writeFile(
			resolve(root, 'src/unreferenced.ts'),
			'export interface Unreferenced { added: true; }\n',
			'utf8',
		);
		await writeFile(
			resolve(root, 'src/excluded.test.ts'),
			'export interface Excluded { excluded: true; }\n',
			'utf8',
		);
		const addedRebuild = waitForWatcherRebuild(watcher);
		await writeFile(
			resolve(root, 'src/index.ts'),
			"export const message = 'three';\n",
			'utf8',
		);
		await addedRebuild;
		expect(compilerDiagnostics).toEqual([]);
		await expectFile(resolve(root, 'dist/unreferenced.d.ts'));
		expect(emitted.has(resolve(root, 'dist/unreferenced.d.ts'))).toBe(true);
		expect(emitted.has(resolve(root, 'dist/configured.d.ts'))).toBe(false);
		await expectNoFile(resolve(root, 'dist/excluded.test.d.ts'));
	}, 20000);
});
