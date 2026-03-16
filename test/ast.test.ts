import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
	hasExportDefault,
	hasNormalExport,
	walkSourceFile,
} from '../src/utils/ast';

describe('ast utils', () => {
	it('walks source files and supports stopping recursion', () => {
		const sourceFile = ts.createSourceFile(
			'sample.ts',
			'export const value = { nested: true };',
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TS,
		);

		const visitedKinds: ts.SyntaxKind[] = [];
		walkSourceFile(sourceFile, (node) => {
			visitedKinds.push(node.kind);
			if (ts.isVariableStatement(node)) {
				return false;
			}
			return undefined;
		});

		expect(visitedKinds).toContain(ts.SyntaxKind.VariableStatement);
		expect(visitedKinds).not.toContain(ts.SyntaxKind.ObjectLiteralExpression);
	});

	it('detects normal exports', () => {
		expect(
			hasNormalExport('export interface Example { value: string }\n'),
		).toBe(true);
		expect(hasNormalExport("export { named } from './value';\n")).toBe(true);
		expect(hasNormalExport("export { default } from './value';\n")).toBe(false);
		expect(hasNormalExport('declare const value: string;\n')).toBe(false);
	});

	it('detects default exports', () => {
		expect(hasExportDefault('export default function value() {}\n')).toBe(true);
		expect(hasExportDefault("export { default } from './value';\n")).toBe(true);
		expect(hasExportDefault('export const value = 1;\n')).toBe(false);
	});
});
