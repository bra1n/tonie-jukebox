// Turns an lcov coverage report into a Markdown table for the GitHub Actions job summary.
// Usage: node scripts/coverage-summary.js lcov.info >> "$GITHUB_STEP_SUMMARY"
const fs = require('node:fs');

const THRESHOLDS = { lines: 80, branches: 70, functions: 80 }; // keep in sync with the "coverage" npm script

// Parse lcov records ("SF:file" ... "end_of_record") into per-file hit / found counts
function parseLcov(text) {
  const files = [];
  let file;
  for (const line of text.split('\n')) {
    const [key, value = ''] = line.split(/:(.*)/);
    if (key === 'SF') {
      file = { name: value, lines: [0, 0], branches: [0, 0], functions: [0, 0], uncovered: [] };
      files.push(file);
    } else if (file) {
      if (key === 'LH') file.lines[0] = Number(value);
      if (key === 'LF') file.lines[1] = Number(value);
      if (key === 'BRH') file.branches[0] = Number(value);
      if (key === 'BRF') file.branches[1] = Number(value);
      if (key === 'FNH') file.functions[0] = Number(value);
      if (key === 'FNF') file.functions[1] = Number(value);
      if (key === 'DA' && value.split(',')[1] === '0') file.uncovered.push(Number(value.split(',')[0]));
    }
  }
  return files;
}

const percent = ([hit, found]) => (found ? (hit / found) * 100 : 100);

// The minimum only applies to all files combined, so files below it are a warning, not a failure
function cell(counts, threshold, failIcon = '🟡') {
  const value = percent(counts);
  return `${value >= threshold ? '🟢' : failIcon} ${value.toFixed(1)}%`;
}

// [1, 2, 3, 7, 9, 10] -> "1-3, 7, 9-10"
function ranges(lines) {
  const parts = [];
  for (let i = 0; i < lines.length; i++) {
    const start = lines[i];
    while (lines[i + 1] === lines[i] + 1) i++;
    parts.push(start === lines[i] ? `${start}` : `${start}-${lines[i]}`);
  }
  return parts.join(', ');
}

function summary(files) {
  const sum = (key) => files.reduce(([h, f], file) => [h + file[key][0], f + file[key][1]], [0, 0]);
  const total = { name: '**All files**', lines: sum('lines'), branches: sum('branches'), functions: sum('functions'), uncovered: [] };
  const row = (f, failIcon) =>
    `| ${f.name} | ${cell(f.lines, THRESHOLDS.lines, failIcon)} | ${cell(f.branches, THRESHOLDS.branches, failIcon)} | ` +
    `${cell(f.functions, THRESHOLDS.functions, failIcon)} | ${ranges(f.uncovered)} |`;

  return [
    '## Test coverage',
    '',
    `Required for all files combined: ${THRESHOLDS.lines}% lines, ${THRESHOLDS.branches}% branches, ${THRESHOLDS.functions}% functions. ` +
      'Single files below that are marked 🟡 but don\'t fail the build.',
    '',
    '| File | Lines | Branches | Functions | Uncovered lines |',
    '| --- | --- | --- | --- | --- |',
    ...files.map((f) => row(f)),
    row(total, '🔴'),
    '',
  ].join('\n');
}

if (require.main === module) {
  const file = process.argv[2] || 'lcov.info';
  if (!fs.existsSync(file)) {
    console.log(`## Test coverage\n\nNo coverage report found at \`${file}\`, the tests probably didn't run.\n`);
  } else {
    console.log(summary(parseLcov(fs.readFileSync(file, 'utf8'))));
  }
}
