import { readdirSync, readFileSync } from 'fs';
import { basename, join, relative, sep } from 'path';

const ORG_ROOT = join(__dirname, '..');
const FIXTURE = join(
  __dirname,
  '__fixtures__',
  'compares-role-keys.fixture.txt',
);
// The only files allowed to name role keys: the permission list and the
// DTO-validation constant. Tests seed roles by key and are not scanned.
const ALLOWED = new Set(['permissions.ts', 'role-keys.ts']);
const ROLE_KEY_LITERAL = /(['"`])(?:admin|member)\1/;

/** `file:line` of every role key string literal, in any context. */
function roleKeyLiterals(files: Array<string>): Array<string> {
  return files.flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, i) =>
        ROLE_KEY_LITERAL.test(line)
          ? [`${relative(ORG_ROOT, file)}:${i + 1}`]
          : [],
      ),
  );
}

function orgSources(): Array<string> {
  return readdirSync(ORG_ROOT, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
    .filter((file) => !file.split(sep).includes('__tests__'))
    .filter((file) => !ALLOWED.has(basename(file)))
    .map((file) => join(ORG_ROOT, file));
}

// Authorization reads permissions from roles in the database; code that
// names a role key bypasses that and breaks with custom roles.
describe('no role-key literals in src/modules/org', () => {
  it('flags every role key literal in the fixture', () => {
    const fixture = relative(ORG_ROOT, FIXTURE);

    expect(roleKeyLiterals([FIXTURE])).toEqual(
      [3, 4, 6, 9, 12].map((line) => `${fixture}:${line}`),
    );
  });

  it('finds none in the org module', () => {
    const files = orgSources();

    expect(files.length).toBeGreaterThan(0);
    expect(roleKeyLiterals(files)).toEqual([]);
  });
});
