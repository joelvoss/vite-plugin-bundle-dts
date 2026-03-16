import ts from 'typescript';

export function walkSourceFile(
	sourceFile: ts.SourceFile,
	callback: (node: ts.Node, parent: ts.Node | ts.SourceFile) => boolean | void,
): void {
	function walkNode(node: ts.Node, parent: ts.Node | ts.SourceFile): void {
		if (callback(node, parent) !== false) {
			node.forEachChild((child) => walkNode(child, node));
		}
	}

	sourceFile.forEachChild((child) => walkNode(child, sourceFile));
}

export function hasNormalExport(content: string): boolean {
	const ast = ts.createSourceFile(
		'declaration.d.ts',
		content,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	let has = false;

	walkSourceFile(ast, (node) => {
		if (ts.isExportDeclaration(node)) {
			if (node.exportClause && ts.isNamedExports(node.exportClause)) {
				has = node.exportClause.elements.some(
					(element) => element.name.getText(ast) !== 'default',
				);
			} else {
				has = true;
			}
		} else if (
			'modifiers' in node &&
			Array.isArray(node.modifiers) &&
			node.modifiers.length > 0
		) {
			const hasExportModifier = node.modifiers.some(
				(modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
			);
			const hasDefaultModifier = node.modifiers.some(
				(modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
			);
			if (hasExportModifier && !hasDefaultModifier) {
				has = true;
			}
		}
		return !has;
	});

	return has;
}

export function hasExportDefault(content: string): boolean {
	const ast = ts.createSourceFile(
		'declaration.d.ts',
		content,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	let has = false;

	walkSourceFile(ast, (node) => {
		if (ts.isExportAssignment(node)) {
			has = true;
		} else if (
			ts.isExportDeclaration(node) &&
			node.exportClause &&
			ts.isNamedExports(node.exportClause)
		) {
			has = node.exportClause.elements.some(
				(element) => element.name.getText(ast) === 'default',
			);
		} else if (
			'modifiers' in node &&
			Array.isArray(node.modifiers) &&
			node.modifiers.length > 0
		) {
			const hasExportModifier = node.modifiers.some(
				(modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
			);
			const hasDefaultModifier = node.modifiers.some(
				(modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
			);
			if (hasExportModifier && hasDefaultModifier) {
				has = true;
			}
		}
		return !has;
	});

	return has;
}
