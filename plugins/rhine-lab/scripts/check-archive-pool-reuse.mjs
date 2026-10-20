import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { idleWave, settlingWave } from '../src/motion.ts';
import { poolCell, visibleCell } from '../src/archive-loop.ts';

const source = await readFile(new URL('../src/scene.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('scene.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const klass = tree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ArchiveScene');
const update = klass.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(tree) === 'update');
const declaration = update.body.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(tree) === 'previousSlopeRow'));
const loop = update.body.statements.find(node => ts.isForStatement(node) && node.getText(tree).includes('const upperSlope ='));
const statements = [...loop.statement.statements];
const first = statements.findIndex(node => node.getText(tree).startsWith('const upperSlope ='));
const last = statements.findIndex(node => node.getText(tree).startsWith('const slope ='));
const compiled = ts.transpileModule(`return function(cells, field) {
  ${declaration.getText(tree)}
  const slopes = [];
  for (const {row, lane} of cells) {
    ${statements.slice(first, last + 1).map(node => node.getText(tree)).join('\n')}
    slopes.push(slope);
  }
  return slopes;
};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const sample = new Function(compiled)();
const target = { lane: 0, row: 0 };
for (const rows of [32, 68]) for (const center of [{lane:-2004,row:-9012}, {lane:2.3,row:12.4}, {lane:2117,row:30002}]) {
  const cells = [];
  for (let i = 0; i < rows * 9; i++) {
    assert.equal(poolCell(i, rows, target), target);
    assert.deepEqual(target, poolCell(i, rows));
    const expected = visibleCell(i, center, rows);
    assert.equal(visibleCell(i, center, rows, target), target);
    assert.deepEqual(target, expected, 'Pooled coordinate storage preserves the physical cell');
    cells.push({ ...target });
  }
  const field = (row, lane) => idleWave(row, lane, 31) + settlingWave(row - 12, 26.56);
  let evaluations = 0;
  const slopes = sample(cells, (row, lane) => { evaluations++; return field(row, lane); });
  assert.deepEqual(slopes, cells.map(({ row, lane }) => field(row + .5, lane) - field(row - .5, lane)));
  assert.ok(evaluations <= 9 * (rows + 2), 'Both wrapped row boundaries and lane changes invalidate the shared sample');
  assert.deepEqual(sample([...cells].reverse(), field), [...cells].reverse().map(({ row, lane }) => field(row + .5, lane) - field(row - .5, lane)));
}
const discontinuous = [{row:12,lane:2}, {row:12,lane:11}, {row:9001,lane:11}, {row:12.25,lane:-2}, {row:13.25,lane:-2}];
assert.deepEqual(sample(discontinuous, idleWave), discontinuous.map(({row,lane}) => idleWave(row+.5,lane) - idleWave(row-.5,lane)));
console.log('Production shared slopes and pooled cells passed: exact values, wrapped rows, negative/distant coordinates, reversed/discontinuous traversal and per-call invalidation.');
