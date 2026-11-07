const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { collectLocalEvidence, resolveGitLink } = require('../scripts/lib/local_evidence');
const { parseRange } = require('../scripts/lib/date_range');

// A ±2 day window absorbs any skew between the UTC calendar day used to build
// the range and the test machine's local timezone (gitCommits' --since/--until
// are interpreted in system-local time), without ever depending on exactly
// which calendar day a commit lands in.
function wideRangeAroundNow() {
    const now = new Date();
    const shift = (days) => {
        const d = new Date(now);
        d.setUTCDate(d.getUTCDate() + days);
        return d.toISOString().slice(0, 10);
    };
    const start = shift(-2);
    const end = shift(2);
    return parseRange(`${start}..${end}`, { timezone: 'UTC', workingDays: [0, 1, 2, 3, 4, 5, 6] });
}

function git(cwd, args) {
    execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function makeRepo(dir) {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, ['init', '-q']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test User']);
    return dir;
}

function commit(dir, file, message) {
    fs.writeFileSync(path.join(dir, file), `${message}\n${Date.now()}\n`);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', message]);
}

test('sibling linked worktree: commits are not duplicated and are attributed to the real case id', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm365ts-wt-'));
    try {
        const client = path.join(root, 'ClientX');
        const main = makeRepo(path.join(client, 'CAS-999999-A1B2 - Sample Case'));
        commit(main, 'file1.txt', 'feat: initial commit for CAS-999999-A1B2');
        git(main, ['branch', 'wt-cas999999-feature']);

        const worktree = path.join(client, 'wt-cas999999-feature');
        git(main, ['worktree', 'add', worktree, 'wt-cas999999-feature']);
        commit(worktree, 'file2.txt', 'fix: worktree commit for CAS-999999-A1B2');

        const range = wideRangeAroundNow();
        const local = collectLocalEvidence({ casesRoot: root, range, ignoreFolders: [], folderToClient: {} });

        // Both physical folders fold into exactly one case entry.
        assert.equal(local.cases.length, 1);
        const kase = local.cases[0];
        assert.equal(kase.caseId, 'CAS-999999-A1B2');
        assert.equal(kase.folderName, 'CAS-999999-A1B2 - Sample Case');
        assert.deepEqual(kase.linkedWorktrees, ['wt-cas999999-feature']);

        // Exactly 2 commits total (one from main, one from the worktree) -
        // not 4, which is what independently scanning both folders with
        // `git log --all` would produce since every worktree sees every ref.
        const totalCommits = Object.values(kase.days).reduce((s, d) => s + d.commits.length, 0);
        assert.equal(totalCommits, 2);
        assert.ok(local.knownIds.includes('CAS-999999-A1B2'));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('nested .worktrees/<branch> folder stays part of the same single case', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm365ts-wt-nested-'));
    try {
        const client = path.join(root, 'ClientY');
        const main = makeRepo(path.join(client, 'CAS-888888-C3D4 - Another Case'));
        commit(main, 'file1.txt', 'feat: initial commit for CAS-888888-C3D4');
        git(main, ['branch', 'session-branch']);

        const nestedWorktree = path.join(main, '.worktrees', 'session-branch');
        git(main, ['worktree', 'add', nestedWorktree, 'session-branch']);
        commit(nestedWorktree, 'file2.txt', 'chore: nested worktree commit for CAS-888888-C3D4');

        const range = wideRangeAroundNow();
        const local = collectLocalEvidence({ casesRoot: root, range, ignoreFolders: [], folderToClient: {} });

        assert.equal(local.cases.length, 1);
        const kase = local.cases[0];
        assert.equal(kase.caseId, 'CAS-888888-C3D4');
        const totalCommits = Object.values(kase.days).reduce((s, d) => s + d.commits.length, 0);
        assert.equal(totalCommits, 2);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a directory junction aliasing the same repo under a different name does not duplicate commits, and the concrete case id wins over a CAS-PENDING placeholder', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm365ts-wt-junction-'));
    try {
        const client = path.join(root, 'ClientZ');
        const real = makeRepo(path.join(client, 'CAS-777777-E5F6 - Real Case'));
        commit(real, 'file1.txt', 'feat: initial commit for CAS-777777-E5F6');

        // Mirrors a real layout found under CASES_ROOT: an old "CAS-PENDING"
        // folder left as a junction pointing at the case once it got its real
        // number, so both names resolve to the exact same repository.
        const aliasPath = path.join(client, 'CAS-PENDING - Old Placeholder Name');
        fs.symlinkSync(real, aliasPath, 'junction');

        const range = wideRangeAroundNow();
        const local = collectLocalEvidence({ casesRoot: root, range, ignoreFolders: [], folderToClient: {} });

        assert.equal(local.cases.length, 1);
        const kase = local.cases[0];
        assert.equal(kase.caseId, 'CAS-777777-E5F6');
        assert.equal(kase.folderName, 'CAS-777777-E5F6 - Real Case');
        const totalCommits = Object.values(kase.days).reduce((s, d) => s + d.commits.length, 0);
        assert.equal(totalCommits, 1);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('resolveGitLink: main checkout, linked worktree and no-git folder', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm365ts-wt-resolve-'));
    try {
        const main = makeRepo(path.join(root, 'main-repo'));
        commit(main, 'a.txt', 'init');
        git(main, ['branch', 'b1']);
        const worktree = path.join(root, 'linked-worktree');
        git(main, ['worktree', 'add', worktree, 'b1']);

        const plain = path.join(root, 'no-git-folder');
        fs.mkdirSync(plain, { recursive: true });

        const mainLink = resolveGitLink(main);
        const wtLink = resolveGitLink(worktree);
        const noneLink = resolveGitLink(plain);

        assert.equal(mainLink.kind, 'main');
        assert.equal(wtLink.kind, 'worktree');
        assert.equal(wtLink.mainDir.toLowerCase(), mainLink.mainDir.toLowerCase());
        assert.equal(noneLink.kind, 'none');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
