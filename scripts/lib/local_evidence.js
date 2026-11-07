/**
 * Local evidence collector.
 *
 * The consultant's real work leaves two durable traces on disk inside each case
 * folder under CASES_ROOT: local git history (recent cases) and file
 * modification times (all cases). Both are collected here and converted to the
 * *timesheet* timezone, so a late-night commit in Buenos Aires lands on the
 * right US/Eastern day.
 *
 * Case folders are not always a single checkout: a linked git worktree (e.g. a
 * sibling "wt-<case>-<slug>" folder, or a nested ".worktrees/<branch>" folder
 * used by AI coding sessions), or a plain directory junction/symlink left
 * behind aliasing an old folder name to the real one, shares the exact same
 * files and git object database as the repo it points at - so `git log --all`
 * run anywhere in that repo already returns every commit made in every one of
 * its worktrees. Folders are therefore grouped by their resolved common git
 * directory before scanning, so the same commits are never counted twice and
 * are always attributed to the case whose folder name actually carries the
 * case id.
 *
 * This module never writes anything and never touches a case folder.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CASE_ID_RE = /\b(CAS-\d{6,8}(?:-[A-Z0-9]{4})?|CAS-PENDING|INT-\d{3,6}|REQ-\d{3,6}|TASK-\d{3,6})\b/i;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.vs', 'bin', 'obj', '.venv', '__pycache__', 'dist', 'packages']);
const MAX_FILES_PER_DAY = 25;
const MAX_DEPTH = 5;

// Automatic checkpoint commits carry two GUIDs and no information about the
// work, so they would burn the evidence budget without telling Copilot anything.
const NOISE_COMMIT_RE = /^(copilot checkpoint:|wip$|checkpoint$|auto-?save)/i;

function isoInZone(date, timeZone) {
    try {
        return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
    } catch (e) {
        return date.toISOString().slice(0, 10);
    }
}

function timeInZone(date, timeZone) {
    try {
        return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
    } catch (e) {
        return date.toISOString().slice(11, 16);
    }
}

function safeDirs(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true })
            .filter((e) => {
                if (e.isDirectory()) return true;
                // Windows reports a directory junction/symlink (e.g. an old case
                // folder name left aliasing its real one) as a symbolic link
                // dirent, not a directory one - without this it would be
                // silently invisible to the whole scanner, evidence included.
                if (!e.isSymbolicLink()) return false;
                try {
                    return fs.statSync(path.join(dir, e.name)).isDirectory();
                } catch (err) {
                    return false;
                }
            })
            .map((e) => e.name);
    } catch (e) {
        return [];
    }
}

/**
 * Resolves `p` to its canonical on-disk path. Windows can hand back an 8.3
 * short-name alias (e.g. "DOCUME~1") for part of a path in some contexts -
 * notably the "gitdir:" pointer a `git worktree add` writes under a temp or
 * deeply-nested directory - which would otherwise make the very same folder
 * compare unequal to its own long-form path. A plain `path.resolve` is
 * lexical and does not fix this, so the real filesystem entry is consulted.
 */
function safeRealpath(p) {
    try {
        return fs.realpathSync.native(p);
    } catch (e) {
        try {
            return fs.realpathSync(p);
        } catch (e2) {
            return path.resolve(p);
        }
    }
}

/**
 * Determines whether `folder` is a plain repo, a linked git worktree, or
 * neither, and resolves the absolute path of the *main* repo directory it
 * shares a git database with.
 *
 * A main checkout has ".git" as a directory. A linked worktree has ".git" as
 * a file containing "gitdir: <repo>/.git/worktrees/<name>"; that directory's
 * own "commondir" file is the documented, rename-proof way to find the
 * shared ".git" folder (falling back to the standard two-levels-up layout if
 * "commondir" is unreadable).
 *
 * @returns {{kind:'main'|'worktree'|'none', mainDir:string|null}}
 */
function resolveGitLink(folder) {
    const gitPath = path.join(folder, '.git');
    let stat;
    try {
        stat = fs.lstatSync(gitPath);
    } catch (e) {
        return { kind: 'none', mainDir: null };
    }
    if (stat.isDirectory()) return { kind: 'main', mainDir: safeRealpath(folder) };
    if (!stat.isFile()) return { kind: 'none', mainDir: null };

    try {
        const content = fs.readFileSync(gitPath, 'utf8');
        const m = content.match(/gitdir:\s*(.+)/i);
        if (!m) return { kind: 'worktree', mainDir: null };
        const worktreeGitDir = path.resolve(folder, m[1].trim());
        let commonDir;
        try {
            const commondirRaw = fs.readFileSync(path.join(worktreeGitDir, 'commondir'), 'utf8').trim();
            commonDir = path.resolve(worktreeGitDir, commondirRaw);
        } catch (e) {
            commonDir = path.resolve(worktreeGitDir, '..', '..');
        }
        return { kind: 'worktree', mainDir: safeRealpath(path.dirname(commonDir)) };
    } catch (e) {
        return { kind: 'worktree', mainDir: null };
    }
}

function extractCaseId(name) {
    const m = name.match(CASE_ID_RE);
    return m ? m[1].toUpperCase() : null;
}

function caseTitle(folderName) {
    return folderName.replace(CASE_ID_RE, '').replace(/^[\s\-–—_]+/, '').trim() || folderName;
}

/**
 * A top-level folder counts as a client when it looks like one: it carries the
 * per-client helper files, or it holds at least one case-shaped subfolder.
 * Everything else under CASES_ROOT (plugin projects, scratch workspaces,
 * personal repos) is ignored instead of being blacklisted by name.
 */
function looksLikeClientFolder(dir) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
        return false;
    }
    const hasHelper = entries.some((e) => e.isFile() && (/^ENVIRONMENTS\.md$/i.test(e.name) || /^set-account.*\.(ps1|sh)$/i.test(e.name)));
    if (hasHelper) return true;
    return entries.some((e) => e.isDirectory() && CASE_ID_RE.test(e.name));
}

function gitCommits(folder, range, timezone) {
    if (!fs.existsSync(path.join(folder, '.git'))) return [];
    try {
        const out = execFileSync('git', [
            '-C', folder,
            '--no-pager', 'log', '--all', '--no-merges',
            `--since=${range.start}T00:00:00`,
            `--until=${range.end}T23:59:59`,
            '--pretty=format:%aI\u001f%an\u001f%s'
        ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024 });
        return out.split('\n').filter(Boolean).map((line) => {
            const [iso, author, subject] = line.split('\u001f');
            const when = new Date(iso);
            return { date: isoInZone(when, timezone), time: timeInZone(when, timezone), author, subject };
        }).filter((c) => c.subject && !NOISE_COMMIT_RE.test(c.subject.trim()));
    } catch (e) {
        return [];
    }
}

function touchedFiles(folder, range, timezone, startMs, endMs) {
    const hits = [];
    const walk = (dir, depth) => {
        if (depth > MAX_DEPTH || hits.length > 4000) return;
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name)) continue;
                walk(full, depth + 1);
                continue;
            }
            if (!entry.isFile()) continue;
            // A linked worktree's ".git" is a plain "gitdir:" pointer file, not
            // repo content - never meaningful "touched file" evidence.
            if (entry.name === '.git') continue;
            let stat;
            try {
                stat = fs.statSync(full);
            } catch (e) {
                continue;
            }
            const ms = stat.mtimeMs;
            if (ms < startMs || ms > endMs) continue;
            const when = new Date(ms);
            hits.push({
                date: isoInZone(when, timezone),
                time: timeInZone(when, timezone),
                path: path.relative(folder, full).replace(/\\/g, '/')
            });
        }
    };
    walk(folder, 0);
    return hits;
}

/**
 * @param {object} opts
 * @param {string} opts.casesRoot
 * @param {object} opts.range        result of parseRange()
 * @param {string[]} [opts.ignoreFolders]
 * @param {object} [opts.folderToClient]  { "AcmeCorp-TeamFoo": "Acme Corp" }
 * @returns {{cases:Array, byDate:object, knownIds:string[], scanned:number, clients:string[]}}
 */
function collectLocalEvidence({ casesRoot, range, ignoreFolders = [], folderToClient = {} }) {
    const timezone = range.timezone || 'US/Eastern';
    // Widen the mtime window by a day on each side, then filter on the
    // timezone-converted day, so no boundary hour is lost.
    const startMs = new Date(`${range.start}T00:00:00Z`).getTime() - 86400000;
    const endMs = new Date(`${range.end}T23:59:59Z`).getTime() + 86400000;
    const inRange = new Set(range.days);
    const ignore = new Set(ignoreFolders.map((s) => s.toLowerCase()));

    const clients = [];
    const candidates = [];
    let scanned = 0;

    for (const clientFolder of safeDirs(casesRoot)) {
        if (ignore.has(clientFolder.toLowerCase())) continue;
        const clientPath = path.join(casesRoot, clientFolder);
        if (!looksLikeClientFolder(clientPath)) continue;
        const client = folderToClient[clientFolder] || clientFolder;
        clients.push(client);

        for (const caseFolder of safeDirs(clientPath)) {
            if (SKIP_DIRS.has(caseFolder)) continue;
            const folder = path.join(clientPath, caseFolder);
            scanned++;
            const git = resolveGitLink(folder);
            // Folders that share one underlying repository - a case folder plus
            // any linked worktree beside it (e.g. "wt-cas1455097-..."), or a
            // linked worktree whose main checkout lives elsewhere - are grouped
            // under the same key, so `git log --all` (which already sees every
            // branch checked out in any worktree of the repo, main or linked)
            // is only ever run, and only ever counted, once per repository.
            const groupKey = (git.mainDir || safeRealpath(folder)).toLowerCase();
            candidates.push({ client, clientFolder, caseFolder, folder, kind: git.kind, groupKey });
        }
    }

    const groups = new Map();
    for (const c of candidates) {
        if (!groups.has(c.groupKey)) groups.set(c.groupKey, []);
        groups.get(c.groupKey).push(c);
    }

    // Lower ranks sort first and win the canonical slot: a folder whose name
    // carries a concrete case id beats one with no id or only the
    // "CAS-PENDING" placeholder (seen in practice as an old alias folder -
    // e.g. a directory junction - left pointing at a case repo that was later
    // assigned its real number), and the main checkout beats a worktree.
    const caseIdRank = (caseFolder) => {
        const id = extractCaseId(caseFolder);
        if (!id) return 2;
        return /^CAS-PENDING$/i.test(id) ? 1 : 0;
    };
    const kindRank = (kind) => (kind === 'main' ? 0 : kind === 'worktree' ? 1 : 2);
    const canonicalOrder = (a, b) => (
        (caseIdRank(a.caseFolder) - caseIdRank(b.caseFolder))
        || (kindRank(a.kind) - kindRank(b.kind))
        || a.caseFolder.localeCompare(b.caseFolder)
    );

    const cases = [];
    for (const members of groups.values()) {
        const canonical = members.slice().sort(canonicalOrder)[0];

        const commits = gitCommits(canonical.folder, range, timezone).filter((c) => inRange.has(c.date));

        // File-touch evidence is still gathered per physical folder - a linked
        // worktree can have its own uncommitted or branch-specific files - but
        // de-duplicated by day+path so a file shared across worktrees is not
        // listed once per worktree.
        const seenFile = new Set();
        const files = [];
        for (const member of members) {
            for (const f of touchedFiles(member.folder, range, timezone, startMs, endMs)) {
                if (!inRange.has(f.date)) continue;
                const dedupeKey = `${f.date}|${f.path}`;
                if (seenFile.has(dedupeKey)) continue;
                seenFile.add(dedupeKey);
                files.push(f);
            }
        }
        if (commits.length === 0 && files.length === 0) continue;

        const days = {};
        for (const c of commits) {
            days[c.date] = days[c.date] || { commits: [], files: [] };
            days[c.date].commits.push(c);
        }
        for (const f of files) {
            days[f.date] = days[f.date] || { commits: [], files: [] };
            days[f.date].files.push(f);
        }
        for (const day of Object.values(days)) {
            day.commits.sort((a, b) => a.time.localeCompare(b.time));
            day.files.sort((a, b) => a.time.localeCompare(b.time));
            day.fileCount = day.files.length;
            day.files = day.files.slice(0, MAX_FILES_PER_DAY);
        }

        cases.push({
            client: canonical.client,
            clientFolder: canonical.clientFolder,
            caseId: extractCaseId(canonical.caseFolder),
            title: caseTitle(canonical.caseFolder),
            folderName: canonical.caseFolder,
            folder: canonical.folder,
            hasGit: canonical.kind !== 'none',
            linkedWorktrees: members.filter((m) => m !== canonical).map((m) => m.caseFolder),
            days
        });
    }

    const byDate = {};
    for (const c of cases) {
        for (const [date, day] of Object.entries(c.days)) {
            byDate[date] = byDate[date] || [];
            byDate[date].push({
                client: c.client,
                caseId: c.caseId,
                title: c.title,
                commits: day.commits.map((x) => `${x.time} ${x.subject}`),
                files: day.files.map((x) => x.path),
                fileCount: day.fileCount
            });
        }
    }
    for (const date of Object.keys(byDate)) byDate[date].sort((a, b) => String(a.client).localeCompare(String(b.client)));

    const knownIds = [...new Set(cases.map((c) => c.caseId).filter(Boolean))].sort();

    return { cases, byDate, knownIds, scanned, clients: [...new Set(clients)].sort() };
}

module.exports = { collectLocalEvidence, extractCaseId, caseTitle, looksLikeClientFolder, isoInZone, resolveGitLink, CASE_ID_RE };
