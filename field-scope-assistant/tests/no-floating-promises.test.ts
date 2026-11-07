import { describe, expect, it } from "vitest";
import path from "node:path";
import ts from "typescript";

/**
 * Server code must await every Promise. After the move to async Postgres, routes
 * like `addItem(...)` (no await) returned before saving — and on Vercel the write
 * could be dropped entirely — while `{ templates: repo.listTemplates() }`
 * serialized a Promise as {} and crashed the Settings page. This guards both shapes.
 */
describe("server code has no floating promises", () => {
  it("every Promise in src/lib and src/app/api is awaited, returned, or explicitly voided", () => {
    const root = path.resolve(__dirname, "..");
    const cfg = ts.parseJsonConfigFileContent(ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile).config, ts.sys, root);
    const files = cfg.fileNames.filter((f) => /[\\/]src[\\/](lib|app[\\/]api)[\\/]/.test(f));
    const program = ts.createProgram(files, cfg.options);
    const checker = program.getTypeChecker();
    const isPromise = (n: ts.Node) => /^Promise</.test(checker.typeToString(checker.getTypeAtLocation(n)));
    const found: string[] = [];
    for (const sf of program.getSourceFiles()) {
      if (!files.includes(sf.fileName)) continue;
      const at = (n: ts.Node) => `${path.relative(root, sf.fileName)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${n.getText().slice(0, 80)}`;
      const visit = (node: ts.Node) => {
        if (ts.isExpressionStatement(node)) {
          const e = node.expression;
          const ok = ts.isVoidExpression(e) || ts.isAwaitExpression(e) || (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken);
          if (!ok && isPromise(e)) found.push(at(node));
        }
        if (ts.isPropertyAssignment(node) && !ts.isAwaitExpression(node.initializer) && isPromise(node.initializer)) found.push(at(node));
        if (ts.isSpreadAssignment(node) && isPromise(node.expression)) found.push(at(node));
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    expect(found).toEqual([]);
  });
});
