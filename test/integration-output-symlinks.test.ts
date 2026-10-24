import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
	setupFixtureCleanup,
	expectNoFile,
	buildOutputFixture,
} from './integration-helpers';

const { createFixtureWorkspace } = setupFixtureCleanup();

describe('strictOutput containment', () => {
	it.each([
		['directory', true],
		['directory', false],
		['file', true],
		['file', false],
	] as const)(
		'checks an external %s symlink with strictOutput=%s',
		async (kind, strictOutput) => {
			const root = await createFixtureWorkspace('hooks-basic');
			const outsideDir = resolve(root, 'dist-escape');
			const outsideFile = resolve(outsideDir, 'index.d.ts');
			const sentinel = 'export declare const untouched: true;\n';
			await mkdir(resolve(root, 'dist'), { recursive: true });
			await mkdir(outsideDir);
			await writeFile(outsideFile, sentinel, 'utf8');
			const linkPath = resolve(
				root,
				kind === 'file' ? 'dist/linked.d.ts' : 'dist/linked',
			);
			await symlink(
				kind === 'file' ? outsideFile : outsideDir,
				linkPath,
				kind === 'file' ? 'file' : 'dir',
			);
			const outputPath =
				kind === 'file' ? linkPath : resolve(linkPath, 'new/nested/index.d.ts');
			const physicalPath =
				kind === 'file'
					? outsideFile
					: resolve(outsideDir, 'new/nested/index.d.ts');
			let emitted: ReadonlyMap<string, string> | undefined;
			await buildOutputFixture(root, {
				strictOutput,
				beforeWriteFile() {
					return { filePath: outputPath };
				},
				afterBuild(files) {
					emitted = files;
				},
			});

			if (strictOutput) {
				expect(emitted?.size).toBe(0);
				if (kind === 'directory') {
					await expectNoFile(resolve(outsideDir, 'new'));
				}
			} else {
				expect(await readFile(physicalPath, 'utf8')).toContain(
					'export interface Shape',
				);
				expect(emitted?.has(outputPath)).toBe(true);
			}
			if (strictOutput || kind === 'directory') {
				expect(await readFile(outsideFile, 'utf8')).toBe(sentinel);
			}
		},
	);

	it('rejects a dangling file symlink without creating its external target', async () => {
		const root = await createFixtureWorkspace('hooks-basic');
		const outsideFile = resolve(root, 'dist-escape/missing.d.ts');
		const linkPath = resolve(root, 'dist/linked.d.ts');
		await mkdir(dirname(linkPath));
		await mkdir(dirname(outsideFile));
		await symlink(outsideFile, linkPath, 'file');
		await buildOutputFixture(root, {
			beforeWriteFile() {
				return { filePath: linkPath };
			},
		});

		await expectNoFile(outsideFile);
	});

	it.each(['output root', 'internal directory', 'internal file'] as const)(
		'allows a safe symlink for the %s',
		async (kind) => {
			const root = await createFixtureWorkspace('hooks-basic');
			const physicalDir = resolve(
				root,
				kind === 'output root' ? 'physical-dist' : 'dist/physical',
			);
			await mkdir(physicalDir, { recursive: true });
			const physicalFile = resolve(physicalDir, 'index.d.ts');
			if (kind === 'internal file') {
				await writeFile(physicalFile, 'export {};\n', 'utf8');
			}
			const linkPath = resolve(
				root,
				kind === 'output root'
					? 'dist'
					: kind === 'internal file'
						? 'dist/linked.d.ts'
						: 'dist/linked',
			);
			await symlink(
				kind === 'internal file' ? physicalFile : physicalDir,
				linkPath,
				kind === 'internal file' ? 'file' : 'dir',
			);
			const outputPath =
				kind === 'internal file'
					? linkPath
					: resolve(linkPath, 'new/nested/index.d.ts');
			await buildOutputFixture(root, {
				beforeWriteFile() {
					return { filePath: outputPath };
				},
			});

			const physicalPath =
				kind === 'internal file'
					? physicalFile
					: resolve(physicalDir, 'new/nested/index.d.ts');
			expect(await readFile(physicalPath, 'utf8')).toContain(
				'export interface Shape',
			);
		},
	);
});
