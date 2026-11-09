import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';

const ORG_ROOT = join(__dirname, '..');
const FIXTURE = join(
  __dirname,
  '__fixtures__',
  'compares-role-keys.fixture.txt',
);

const ROLE_KEY = String.raw`(?:'(?:admin|member)'|"(?:admin|member)"|\x60(?:admin|member)\x60)`;
const COMPARISON = new RegExp(
  String.raw`(?:[!=]==?\s*${ROLE_KEY})|(?:${ROLE_KEY}\s*[!=]==?)|(?:\bcase\s+${ROLE_KEY})`,
);

/** `file:line` of every comparison against a role key literal. */
function roleKeyComparisons(files: Array<string>): Array<string> {
  return files.flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, i) =>
        COMPARISON.test(line) ? [`${relative(ORG_ROOT, file)}:${i + 1}`] : [],
      ),
  );
}

function orgSources(): Array<string> {
  return readdirSync(ORG_ROOT, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts'))
    .filter((file) => !file.endsWith(join('permissions', 'permissions.ts')))
    .map((file) => join(ORG_ROOT, file));
}

// Authorization reads permissions from roles in the database; code that
// branches on a role key bypasses that and breaks with custom roles.
describe('no role-name comparisons in src/modules/org', () => {
  it('fails when code compares role keys', () => {
    expect(roleKeyComparisons([FIXTURE])).toHaveLength(4);
  });

  it('finds none in the org module', () => {
    const files = orgSources();

    expect(files.length).toBeGreaterThan(0);
    expect(roleKeyComparisons(files)).toEqual([]);
  });
});
