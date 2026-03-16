import { dirname } from 'node:path';

import MagicString from 'magic-string';
import ts from 'typescript';

import type {
	TransformDeclarationOptions,
	TransformDeclarationResult,
} from '../types';
import { walkSourceFile } from '../utils/ast';
import { transformAlias } from '../utils/path';

////////////////////////////////////////////////////////////////////////////////

const dtsImportRE = /\.d\.(m|c)?tsx?$/;

////////////////////////////////////////////////////////////////////////////////

/**
 * Transform declaration content by rewriting import paths and converting
 * import types to static imports. This is necessary for API Extractor to
 * correctly resolve and bundle declarations, and also allows path aliases to
 * be applied consistently across both value and type imports. The original
 * content is modified in place using MagicString, and a list of any preserved
 * `declare module` blocks is returned separately for the caller to append
 * after bundling, since API Extractor can drop them if they are present during
 * bundling but not emitted in the final output.
 */
export function transformDeclarationContent(
	options: TransformDeclarationOptions,
): TransformDeclarationResult {
	const source = new MagicString(options.content);
	const ast = ts.createSourceFile(
		'declaration.d.ts',
		options.content,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const dir = dirname(options.filePath);
	// Declarations can accumulate many duplicated imports after path rewriting
	// and import-type expansion. Collect them first, then emit one normalized
	// block.
	const importMap = new Map<string, Set<string>>();
	const usedDefault = new Map<string, string>();
	const declareModules: string[] = [];

	const toLibName = (origin: string): string =>
		transformAlias(origin, dir, options.aliases, options.aliasesExclude);

	let generatedDefaultIndex = 0;
	let importCount = 0;

	walkSourceFile(ast, (node, parent) => {
		if (ts.isImportDeclaration(node)) {
			if (!node.importClause) {
				if (options.clearPureImport) {
					source.remove(node.pos, node.end);
				}
				importCount += 1;
				return false;
			}

			if (
				ts.isStringLiteral(node.moduleSpecifier) &&
				(node.importClause.name ||
					(node.importClause.namedBindings &&
						ts.isNamedImports(node.importClause.namedBindings)))
			) {
				const libName = toLibName(node.moduleSpecifier.text);
				const importSet = importMap.get(libName) ?? new Set<string>();
				importMap.set(libName, importSet);

				if (node.importClause.name && !usedDefault.has(libName)) {
					const usedType = node.importClause.name.escapedText.toString();
					usedDefault.set(libName, usedType);
					importSet.add(`default as ${usedType}`);
				}

				if (
					node.importClause.namedBindings &&
					ts.isNamedImports(node.importClause.namedBindings)
				) {
					for (const element of node.importClause.namedBindings.elements) {
						if (element.propertyName) {
							importSet.add(
								`${element.propertyName.getText(ast)} as ${element.name.escapedText.toString()}`,
							);
						} else {
							importSet.add(element.name.escapedText.toString());
						}
					}
				}

				source.remove(node.pos, node.end);
				importCount += 1;
			}

			return false;
		}

		if (
			ts.isImportTypeNode(node) &&
			node.qualifier &&
			ts.isLiteralTypeNode(node.argument) &&
			ts.isStringLiteral(node.argument.literal) &&
			ts.isIdentifier(node.qualifier)
		) {
			const libName = toLibName(node.argument.literal.text);
			if (!options.staticImport) {
				source.update(
					node.argument.literal.pos,
					node.argument.literal.end,
					`'${libName}'`,
				);
				return !node.typeArguments;
			}

			// `import("foo").Bar` is valid in declarations, but turning it into a
			// static import makes later bundling and API Extractor passes much more
			// predictable.
			const importSet = importMap.get(libName) ?? new Set<string>();
			importMap.set(libName, importSet);
			let usedType = node.qualifier.escapedText.toString();

			if (usedType === 'default') {
				usedType =
					usedDefault.get(libName) ??
					`__DTS_DEFAULT_${generatedDefaultIndex++}__`;
				usedDefault.set(libName, usedType);
				importSet.add(`default as ${usedType}`);
				source.update(node.qualifier.pos, node.qualifier.end, usedType);
			} else {
				importSet.add(usedType);
			}

			if (
				ts.isImportTypeNode(parent) &&
				parent.typeArguments &&
				parent.typeArguments[0] === node
			) {
				source.remove(node.pos, node.argument.end + 2);
			} else {
				source.update(node.pos, node.argument.end + 2, ' ');
			}

			return !node.typeArguments;
		}

		if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			ts.isStringLiteral(node.arguments[0])
		) {
			source.update(
				node.arguments[0].pos,
				node.arguments[0].end,
				`'${toLibName(node.arguments[0].text)}'`,
			);
			return false;
		}

		if (
			ts.isExportDeclaration(node) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			source.update(
				node.moduleSpecifier.pos,
				node.moduleSpecifier.end,
				` '${toLibName(node.moduleSpecifier.text)}'`,
			);
			return false;
		}

		if (
			ts.isModuleDeclaration(node) &&
			node.body &&
			ts.isModuleBlock(node.body) &&
			ts.isStringLiteral(node.name)
		) {
			const libName = toLibName(node.name.text);
			if (libName !== node.name.text) {
				source.update(node.name.pos, node.name.end, ` '${libName}'`);
			}
			if (
				!libName.startsWith('.') &&
				node.modifiers?.[0]?.kind === ts.SyntaxKind.DeclareKeyword &&
				!node.body.statements.some(
					(statement) =>
						ts.isExportAssignment(statement) ||
						ts.isExportDeclaration(statement) ||
						ts.isImportDeclaration(statement),
				)
			) {
				// API Extractor can drop ambient `declare module` blocks unless they
				// are appended after bundling, so preserve them separately for the
				// caller.
				declareModules.push(source.slice(node.pos, node.end + 1));
			}
			return false;
		}

		return undefined;
	});

	let prependImports = '';
	importMap.forEach((importSet, libName) => {
		prependImports += `import { ${Array.from(importSet).join(', ')} } from '${libName}';\n`;
	});

	source.trimStart('\n').prepend(prependImports);

	return {
		content: source.toString().replace(dtsImportRE, '.d.ts'),
		declareModules,
		diffLineCount:
			importMap.size && importCount < importMap.size
				? importMap.size - importCount
				: null,
	};
}
