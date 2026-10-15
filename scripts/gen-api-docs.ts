/**
 * Generates the API reference of the export engine (docs/reference/export.md)
 * from the package entry's exports and their TSDoc, so every export is listed
 * with its signature, description, parameters, return value, errors and
 * examples. Same generator as tabula-pixi's scripts/gen-api-docs.ts.
 *
 *   npx tsx scripts/gen-api-docs.ts          # write the reference
 *   npx tsx scripts/gen-api-docs.ts --check  # exit 1 if an export lacks TSDoc
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = join(import.meta.dirname, '..');
interface Entry {
  file: string;
  module: string;
  page: string;
  title: string;
  /** Leave out exports declared under these folders (documented on their own page). */
  skip?: string[];
  /** Extra paragraph under the title. */
  note?: string;
}

const ENTRIES: Entry[] = [
  { file: 'src/export/index.ts', module: 'tabula-tools', page: 'export', title: 'Export engine (`tabula-tools`)' },
];

const BASE_OPTIONS: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true };
const program = ts.createProgram(ENTRIES.map((e) => join(ROOT, e.file)), BASE_OPTIONS);
const checker = program.getTypeChecker();
const printer = ts.createPrinter({ removeComments: true });
const missing: string[] = [];

function docOf(symbol: ts.Symbol): { text: string; tags: ts.JSDocTagInfo[] } {
  const text = ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();
  return { text, tags: symbol.getJsDocTags(checker) };
}

function tagText(tag: ts.JSDocTagInfo): string {
  return ts.displayPartsToString(tag.text ?? []).trim();
}

/** Declaration source without bodies/initialisers, single-spaced. */
function signatureOf(decl: ts.Declaration): string {
  let node: ts.Node = decl;
  if (ts.isFunctionDeclaration(decl)) node = ts.factory.updateFunctionDeclaration(decl, decl.modifiers?.filter((m) => m.kind !== ts.SyntaxKind.ExportKeyword && m.kind !== ts.SyntaxKind.AsyncKeyword), decl.asteriskToken, decl.name, decl.typeParameters, decl.parameters, decl.type, undefined);
  else if (ts.isMethodDeclaration(decl)) node = ts.factory.updateMethodDeclaration(decl, decl.modifiers?.filter((m) => m.kind !== ts.SyntaxKind.AsyncKeyword), decl.asteriskToken, decl.name, decl.questionToken, decl.typeParameters, decl.parameters, decl.type, undefined);
  else if (ts.isConstructorDeclaration(decl)) node = ts.factory.updateConstructorDeclaration(decl, decl.modifiers, decl.parameters, undefined);
  else if (ts.isGetAccessorDeclaration(decl)) node = ts.factory.updateGetAccessorDeclaration(decl, decl.modifiers, decl.name, decl.parameters, decl.type, undefined);
  else if (ts.isSetAccessorDeclaration(decl)) node = ts.factory.updateSetAccessorDeclaration(decl, decl.modifiers, decl.name, decl.parameters, undefined);
  else if (ts.isPropertyDeclaration(decl)) node = ts.factory.updatePropertyDeclaration(decl, decl.modifiers, decl.name, decl.questionToken, decl.type ?? typeNode(decl), undefined);
  else if (ts.isVariableDeclaration(decl)) {
    const type = decl.type ?? typeNode(decl);
    return `const ${decl.name.getText()}: ${type ? printer.printNode(ts.EmitHint.Unspecified, type, decl.getSourceFile()) : 'unknown'}`;
  }
  const text = printer.printNode(ts.EmitHint.Unspecified, node, decl.getSourceFile());
  return text.replace(/^export\s+/, '').replace(/;\s*$/, '').trim();
}

function typeNode(decl: ts.Declaration): ts.TypeNode | undefined {
  return checker.typeToTypeNode(checker.getTypeAtLocation(decl), undefined, ts.NodeBuilderFlags.NoTruncation) ?? undefined;
}

function kindOf(decl: ts.Declaration): string {
  if (ts.isClassDeclaration(decl)) return 'class';
  if (ts.isInterfaceDeclaration(decl)) return 'interface';
  if (ts.isTypeAliasDeclaration(decl)) return 'type';
  if (ts.isEnumDeclaration(decl)) return 'enum';
  if (ts.isFunctionDeclaration(decl)) return 'function';
  if (ts.isVariableDeclaration(decl)) return 'const';
  return ts.SyntaxKind[decl.kind];
}

function renderDoc(lines: string[], symbol: ts.Symbol, label: string, needsDoc = true): void {
  const { text, tags } = docOf(symbol);
  if (text) lines.push(text, '');
  else if (needsDoc) missing.push(label);
  const params = tags.filter((t) => t.name === 'param');
  if (params.length) {
    lines.push('| Parameter | Description |', '|---|---|');
    for (const p of params) {
      const [name, ...rest] = tagText(p).split(/\s+/);
      lines.push(`| \`${name}\` | ${rest.join(' ').replace(/^-\s*/, '').replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
    }
    lines.push('');
  }
  for (const t of tags) {
    if (t.name === 'returns' || t.name === 'return') lines.push(`**Returns:** ${tagText(t)}`, '');
    else if (t.name === 'throws') lines.push(`**Throws:** ${tagText(t)}`, '');
    else if (t.name === 'deprecated') lines.push(`**Deprecated.** ${tagText(t)}`, '');
    else if (t.name === 'see') lines.push(`**See:** ${tagText(t)}`, '');
    else if (t.name === 'example') {
      const body = tagText(t);
      lines.push('**Example**', '', body.includes('```') ? body : '```ts\n' + body + '\n```', '');
    }
  }
}

function isPublicMember(m: ts.ClassElement | ts.TypeElement): boolean {
  const flags = ts.getCombinedModifierFlags(m as unknown as ts.Declaration);
  if (flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) return false;
  if (m.name && ts.isPrivateIdentifier(m.name)) return false;
  return true;
}

/**
 * Members of `decl` plus the public members its Tabula base classes declare
 * (shared-layer bases such as `AssetManagerCore` and `ViewPool` are not
 * exported themselves); members overridden in `decl` are listed once.
 * Pixi's own base classes (Container, ...) are not expanded.
 */
function classMembersWithInherited(decl: ts.ClassDeclaration): (ts.ClassElement | ts.TypeElement)[] {
  const out: (ts.ClassElement | ts.TypeElement)[] = [...decl.members];
  const names = new Set(out.map((m) => (m as ts.NamedDeclaration).name?.getText() ?? (ts.isConstructorDeclaration(m) ? 'constructor' : '')));
  let type = checker.getTypeAtLocation(decl);
  for (;;) {
    const base = (type.isClassOrInterface() ? checker.getBaseTypes(type as ts.InterfaceType) : [])[0];
    const baseDecl = base?.symbol?.declarations?.find(ts.isClassDeclaration);
    if (!base || !baseDecl || !relative(ROOT, baseDecl.getSourceFile().fileName).startsWith('src/')) break;
    for (const m of baseDecl.members) {
      const name = (m as ts.NamedDeclaration).name?.getText();
      if (!name || ts.isConstructorDeclaration(m) || names.has(name)) continue;
      names.add(name);
      out.push(m);
    }
    type = base;
  }
  return out;
}

function renderClassMembers(lines: string[], decl: ts.ClassDeclaration | ts.InterfaceDeclaration, owner: string): void {
  const all = ts.isClassDeclaration(decl) ? classMembersWithInherited(decl) : [...decl.members];
  const members = (all as (ts.ClassElement | ts.TypeElement)[]).filter(isPublicMember);
  if (!members.length) return;
  const isClass = ts.isClassDeclaration(decl);
  for (const m of members) {
    if (ts.isIndexSignatureDeclaration(m) || ts.isSemicolonClassElement(m as ts.ClassElement)) continue;
    const symbol = (m as ts.NamedDeclaration).name ? checker.getSymbolAtLocation((m as ts.NamedDeclaration).name!) : ts.isConstructorDeclaration(m) ? undefined : undefined;
    const name = ts.isConstructorDeclaration(m) ? 'constructor' : (m as ts.NamedDeclaration).name?.getText() ?? '?';
    let sig: string;
    if (isClass) sig = signatureOf(m as ts.Declaration);
    else sig = printer.printNode(ts.EmitHint.Unspecified, m, decl.getSourceFile()).replace(/;\s*$/, '');
    if (isClass) {
      if (ts.isSetAccessorDeclaration(m) && members.some((o) => ts.isGetAccessorDeclaration(o) && o.name.getText() === name)) {
        // Getter already listed: add the setter signature to its block.
        const getterBlock = lines.findIndex((l, i) => i > 0 && lines[i - 1] === '```ts' && l.startsWith(`get ${name}(`));
        if (getterBlock > 0) lines.splice(getterBlock + 1, 0, sig);
        continue;
      }
      const isStatic = (m as { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers?.some((x: ts.ModifierLike) => x.kind === ts.SyntaxKind.StaticKeyword);
      lines.push(`#### \`${ts.isConstructorDeclaration(m) ? `new ${owner}()` : `${owner}${isStatic ? '.' : '#'}${name}`}\``, '');
      lines.push('```ts', sig, '```', '');
      if (ts.isConstructorDeclaration(m)) {
        const ctorDoc = ts.displayPartsToString(checker.getSignatureFromDeclaration(m)?.getDocumentationComment(checker) ?? []).trim();
        if (ctorDoc) lines.push(ctorDoc, '');
        const tags = checker.getSignatureFromDeclaration(m)?.getJsDocTags() ?? [];
        const params = tags.filter((t) => t.name === 'param');
        if (params.length) {
          lines.push('| Parameter | Description |', '|---|---|');
          for (const p of params) {
            const [pn, ...rest] = tagText(p).split(/\s+/);
            lines.push(`| \`${pn}\` | ${rest.join(' ').replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
          }
          lines.push('');
        }
      } else if (symbol) renderDoc(lines, symbol, `${owner}.${name}`, !ts.isSetAccessorDeclaration(m));
    } else {
      const doc = symbol ? ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim().replace(/\n+/g, ' ') : '';
      lines.push(`| \`${sig.replace(/\|/g, '\\|').replace(/\n\s*/g, ' ')}\` | ${doc.replace(/\|/g, '\\|')} |`);
    }
  }
}

for (const entry of ENTRIES) {
  const source = program.getSourceFile(join(ROOT, entry.file))!;
  const moduleSymbol = checker.getSymbolAtLocation(source)!;
  const exports = checker.getExportsOfModule(moduleSymbol).sort((a, b) => a.name.localeCompare(b.name));
  const groups = new Map<string, string[]>();
  let count = 0;
  for (const exp of exports) {
    const symbol = exp.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp;
    const decl = symbol.declarations?.[0];
    if (!decl) continue;
    // Exports re-exported from tabula-pixi: link its source, not the built declarations.
    const file = relative(ROOT, decl.getSourceFile().fileName).replace(/(^|\/)tabula-pixi\/dist\//, '$1tabula-pixi/src/').replace(/\.d\.ts$/, '.ts');
    if (entry.skip?.some((prefix) => file.startsWith(prefix))) continue;
    count++;
    const lines: string[] = [];
    const kind = kindOf(decl);
    lines.push(`### ${exp.name}`, '', `*${kind}* — [\`${file}\`](../../${file})`, '');
    if (ts.isClassDeclaration(decl)) {
      const heritage = decl.heritageClauses?.map((h) => h.getText()).join(' ');
      lines.push('```ts', `class ${exp.name}${decl.typeParameters ? `<${decl.typeParameters.map((t) => t.getText()).join(', ')}>` : ''}${heritage ? ' ' + heritage : ''}`, '```', '');
      renderDoc(lines, symbol, exp.name);
      renderClassMembers(lines, decl, exp.name);
    } else if (ts.isInterfaceDeclaration(decl)) {
      renderDoc(lines, symbol, exp.name);
      const members = decl.members.filter(isPublicMember);
      if (members.length) {
        lines.push('| Member | Description |', '|---|---|');
        renderClassMembers(lines, decl, exp.name);
        lines.push('');
      }
    } else if (ts.isFunctionDeclaration(decl)) {
      const decls = (symbol.declarations ?? []).filter(ts.isFunctionDeclaration);
      const sigs = decls.length > 1 ? decls.filter((d) => !d.body) : decls;
      lines.push('```ts', ...sigs.map((d) => signatureOf(d)), '```', '');
      renderDoc(lines, symbol, exp.name);
    } else if (ts.isEnumDeclaration(decl)) {
      renderDoc(lines, symbol, exp.name);
      lines.push('| Member | Value | Description |', '|---|---|---|');
      for (const m of decl.members) {
        const ms = checker.getSymbolAtLocation(m.name);
        const value = checker.getConstantValue(m);
        lines.push(`| \`${m.name.getText()}\` | \`${JSON.stringify(value)}\` | ${ms ? ts.displayPartsToString(ms.getDocumentationComment(checker)).replace(/\n/g, ' ') : ''} |`);
      }
      lines.push('');
    } else {
      const sig = ts.isTypeAliasDeclaration(decl) ? printer.printNode(ts.EmitHint.Unspecified, decl, decl.getSourceFile()).replace(/^export\s+/, '') : signatureOf(decl);
      lines.push('```ts', sig.length > 1500 ? sig.slice(0, 1500) + ' …' : sig, '```', '');
      renderDoc(lines, symbol, exp.name);
    }
    const key = file;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(lines.join('\n'));
  }
  const out: string[] = [
    `# API reference: ${entry.title}`,
    '',
    `Generated by \`npx tsx scripts/gen-api-docs.ts\` from the TSDoc of every export of \`${entry.file}\` (${count} exports). Do not edit by hand.`,
    '',
    ...(entry.note ? [entry.note, ''] : []),
    '```ts',
    `import { … } from '${entry.module}';`,
    '```',
    '',
    '## Contents',
    '',
  ];
  for (const [file, items] of groups) {
    const names = items.map((i) => i.split('\n')[0]!.slice(4));
    out.push(`- \`${file}\`: ${names.map((n) => `[${n}](#${n.toLowerCase()})`).join(', ')}`);
  }
  out.push('');
  for (const [file, items] of groups) out.push(`## \`${file}\``, '', ...items, '');
  mkdirSync(join(ROOT, 'docs/reference'), { recursive: true });
  writeFileSync(join(ROOT, 'docs/reference', `${entry.page}.md`), out.join('\n').replace(/\n{3,}/g, '\n\n'));
  console.log(`${entry.page}: ${count} exports`);
}

if (missing.length) {
  console.log(`\n${missing.length} exports/members without TSDoc:`);
  for (const m of missing) console.log(`  ${m}`);
  if (process.argv.includes('--check')) process.exitCode = 1;
}
