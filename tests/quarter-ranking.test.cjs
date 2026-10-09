const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '../html/季度评分排行榜.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const app = scripts.find(s => s.includes('let RAW = []'));

function load({ excel = false, importing = false } = {}) {
  const context = vm.createContext({ alert: message => { throw new Error(message); } });
  if (excel) vm.runInContext(scripts.find(s => s.includes('make_xlsx_lib')), context);
  vm.runInContext(app.slice(0, app.indexOf('// 季度选择：')), context);
  const parser = app.slice(app.indexOf('function findHeaderRow('), app.indexOf('function splitCSV('));
  vm.runInContext(parser, context);
  vm.runInContext(app.slice(app.indexOf('function refreshQuarters('), app.indexOf('function applyImport(')), context);
  if (importing) {
    vm.runInContext(`globalThis.messages = []; alert = message => messages.push(message);
      globalThis.confirm = () => true; globalThis.render = () => {};
      globalThis.document = { getElementById: () => ({ classList: { contains: () => false } }) };`, context);
    vm.runInContext(app.slice(app.indexOf('function applyImport('), app.indexOf('function importExcel(')), context);
  }
  vm.runInContext(app.slice(app.indexOf('function exportExcel('), app.indexOf('// 初始化部门过滤状态')), context);
  vm.runInContext('rebuildExcluded()', context);
  return expression => JSON.parse(JSON.stringify(vm.runInContext(expression, context) ?? null));
}

test('excludes only the intersection of risk and reviewer, with independent department exclusions', () => {
  const run = load();
  assert.deepEqual(run(`[
    [80, '测试部', '', '张三', '2026/07/01', '', '', '1', 'B', '陈倩倩'],
    [80, '测试部', '', '张三', '2026/07/01', '', '', '2', 'C', '陈忠金'],
    [80, '测试部', '', '张三', '2026/07/01', '', '', '3', 'A', '陈倩倩'],
    [80, '测试部', '', '张三', '2026/07/01', '', '', '4', 'B', '其他人员'],
    [80, '测试部', '', '张三', '2026/07/01', '', '', '5', '', '陈倩倩'],
    [80, '测试部', '', '张三', '2026/07/01', '', '', '6', 'B', ''],
    [80, '矿权部', '', '张三', '2026/07/01', '', '', '7', 'A', '其他人员']
  ].map(rowExcluded)`), [true, true, false, false, false, false, true]);
});

test('import preserves filter fields and accepts reference header aliases', () => {
  const run = load();
  for (const headers of [['业务风险', '三级复核人'], ['风险类型', '三审人员']]) {
    const rows = [['报告质量评分', '部门', '创建时间', ...headers], [88, '测试部', '2026/07/01', ' b ', ' 陈倩倩 ']];
    assert.deepEqual(run(`extractRows(${JSON.stringify(rows)}, 0, 'fixture')[0].slice(8)`), ['B', '陈倩倩']);
  }
  assert.deepEqual(run(`extractRows([['报告质量评分','部门','创建时间'],[88,'测试部','2026/07/01']],0,'legacy')[0].slice(8)`), ['', '']);
});

test('historical quarter and annual scores use filtered reports and weighted annual averages', () => {
  const run = load();
  run(`RAW = [
    [90,'测试部','','张三','2026/07/01','','张三','1','A','陈倩倩'],
    [80,'测试部','','张三','2026/04/01','','李四','2','A','陈倩倩'],
    [20,'测试部','','张三','2026/05/01','','','3','B','陈倩倩'],
    [60,'测试部','','张三','2026/01/01','','','4','B','其他人员'],
    [40,'测试部','','张三','2025/01/01','','','5','A','陈倩倩'],
    [100,'测试部','','张三','2025/04/01','','','6','A','陈倩倩'],
    [100,'测试部','','张三','2025/04/02','','','7','A','陈倩倩'],
    [0,'测试部','','张三','2025/04/03','','','8','A','陈倩倩'],
    [100,'测试部','','张三','2027/01/01','','','9','A','陈倩倩']
  ]`);
  assert.deepEqual(run(`historyData(2026*4+2).map(p => [p.label, p.dept.get('测试部') ?? null, p.app.get('张三') ?? null])`), [
    ['二季度平均分', 80, 80], ['一季度平均分', 60, 60],
    ['2025年度平均分', 80, 80], ['2024年度平均分', null, null], ['2023年度平均分', null, null]
  ]);
  assert.deepEqual(run(`historyData(2026*4).map(p => p.label)`), ['2025年度平均分', '2024年度平均分', '2023年度平均分']);
  assert.deepEqual(run(`compute(2026*4+2).app.map(o => [o.name,o.n])`), [['张三', 1]]);
});

test('selectable A and temporary reviewers obey AND semantics; empty groups disable the combination', () => {
  const run = load();
  run(`RAW = [
    [80,'测试部','','张三','2026/07/01','','','1','A','陈倩倩'],
    [70,'测试部','','李四','2026/07/01','','','2','B','临时人员']
  ]`);
  assert.equal(run('compute(2026*4+2).total'), 2);
  run(`excludedRisks.add('A'); excludedReviewers.add('临时人员'); addedReviewers.add('临时人员')`);
  assert.equal(run('compute(2026*4+2).total'), 0);
  assert.deepEqual(run('reviewerOptions()'), ['陈倩倩', '池生禄', '刘俊杰', '黄云川', '秦向红', '童海方', '陈春立', '陈忠金', '临时人员']);
  run('excludedRisks.clear()');
  assert.equal(run('compute(2026*4+2).total'), 2);
  run(`excludedRisks.add('B'); excludedReviewers.clear()`);
  assert.equal(run('compute(2026*4+2).total'), 2);
});

test('selected imported reviewers stay available after replacing or clearing report data', () => {
  const run = load();
  run(`RAW = [[80,'测试部','','张三','2026/07/01','','','1','B','数据人员']]; excludedReviewers.add('数据人员')`);
  run('RAW = []');
  assert.deepEqual(run('reviewerOptions()'), ['陈倩倩', '池生禄', '刘俊杰', '黄云川', '秦向红', '童海方', '陈春立', '陈忠金', '数据人员']);
});

test('temporary reviewers follow imported and retained selections in addition order without duplicates', () => {
  const run = load();
  run(`RAW = [
    [80,'测试部','','张三','2026/07/01','','','1','B','甲人员'],
    [80,'测试部','','张三','2026/07/01','','','2','B','乙人员']
  ]; excludedReviewers.add('已选人员');
  addedReviewers.add('临时一'); excludedReviewers.add('临时一');
  addedReviewers.add('乙人员'); excludedReviewers.add('乙人员');
  addedReviewers.add('临时二'); excludedReviewers.add('临时二');`);
  const options = run('reviewerOptions()');
  assert.deepEqual(options.slice(-3), ['临时一', '乙人员', '临时二']);
  assert.ok(options.indexOf('甲人员') < options.indexOf('临时一'));
  assert.ok(options.indexOf('已选人员') < options.indexOf('临时一'));
  assert.equal(options.filter(name => name === '乙人员').length, 1);
});

test('appending complete records enriches legacy duplicates so compound filtering takes effect', () => {
  const run = load({ importing: true });
  run(`applyImport(extractRows([
    ['报告质量评分','部门','创建时间','报告审核流水号'],
    [80,'测试部','2026/07/01','1']
  ],0,'legacy'),'legacy')`);
  assert.equal(run('compute(2026*4+2).total'), 1);
  run(`applyImport(extractRows([
    ['报告质量评分','部门','创建时间','报告审核流水号','业务风险','三级复核人'],
    [80,'测试部','2026/07/01','1','B','陈倩倩']
  ],0,'complete'),'complete')`);
  assert.equal(run('RAW.length'), 1);
  assert.deepEqual(run('RAW[0].slice(8)'), ['B', '陈倩倩']);
  assert.equal(run('compute(2026*4+2).total'), 0);
});

test('duplicate enrichment combines compatible partial fields only within the same scored version', () => {
  const run = load();
  run(`RAW = [
    [80,'测试部','','张三','2026/07/01','','','1','B',''],
    [80,'测试部','','张三','2026/07/01','','','1','','陈倩倩'],
    [80,'测试部','','张三','2026/07/02','','','2','',''],
    [80,'测试部','','张三','2026/07/01','','','2','B','陈倩倩'],
    [80,'测试部','','张三','2026/07/01','','','3','',''],
    [0,'测试部','','张三','2026/07/01','','','3','B','陈倩倩'],
    [80,'测试部','','张三','2026/07/01','','','4','A',''],
    [80,'测试部','','张三','2026/07/01','','','4','B','陈倩倩'],
    [80,'测试部','','张三','2026/07/01','','','5','',''],
    [90,'测试部','','张三','2026/07/01','','','5','B','陈倩倩']
  ]; dedupRaw()`);
  assert.deepEqual(run('RAW.map(r => r.slice(8))'), [['B','陈倩倩'], ['',''], ['',''], ['A',''], ['','']]);
  assert.equal(run('compute(2026*4+2).total'), 4);
});

test('import warning counts missing fields in retained data rather than only incoming rows', () => {
  const run = load({ importing: true });
  run(`RAW = [[80,'测试部','','张三','2026/07/01','','','old','','']];
    applyImport([[90,'测试部','','张三','2026/07/01','','','new','A','其他人员']],'complete')`);
  assert.match(run('messages.at(-1)'), /1 条有效报告缺少业务风险或三级复核人/);
});

test('discarded legacy duplicates do not trigger a missing-field import warning', () => {
  const run = load({ importing: true });
  run(`RAW = [[80,'测试部','','张三','2026/07/01','','','1','B','陈倩倩']];
    applyImport([[80,'测试部','','张三','2026/07/01','','','1','','']],'legacy')`);
  assert.doesNotMatch(run('messages.at(-1)'), /缺少业务风险或三级复核人/);
});

test('Excel export preserves history, combination settings and original filter fields for reimport', () => {
  const run = load({ excel: true });
  run(`RAW = [
    [95,'测试部','','张三','2026/07/01','','张三','1','A','陈倩倩'],
    [10,'测试部','','张三','2026/07/02','','','2','B','陈倩倩'],
    [90,'测试部','','张三','2026/04/01','','','3','A','陈倩倩'],
    [70,'测试部','','张三','2025/04/01','','','4','A','陈倩倩']
  ]; refreshQuarters(); currentQ = 2026*4+2; excludedReviewers.add('已选但当前无报告');
  XLSX.writeFile = wb => { globalThis.exportedBytes = XLSX.write(wb, {bookType:'xlsx', type:'array'}); };
  exportExcel(); globalThis.exported = XLSX.read(exportedBytes, {type:'array'});`);
  assert.deepEqual(run(`XLSX.utils.sheet_to_json(exported.Sheets['部门排名'], {header:1})[1]`),
    [1, '测试部', '—', 1, 95, 90, 5, 1, 0, 90, '-', 70, '-', '-']);
  assert.deepEqual(run(`XLSX.utils.sheet_to_json(exported.Sheets['签字评估师排名'], {header:1})[1].slice(8)`), [90, '-', 70, '-', '-']);
  assert.deepEqual(run(`extractRows(XLSX.utils.sheet_to_json(exported.Sheets['原始数据'], {header:1}), 0, 'roundtrip').map(r => r.slice(8))`),
    [['A','陈倩倩'], ['B','陈倩倩'], ['A','陈倩倩'], ['A','陈倩倩']]);
  assert.deepEqual(run(`XLSX.utils.sheet_to_json(exported.Sheets['过滤设置'], {header:1}).filter(r => r[0] === '业务风险').map(r => r[1])`), ['B', 'C']);
  assert.equal(run(`XLSX.utils.sheet_to_json(exported.Sheets['过滤设置'], {header:1}).filter(r => r[0] === '三级复核人' && r[1] === '已选但当前无报告').length`), 1);
});
