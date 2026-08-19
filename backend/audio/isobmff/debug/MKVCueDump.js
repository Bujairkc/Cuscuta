const mkvMetaEngine = require('../../../../mkvMetaEngine');
const EventEmitter = require('events');

const fileEvents = new EventEmitter();
const tdSend = async (req) => {
    if (req['@type'] === 'getFile') return { size: 22282240 };
    if (req['@type'] === 'getFileDownloadedPrefixSize') return { size: 22282240 };
    return {};
};

async function run() {
    const filePath = 'C:/Users/albih/Downloads/check_movie.mkv';
    const fileId = 12345;

    console.log(`[CUE-DUMP] Parsing ${filePath}`);
    const metadata = await mkvMetaEngine.parse(fileId, filePath, tdSend, fileEvents, () => {});

    console.log(`\n[CUES] Index Table:`);
    for (const trackNum in metadata.cues) {
        const cues = metadata.cues[trackNum];
        console.log(`  Track ${trackNum}: ${cues.length} cues`);
        if (cues.length > 0) {
            console.log(`    First 3:`);
            cues.slice(0, 3).forEach(c => console.log(`      Time=${c.time}ms ClusterPos=${c.clusterPos}`));
            console.log(`    Last 3:`);
            cues.slice(-3).forEach(c => console.log(`      Time=${c.time}ms ClusterPos=${c.clusterPos}`));
        }
    }

    console.log(`\n[SEEK TEST] getClusterForTime(time=0, track=2):`);
    const startPoint = mkvMetaEngine.getClusterForTime(fileId, 0, 2);
    console.log(startPoint);
}

run();
