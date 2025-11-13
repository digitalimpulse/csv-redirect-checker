const fs = require('fs');
const path = require('path');
const readline = require('readline');
const csv = require('csv-parser');
const { parse } = require('url');
const { stringify } = require('csv-stringify/sync');
const https = require('https');
const http = require('http');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// In-memory cache for URL status codes
const urlCache = new Map();

const checkStatusCode = (url) => {
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
        } catch (e) {
            resolve({ url, status: 'invalid url' });
        }
    });
};

const checkStatusCodeWithCache = async (url) => {
    if (urlCache.has(url)) {
        const cachedResult = urlCache.get(url);
        console.log(`💾 Cache hit: ${url} → ${cachedResult.status}`);
        return cachedResult;
    }

    const result = await checkStatusCode(url);

    urlCache.set(url, result);

    return result;
};

const normalizePath = (url) => {
    const parsed = parse(url || '');
    let path = (parsed.pathname || '/').replace(/\/$/, '').toLowerCase();
    return path === '' ? '/' : path;
};

rl.question('Enter the path to the CSV file: ', (inputPath) => {
    const fullPath = path.resolve(inputPath);
    if (!fs.existsSync(fullPath)) {
        console.error('❌ File does not exist.');
        rl.close();
        return;
    }

    const rows = [];
    fs.createReadStream(fullPath)
        .pipe(csv({ headers: ['source', 'destination'], skipLines: 0 }))
        .on('data', (data) => rows.push(data))
        .on('end', async () => {
            console.log('🔍 Checking for redirect issues...');

            const issues = [];
            const uniqueMap = new Map();

            // Normalize paths and remove duplicates
            rows.forEach(row => {
                const sourceKey = Object.keys(row)[0];
                const destKey = Object.keys(row)[1];
                const source = normalizePath(row[sourceKey]);
                const dest = normalizePath(row[destKey]);
                const pairKey = `${source}->${dest}`;
                console.log(source, dest);
                if (!uniqueMap.has(pairKey)) {
                    uniqueMap.set(pairKey, {
                        ...row,
                        _source: source,
                        _dest: dest
                    });
                }
            });

            const uniqueRows = Array.from(uniqueMap.values());

            // Detect redirect loops and filter them out
            const filteredRows = [];
            const loopsAndChains = [];
            const sourceSet = new Set();
            uniqueRows.forEach(row => {
                if (row._source === row._dest) {
                    issues.push(`⚠️ Redirect loop: ${row._source} → ${row._dest}`);
                    loopsAndChains.push(row);
                } else {
                    filteredRows.push(row);
                    sourceSet.add(row._source);
                }
            });

            // Detect redirect chains (after filtering)
            filteredRows.forEach(row => {
                if (sourceSet.has(row._dest)) {
                    issues.push(`⚠️ Potential chain redirect: ${row._source} → ${row._dest}`);
                    loopsAndChains.push(row);
                }
            });

            // Clean for CSV output
            const cleanedOutput = filteredRows.map(row => {
                const cleanedRow = { ...row };
                delete cleanedRow._source;
                delete cleanedRow._dest;
                return cleanedRow;
            });

            // Output CSV
            const outputDir = path.join(__dirname, 'output');
            if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir);
            }

            const outputFilePath = path.join(outputDir, 'cleaned.csv');
            const csvOutput = stringify(cleanedOutput, { header: false });
            fs.writeFileSync(outputFilePath, csvOutput);
            console.log(`✅ Cleaned CSV saved to: ${outputFilePath}`);

            if (issues.length) {
                console.log('\n--- Issues Found ---');
                issues.forEach(i => console.log(i));
            } else {
                console.log('🎉 No issues found!');
            }

            rl.question('\nWould you like to validate final destination URLs? (y/n): ', async (answer) => {
                if (answer.toLowerCase() !== 'y') {
                    rl.close();
                    return;
                }

                console.log('\n🌐 Validating destination URLs for cleaned redirects...');
                const errorLog = [];

                // Test cleaned redirects
                for (const row of cleanedOutput) {
                    const sourceURL = Object.values(row)[0];
                    const destURL = Object.values(row)[1];

                    if (!destURL.startsWith('http')) {
                        console.log(`⏩ Skipping invalid URL: ${destURL}`);
                        errorLog.push({ source: sourceURL, destination: destURL, status: 'invalid url', type: 'cleaned' });
                        continue;
                    }

                    await sleep(1000);
                    const result = await checkStatusCodeWithCache(destURL);
                    console.log(`🔗 ${result.url} → ${result.status}`);

                    if (String(result.status) !== '200') {
                        errorLog.push({ source: sourceURL, destination: destURL, status: result.status, type: 'cleaned' });
                    }
                }

                // Test destination URLs for rows with issues (loops and chains)
                console.log('\n🌐 Validating destination URLs for problematic redirects...');

                for (const row of loopsAndChains) {
                    const sourceURL = Object.values(row)[0];
                    const destURL = Object.values(row)[1];

                    if (!destURL.startsWith('http')) {
                        console.log(`⏩ Skipping invalid URL: ${destURL}`);
                        errorLog.push({ source: sourceURL, destination: destURL, status: 'invalid url', type: 'problematic' });
                        continue;
                    }

                    await sleep(1000);
                    const result = await checkStatusCodeWithCache(destURL);
                    console.log(`🔗 ${result.url} → ${result.status}`);

                    if (String(result.status) !== '200') {
                        errorLog.push({ source: sourceURL, destination: destURL, status: result.status, type: 'problematic' });
                    }
                }

                if (errorLog.length) {
                    const errorCsv = stringify(errorLog, { header: true });
                    const errorPath = path.join(__dirname, 'output', 'redirect-errors.csv');
                    fs.writeFileSync(errorPath, errorCsv);
                    console.log(`\n❌ ${errorLog.length} errors written to: ${errorPath}`);
                } else {
                    console.log('\n✅ All destinations returned 200!');
                }

                rl.close();
            });
        });
});
