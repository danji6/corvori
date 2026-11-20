import {
  analyzeShellCommand,
  analyzeShellPathCandidates,
  isReadOnlyShellCommand,
  isShellCommandAutoApproved,
} from '@cv/convex/lib/tool/approval'
import { describe, expect, test } from 'bun:test'

const NUMBERED_FILES =
  "nl -ba packages/client/src/hooks/chat/settings-save.ts | sed -n '1,240p'; printf '\\n--- form draft ---\\n'; nl -ba packages/client/src/hooks/chat/form-draft.ts | sed -n '1,220p'; printf '\\n--- editor draft store ---\\n'; nl -ba packages/client/src/lib/chat/editor-draft-store.ts | sed -n '1,260p'"
const GIT_LISTINGS = 'git branch -a && git tag --sort=-creatordate | head -20'

describe('read-only shell queries', () => {
  test('recognizes lookup flags without allowing command execution', () => {
    expect(isReadOnlyShellCommand('command -V bun rg')).toBe(true)
    expect(isReadOnlyShellCommand('command -v -- bun')).toBe(true)
    expect(analyzeShellPathCandidates('command -V bun rg')).toEqual({
      candidates: [],
      complete: true,
    })
    expect(isReadOnlyShellCommand('command bun run build')).toBe(false)
    expect(isReadOnlyShellCommand('command -p bun run build')).toBe(false)
    expect(analyzeShellPathCandidates('command -v /outside/bun')).toEqual({
      candidates: ['/outside/bun'],
      complete: true,
    })
  })

  test.each(['test -f README.md', '[ -f README.md ]'])(
    'recognizes simple file tests: %s',
    (command) => {
      expect(isReadOnlyShellCommand(command)).toBe(true)
      expect(analyzeShellPathCandidates(command)).toEqual({
        candidates: ['README.md'],
        complete: true,
      })
    },
  )

  test.each(['test "$?" -eq 1', '[ "$?" -ne 0 ]', 'test -2 -lt +1'])(
    'recognizes numeric tests without path operands: %s',
    (command) => {
      expect(isReadOnlyShellCommand(command)).toBe(true)
      expect(analyzeShellPathCandidates(command)).toEqual({
        candidates: [],
        complete: true,
      })
    },
  )

  test.each([
    'test "$value" -eq 1',
    'test "$(cat README.md)" -eq 1',
    'test "$?" -eq 1 > output.txt',
  ])('keeps dynamic tests and output redirects gated: %s', (command) => {
    expect(isReadOnlyShellCommand(command)).toBe(false)
  })

  test.each([
    'git diff --output=report.txt',
    'git log --ext-diff',
    'git show --future-option HEAD',
    'sort -o sorted.txt README.md',
    'uniq README.md unique.txt',
    'tree -o listing.txt src',
    'tree -L 2 -R src',
  ])('does not auto-approve writes or opaque options: %s', (command) => {
    expect(isReadOnlyShellCommand(command)).toBe(false)
  })

  test.each([NUMBERED_FILES, GIT_LISTINGS])(
    'recognizes the reported command: %s',
    (command) => {
      expect(isReadOnlyShellCommand(command)).toBe(true)
      expect(analyzeShellCommand(command, [])).toMatchObject({
        unapproved: [],
        unsafe: false,
      })
      expect(analyzeShellPathCandidates(command).complete).toBe(true)
    },
  )

  test.each([
    'nl',
    'tac',
    'paste',
    'join',
    'fold',
    'fmt',
    'expand',
    'unexpand',
    'od',
  ])(
    'allows %s while preserving file checks and redirect restrictions',
    (program) => {
      expect(isReadOnlyShellCommand(`${program} src/file.txt`)).toBe(true)
      expect(analyzeShellPathCandidates(`${program} src/file.txt`)).toEqual({
        candidates: ['src/file.txt'],
        complete: true,
      })
      expect(
        isReadOnlyShellCommand(`${program} src/file.txt > output.txt`),
      ).toBe(false)
    },
  )

  test.each([
    'git branch',
    'git branch -a',
    'git branch -avv',
    'git branch -r',
    'git branch --list "feature/*"',
    'git branch --show-current',
    'git branch --contains HEAD',
    'git branch --merged',
    'git branch --sort -committerdate',
    'git tag',
    'git tag --sort=-creatordate',
    'git tag -l "v*"',
    'git tag -l -n5',
    'git tag --contains HEAD',
    'git for-each-ref --format="%(refname)" refs/heads/',
    'git ls-remote --heads origin',
    'git stash list',
    'git stash list --oneline -5',
    'git worktree list',
    'git worktree list --porcelain -z',
    'git reflog show',
    'git reflog show HEAD --date=iso -n 10',
    'git -C src branch -a',
    'git -Csrc branch -a',
    'git --git-dir /repo/.git tag -l',
  ])('allows listing form: %s', (command) => {
    expect(isReadOnlyShellCommand(command)).toBe(true)
  })

  test.each([
    'git branch feature',
    'git branch feature HEAD',
    'git branch -- feature',
    'git branch -d feature',
    'git branch -aD feature',
    'git branch -m old new',
    'git branch -c old new',
    'git branch --set-upstream-to=origin/main',
    'git branch --unset-upstream',
    'git branch --edit-description',
    'git branch --list --delete feature',
    'git branch --list --no-list feature',
    'git branch --future-flag',
    'git branch --sort',
    'git tag v1',
    'git tag --sort=-creatordate v1',
    'git tag -- v1',
    'git tag -a v1',
    'git tag -d v1',
    'git tag -f v1 HEAD',
    'git tag -l --delete v1',
    'git tag --list --no-list v1',
    'git tag --format',
    'git stash',
    'git stash push',
    'git stash pop',
    'git stash clear',
    'git stash list --output=/tmp/history',
    'git stash list --pretty --output=/tmp/history',
    'git reflog show --format --output=/tmp/history',
    'git worktree add ../other',
    'git worktree remove ../other',
    'git reflog expire --all',
    'git reflog delete HEAD@{0}',
    'git for-each-ref --output=/tmp/refs',
    'git ls-remote --upload-pack=custom origin',
    'git ls-remote --exec=custom origin',
    'git -C src branch -D feature',
    'git --git-dir=/repo/.git tag v1',
    'git tag -l && git tag v1',
  ])(
    'requires approval for mutations or unrecognized options: %s',
    (command) => {
      expect(isReadOnlyShellCommand(command)).toBe(false)
    },
  )

  test('nested listing grants do not cover mutations', () => {
    expect(analyzeShellCommand('git stash list', []).patterns).toEqual([
      'git stash list',
    ])
    expect(
      isShellCommandAutoApproved('git stash pop', ['git stash list']),
    ).toBe(false)
    expect(isShellCommandAutoApproved('git branch new', ['git branch'])).toBe(
      true,
    )
    expect(isReadOnlyShellCommand('git branch new')).toBe(false)
  })

  test('ref names and formats are data while global repository paths are checked', () => {
    expect(analyzeShellPathCandidates('git -C/outside branch -a')).toEqual({
      candidates: ['/outside'],
      complete: true,
    })
    expect(analyzeShellPathCandidates('git branch --list ".git/*"')).toEqual({
      candidates: [],
      complete: true,
    })
    expect(
      analyzeShellPathCandidates('git -C /outside tag --format="%(refname)"'),
    ).toEqual({ candidates: ['/outside'], complete: true })
    expect(
      analyzeShellPathCandidates('git --git-dir=/outside/.git worktree list'),
    ).toEqual({ candidates: ['/outside/.git'], complete: true })
    expect(
      analyzeShellPathCandidates('git ls-remote /outside/repo').candidates,
    ).toContain('/outside/repo')
  })

  test('Git diff checks include repository paths and explicit pathspecs', () => {
    expect(analyzeShellPathCandidates('git diff --check').candidates).toEqual(
      [],
    )
    expect(
      analyzeShellPathCandidates('git -C/outside diff --check -- src/view.ts')
        .candidates,
    ).toEqual(['/outside', 'src/view.ts'])
  })

  test.each([
    ['git status --porcelain=v2', []],
    ['git status -sb -uno -- README.md', ['README.md']],
    ['git diff --cached --check', []],
    [
      'git diff --no-index -- README.md ../README.md',
      ['README.md', '../README.md'],
    ],
    [
      'git log --since "1 week ago" -n 10 --format="%h %s" HEAD -- README.md',
      ['README.md'],
    ],
    ['git show --format=fuller HEAD -- README.md', ['README.md']],
    ['git log -- README.md', ['README.md']],
    ['git log README.md', ['README.md']],
    ['git ls-files -z -- README.md', ['README.md']],
    ['git rev-parse --verify HEAD', []],
  ] as const)(
    'classifies Git inspection operands: %s',
    (command, candidates) => {
      expect(isReadOnlyShellCommand(command)).toBe(true)
      expect(analyzeShellPathCandidates(command)).toEqual({
        candidates: [...candidates],
        complete: true,
      })
    },
  )
})
