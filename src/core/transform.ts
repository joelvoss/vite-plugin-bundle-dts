import { dirname } from 'node:path';

import ts from '@typescript/typescript6';
import { MagicString } from 'magic-string';

import type {
	TransformDeclarationOptions,
	TransformDeclarationResult,
} from '../types.ts';
import { walkSourceFile } from '../utils/ast.ts';
import { transformAlias } from '../utils/path.ts';

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
	const usedNamed = new Map<string, Map<string, string>>();
	const reservedIdentifiers = new Set<string>();
	const shadowedIdentifiers = new Set<string>();
	const declareModules: string[] = [];

	const toLibName = (origin: string): string =>
		transformAlias(origin, dir, options.aliases, options.aliasesExclude);

	let generatedDefaultIndex = 0;
	let importCount = 0;

	if (options.staticImport) {
		// Reserve names before rewriting, including identifiers in nested scopes
		// and declarations/imports that appear after an import type.
		walkSourceFile(ast, (node, parent) => {
			if (ts.isImportDeclaration(node) && parent === ast) {
				if (node.importClause?.name) {
					reservedIdentifiers.add(node.importClause.name.text);
				}
				const bindings = node.importClause?.namedBindings;
				if (bindings) {
					if (ts.isNamespaceImport(bindings)) {
						reservedIdentifiers.add(bindings.name.text);
					} else {
						for (const element of bindings.elements) {
							reservedIdentifiers.add(element.name.text);
						}
					}
				}
				return false;
			}
			if (
				ts.isIdentifier(node) &&
				!(ts.isImportTypeNode(parent) && parent.qualifier === node)
			) {
				reservedIdentifiers.add(node.text);
				// Conservatively avoid reusing any import binding whose name is
				// also declared elsewhere, so it stays valid at every use site.
				if ('name' in parent && parent.name === node) {
					shadowedIdentifiers.add(node.text);
				}
			}
		});

		for (const statement of ast.statements) {
			if (
				ts.isImportDeclaration(statement) &&
				ts.isStringLiteral(statement.moduleSpecifier) &&
				statement.importClause?.namedBindings &&
				ts.isNamedImports(statement.importClause.namedBindings)
			) {
				const libName = toLibName(statement.moduleSpecifier.text);
				const bindings = usedNamed.get(libName) ?? new Map<string, string>();
				usedNamed.set(libName, bindings);
				for (const element of statement.importClause.namedBindings.elements) {
					const name = (element.propertyName ?? element.name).text;
					if (
						!bindings.has(name) &&
						!shadowedIdentifiers.has(element.name.text)
					) {
						bindings.set(name, element.name.text);
					}
				}
			}
		}
	}

	const allocateName = (name: string): string => {
		let localName: string;
		let index = 0;
		do {
			localName =
				name === 'default'
					? `__DTS_DEFAULT_${generatedDefaultIndex++}__`
					: index === 0
						? name
						: `${name}_${index}`;
			index += 1;
		} while (reservedIdentifiers.has(localName));
		reservedIdentifiers.add(localName);
		return localName;
	};

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

				if (node.importClause.name) {
					const usedType = node.importClause.name.text;
					if (
						!usedDefault.has(libName) &&
						!shadowedIdentifiers.has(usedType)
					) {
						usedDefault.set(libName, usedType);
					}
					importSet.add(`default as ${usedType}`);
				}

				if (
					node.importClause.namedBindings &&
					ts.isNamedImports(node.importClause.namedBindings)
				) {
					for (const element of node.importClause.namedBindings.elements) {
						if (element.propertyName) {
							importSet.add(
								`${element.propertyName.getText(ast)} as ${element.name.text}`,
							);
						} else {
							importSet.add(element.name.text);
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
			const name = node.qualifier.text;
			let usedType: string;

			if (name === 'default') {
				usedType = usedDefault.get(libName) ?? allocateName(name);
				usedDefault.set(libName, usedType);
			} else {
				const bindings = usedNamed.get(libName) ?? new Map<string, string>();
				usedNamed.set(libName, bindings);
				usedType = bindings.get(name) ?? allocateName(name);
				bindings.set(name, usedType);
			}
			importSet.add(name === usedType ? name : `${name} as ${usedType}`);
			if (usedType !== name) {
				source.update(node.qualifier.pos, node.qualifier.end, usedType);
			}

			const prefix =
				ts.isImportTypeNode(parent) &&
				parent.typeArguments &&
				parent.typeArguments[0] === node
					? ''
					: ' ';
			source.update(
				node.pos,
				node.qualifier.pos,
				`${prefix}${node.isTypeOf ? 'typeof ' : ''}`,
			);

			return !!node.typeArguments;
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
