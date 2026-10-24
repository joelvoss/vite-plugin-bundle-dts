import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
	setupFixtureCleanup,
	rollupIntegrationTimeoutMs,
	expectNoFile,
	buildOutputFixture,
} from './integration-helpers';

const { createFixtureWorkspace } = setupFixtureCleanup();

describe('strictOutput containment', () => {
	it.each([
		['../renamed.d.ts', true],
		['../types-escape/renamed.d.ts', true],
		['../../dist-escape/renamed.d.ts', false],
	] as const)(
		'checks the configured root for a final rollup redirect to %s',
		async (redirect, allowed) => {
			const root = await createFixtureWorkspace('insert-types-entry');
			let rolledUp = false;
			await buildOutputFixture(root, {
				rollupTypes: true,
				afterRollup() {
					rolledUp = true;
				},
				beforeWriteFile(filePath) {
					return rolledUp
						? { filePath: `${dirname(filePath)}/${redirect}` }
						: undefined;
				},
			});

			expect(rolledUp).toBe(true);
			const targetPath = resolve(root, 'dist/types', redirect);
			if (allowed) {
				expect(await readFile(targetPath, 'utf8')).toContain(
					'export declare const namedValue = 7;',
				);
			} else {
				await expectNoFile(targetPath);
			}
		},
		rollupIntegrationTimeoutMs,
	);

	it.each(['sibling', 'file symlink'] as const)(
		'does not roll up an existing external entry through a %s',
		async (kind) => {
			const root = await createFixtureWorkspace('insert-types-entry');
			const outsideFile = resolve(root, 'dist-escape/entry.d.ts');
			const sentinel = 'export declare const untouched: true;\n';
			await mkdir(dirname(outsideFile));
			await writeFile(outsideFile, sentinel, 'utf8');
			if (kind === 'sibling') {
				await writeFile(
					resolve(root, 'package.json'),
					JSON.stringify({
						name: 'strict-output-fixture',
						types: 'dist-escape/entry.d.ts',
					}),
					'utf8',
				);
			} else {
				await mkdir(resolve(root, 'dist/types'), { recursive: true });
				await symlink(
					outsideFile,
					resolve(root, 'dist/types/entry.d.ts'),
					'file',
				);
			}
			let rolledUp = false;
			await buildOutputFixture(root, {
				rollupTypes: true,
				afterRollup() {
					rolledUp = true;
				},
			});

			expect(await readFile(outsideFile, 'utf8')).toBe(sentinel);
			expect(rolledUp).toBe(false);
		},
		rollupIntegrationTimeoutMs,
	);
});
