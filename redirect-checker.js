const fs = require('fs');
const path = require('path');
const readline = require('readline');
const csv = require('csv-parser');
const { stringify } = require('csv-stringify/sync');
const https = require('https');
const http = require('http');

const ISSUE_TYPES = {
    DUPLICATE_SAME_DEST: 'duplicate_same_dest',
    DUPLICATE_DIFF_DEST: 'duplicate_diff_dest',
    LOOP: 'loop',
    CHAIN: 'chain',
};

const OUTPUT_DIR = path.join(__dirname, 'output');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizePath(input) {
    try {
        const parsed = new URL(input, 'http://placeholder');
        const normalized = (parsed.pathname || '/').replace(/\/$/, '').toLowerCase();
        return normalized === '' ? '/' : normalized;
    } catch {
        return '/';
    }
}

function prompt(rl, question) {
    return new Promise((resolve) => rl.question(question, resolve));
}

function ensureOutputDir() {
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR);
    }
}

function writeCsv(filename, data, options = {}) {
    const filePath = path.join(OUTPUT_DIR, filename);
    const content = stringify(data, options);
    fs.writeFileSync(filePath, content);
    return filePath;
}

function parseCSV(filePath) {
    return new Promise((resolve, reject) => {
        const rows = [];
        fs.createReadStream(filePath)
            .pipe(csv({ headers: ['source', 'destination'], skipLines: 0 }))
            .on('data', (row) => {
                rows.push({
                    source: row.source,
                    destination: row.destination,
                });
            })
            .on('end', () => resolve(rows))
            .on('error', reject);
    });
}

function analyzeRedirects(rows) {
    const issues = [];
    const seen = new Map();
    const sourceMap = new Map();
    const duplicateEntries = [];

    const normalized = rows.map((row) => ({
        source: row.source,
        destination: row.destination,
        normalizedSource: normalizePath(row.source),
        normalizedDest: normalizePath(row.destination),
    }));

    const unique = [];
    for (const entry of normalized) {
        const pairKey = `${entry.normalizedSource}->${entry.normalizedDest}`;

        if (!sourceMap.has(entry.normalizedSource)) {
            sourceMap.set(entry.normalizedSource, []);
        }
        sourceMap.get(entry.normalizedSource).push(entry);

        if (!seen.has(pairKey)) {
            seen.set(pairKey, true);
            unique.push(entry);
        }
    }

    for (const [source, entries] of sourceMap) {
        const uniqueDests = new Set(entries.map((e) => e.normalizedDest));
        if (uniqueDests.size > 1) {
            issues.push({
                type: ISSUE_TYPES.DUPLICATE_DIFF_DEST,
                source,
                destinations: [...uniqueDests],
                count: entries.length,
            });
            for (const e of entries) {
                duplicateEntries.push({
                    source: e.source,
                    destination: e.destination,
                    normalized_source: e.normalizedSource,
                });
            }
        } else if (entries.length > 1) {
            issues.push({
                type: ISSUE_TYPES.DUPLICATE_SAME_DEST,
                source,
                destination: entries[0].normalizedDest,
                count: entries.length,
            });
        }
    }

    const filtered = [];
    const problematic = [];
    const sourceSet = new Set();
    for (const entry of unique) {
        if (entry.normalizedSource === entry.normalizedDest) {
            issues.push({
                type: ISSUE_TYPES.LOOP,
                source: entry.normalizedSource,
                destination: entry.normalizedDest,
            });
            problematic.push(entry);
        } else {
            filtered.push(entry);
            sourceSet.add(entry.normalizedSource);
        }
    }

    for (const entry of filtered) {
        if (sourceSet.has(entry.normalizedDest)) {
            issues.push({
                type: ISSUE_TYPES.CHAIN,
                source: entry.normalizedSource,
                destination: entry.normalizedDest,
            });
            problematic.push(entry);
        }
    }

    return { issues, filtered, problematic, duplicateEntries };
}

const urlCache = new Map();

function checkStatusCode(url) {
    return new Promise((resolve) => {
        const mod = url.startsWith('https') ? https : http;
        try {
            const req = mod.get(url, (res) => {
                resolve({ url, status: res.statusCode });
                res.resume();
            });
            req.on('error', () => resolve({ url, status: 'error' }));
            req.setTimeout(5000, () => {
                req.abort();
                resolve({ url, status: 'timeout' });
            });
        } catch {
            resolve({ url, status: 'invalid url' });
        }
    });
}

async function checkStatusCodeCached(url) {
    if (urlCache.has(url)) {
        return { ...urlCache.get(url), cached: true };
    }

    await sleep(1000);
    const result = await checkStatusCode(url);
    urlCache.set(url, result);
    return { ...result, cached: false };
}

async function validateURLs(rows, type) {
    const errors = [];

    for (const row of rows) {
        if (!row.destination.startsWith('http')) {
            console.log(`  [SKIP] ${row.destination} - not a valid URL`);
            errors.push({ source: row.source, destination: row.destination, status: 'invalid url', type });
            continue;
        }

        const result = await checkStatusCodeCached(row.destination);
        const label = String(result.status) === '200' ? 'OK' : 'FAIL';
        const suffix = result.cached ? ' (cached)' : '';
        console.log(`  [${label}] ${result.url} -> ${result.status}${suffix}`);

        if (String(result.status) !== '200') {
            errors.push({ source: row.source, destination: row.destination, status: result.status, type });
        }
    }

    return errors;
}

function formatIssue(issue) {
    switch (issue.type) {
        case ISSUE_TYPES.DUPLICATE_DIFF_DEST:
            return `[DUPLICATE] "${issue.source}" has ${issue.destinations.length} different destinations: ${issue.destinations.join(', ')}`;
        case ISSUE_TYPES.DUPLICATE_SAME_DEST:
            return `[DUPLICATE] "${issue.source}" appears ${issue.count} times with the same destination`;
        case ISSUE_TYPES.LOOP:
            return `[LOOP] ${issue.source} -> ${issue.destination}`;
        case ISSUE_TYPES.CHAIN:
            return `[CHAIN] ${issue.source} -> ${issue.destination}`;
        default:
            return `[UNKNOWN] ${JSON.stringify(issue)}`;
    }
}

function printSummary(issues) {
    if (!issues.length) {
        console.log('No issues found.');
        return;
    }

    const grouped = {};
    for (const issue of issues) {
        if (!grouped[issue.type]) grouped[issue.type] = [];
        grouped[issue.type].push(issue);
    }

    console.log('\n--- Issues Found ---\n');

    const typeLabels = {
        [ISSUE_TYPES.DUPLICATE_DIFF_DEST]: 'Duplicates (different destinations)',
        [ISSUE_TYPES.DUPLICATE_SAME_DEST]: 'Duplicates (same destination)',
        [ISSUE_TYPES.LOOP]: 'Redirect Loops',
        [ISSUE_TYPES.CHAIN]: 'Redirect Chains',
    };

    for (const [type, items] of Object.entries(grouped)) {
        const label = typeLabels[type] || type;
        console.log(`${label} (${items.length}):`);
        for (const issue of items) {
            console.log(`  ${formatIssue(issue)}`);
        }
        console.log('');
    }

    console.log(`Total: ${issues.length} issue(s)`);
}

function writeResults({ filtered, duplicateEntries, errors }) {
    ensureOutputDir();

    const cleanedRows = filtered.map((e) => ({ source: e.source, destination: e.destination }));
    const cleanedPath = writeCsv('cleaned.csv', cleanedRows, { header: false });
    console.log(`Cleaned CSV saved to: ${cleanedPath}`);

    if (duplicateEntries.length) {
        const dupPath = writeCsv('duplicates.csv', duplicateEntries, { header: true });
        console.log(`${duplicateEntries.length} duplicate entries written to: ${dupPath}`);
    }

    if (errors && errors.length) {
        const errPath = writeCsv('redirect-errors.csv', errors, { header: true });
        console.log(`${errors.length} URL errors written to: ${errPath}`);
    }
}

async function main() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    try {
        const inputPath = await prompt(rl, 'Enter the path to the CSV file: ');
        const fullPath = path.resolve(inputPath);

        if (!fs.existsSync(fullPath)) {
            console.error('Error: File does not exist.');
            return;
        }

        console.log('Checking for redirect issues...\n');
        const rows = await parseCSV(fullPath);
        const { issues, filtered, problematic, duplicateEntries } = analyzeRedirects(rows);

        printSummary(issues);

        let errors = null;
        const answer = await prompt(rl, '\nWould you like to validate final destination URLs? (y/n): ');

        if (answer.toLowerCase() === 'y') {
            console.log('\nValidating cleaned redirects...\n');
            const cleanedErrors = await validateURLs(filtered, 'cleaned');

            console.log('\nValidating problematic redirects...\n');
            const problematicErrors = await validateURLs(problematic, 'problematic');

            errors = [...cleanedErrors, ...problematicErrors];

            if (!errors.length) {
                console.log('\nAll destinations returned 200.');
            }
        }

        writeResults({ filtered, duplicateEntries, errors });
    } finally {
        rl.close();
    }
}

main();
