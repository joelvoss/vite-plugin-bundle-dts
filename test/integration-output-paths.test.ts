import { mkdir, readFile, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
	setupFixtureCleanup,
	expectFile,
	expectNoFile,
	buildOutputFixture,
} from './integration-helpers';

const { createFixtureWorkspace } = setupFixtureCleanup();

describe('strictOutput containment', () => {
	it.each([
		['sibling directory', 'dist-escape/nested/index.d.ts', false],
		['parent traversal', 'dist/nested/../../escaped.d.ts', false],
		['sibling traversal', 'dist/nested/../../dist-escape/index.d.ts', false],
		['nested directory', 'dist/nested/deeper/index.d.ts', true],
		['normalized nested directory', 'dist/unused/../nested/index.d.ts', true],
		['dot-prefixed directory', 'dist/..nested/index.d.ts', true],
		['dot-prefixed file', 'dist/..index.d.ts', true],
	] as const)(
		'checks redirected paths for %s',
		async (_name, outputPath, allowed) => {
			const root = await createFixtureWorkspace('hooks-basic');
			let emitted: ReadonlyMap<string, string> | undefined;
			await buildOutputFixture(root, {
				include: ['src/*.ts'],
				beforeWriteFile() {
					return { filePath: `${root}/${outputPath}` };
				},
				afterBuild(files) {
					emitted = files;
				},
			});

			const targetPath = resolve(root, outputPath);
			if (allowed) {
				expect(await readFile(targetPath, 'utf8')).toContain(
					'export interface Shape',
				);
				expect(Array.from(emitted?.keys() ?? [])).toEqual([targetPath]);
			} else {
				await expectNoFile(targetPath);
				expect(emitted?.size).toBe(0);
			}
			await expectNoFile(resolve(root, 'dist/index.d.ts'));
		},
	);

	it.each(['sibling', 'symlink', 'nested'] as const)(
		'checks the secondary output boundary for a %s redirect',
		async (kind) => {
			const root = await createFixtureWorkspace('hooks-basic');
			const outsideDir = resolve(root, 'secondary-escape');
			if (kind === 'symlink') {
				await mkdir(resolve(root, 'secondary'));
				await mkdir(outsideDir);
				await symlink(outsideDir, resolve(root, 'secondary/linked'), 'dir');
			}
			const outputPath = resolve(
				root,
				kind === 'sibling'
					? 'secondary-escape/index.d.ts'
					: kind === 'symlink'
						? 'secondary/linked/new/index.d.ts'
						: 'secondary/new/index.d.ts',
			);
			let redirected = false;
			await buildOutputFixture(root, {
				outDir: ['dist', 'secondary'],
				beforeWriteFile(filePath) {
					if (filePath === resolve(root, 'secondary/index.d.ts')) {
						redirected = true;
						return { filePath: outputPath };
					}
					return undefined;
				},
			});

			expect(redirected).toBe(true);
			await expectFile(resolve(root, 'dist/index.d.ts'));
			await expectNoFile(resolve(root, 'secondary/index.d.ts'));
			if (kind === 'nested') {
				await expectFile(outputPath);
			} else {
				await expectNoFile(outputPath);
			}
		},
	);
});
