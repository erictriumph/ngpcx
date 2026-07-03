require('dotenv').config();

const scrapers = [
    {
        name: 'Winget',
        module: './winget',
        enabled: true,
        description: 'Microsoft Winget package manifests — high confidence native ARM64 data'
    },
    {
        name: 'Qualcomm',
        module: './vendor/qualcomm',
        enabled: false,
        description: 'Qualcomm official compatibility pages'
    },
    {
        name: 'Adobe',
        module: './vendor/adobe',
        enabled: false,
        description: 'Adobe vendor ARM support pages'
    },
    {
        name: 'Microsoft',
        module: './vendor/microsoft',
        enabled: false,
        description: 'Microsoft app compatibility data'
    },
    {
        name: 'Reddit',
        module: './community/reddit',
        enabled: false,
        description: 'r/WindowsOnARM community compatibility reports'
    },
    {
        name: 'WorksOnWoA',
        module: './community/worksonwoa',
        enabled: true,
        description: 'WorksOnWoA community compatibility database — MIT licensed, Microsoft-contributed'
    },
];

async function runAllScrapers() {
    const args = process.argv.slice(2);
    const onlyArg = args.find(a => a.startsWith('--only='));
    const only = onlyArg ? onlyArg.replace('--only=', '').split(',') : null;

    const toRun = scrapers.filter(s => {
        if (!s.enabled) return false;
        if (only && !only.includes(s.name.toLowerCase())) return false;
        return true;
    });

    console.log('NGPCX Scraper Suite');
    console.log('===================');
    console.log(`Running ${toRun.length} scraper(s)\n`);

    const results = {
        started: new Date().toISOString(),
        scrapers: []
    };

    for (const scraper of toRun) {
        console.log(`\n${'─'.repeat(40)}`);
        console.log(`▶ ${scraper.name}`);
        console.log(`  ${scraper.description}`);
        console.log('─'.repeat(40));

        const start = Date.now();

        try {
            const { run } = require(scraper.module);
            await run();

            const elapsed = Math.round((Date.now() - start) / 1000);
            console.log(`✓ ${scraper.name} completed in ${elapsed}s`);

            results.scrapers.push({
                name: scraper.name,
                status: 'success',
                elapsed
            });

        } catch (err) {
            console.error(`✗ ${scraper.name} failed:`, err.message);

            results.scrapers.push({
                name: scraper.name,
                status: 'failed',
                error: err.message
            });
        }
    }

    console.log('\n' + '='.repeat(40));
    console.log('All scrapers completed.');
    console.log(`Started:  ${results.started}`);
    console.log(`Finished: ${new Date().toISOString()}`);

    results.scrapers.forEach(s => {
        const icon = s.status === 'success' ? '✓' : '✗';
        console.log(`${icon} ${s.name}: ${s.status}${s.elapsed ? ` (${s.elapsed}s)` : ''}`);
    });

    process.exit(0);
}

runAllScrapers().catch(err => {
    console.error('Orchestrator failed:', err);
    process.exit(1);
});