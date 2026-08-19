const mkvMetaEngine = require('../../../../mkvMetaEngine');
const clusterManager = require('../../../../clusterManager');
const EventEmitter = require('events');

const fileEvents = new EventEmitter();
const tdSend = async (req) => {
    if (req['@type'] === 'getFile') return { size: 22282240 };
    if (req['@type'] === 'getFileDownloadedPrefixSize') return { size: 22282240 };
    if (req['@type'] === 'downloadFile') return {};
    return {};
};

async function run() {
    const fileId = 12345;
    const filePath = 'C:/Users/albih/Downloads/check_movie.mkv';

    console.log("--- ENGINE AUDIT ---");
    const metadata = await mkvMetaEngine.parse(fileId, filePath, tdSend, fileEvents, () => {});

    console.log(`Metadata firstClusterPos: ${metadata.firstClusterPos}`);

    const startPoint = mkvMetaEngine.getClusterForTime(fileId, 0, 2);
    console.log(`Start Point for Time 0:`, startPoint);

    if (startPoint) {
        await clusterManager.ensureCluster(fileId, filePath, startPoint, 2, tdSend, fileEvents, () => {});
        const registry = clusterManager.getRegistry(fileId);
        const cluster = registry.clusters.get(startPoint.startOffset);
        if (cluster && cluster.packets) {
            const packets = cluster.packets.get(2) || [];
            console.log(`Packets found in cluster at ${startPoint.startOffset}: ${packets.length}`);
            if (packets.length > 0) {
                console.log(`First packet time: ${packets[0].time}ms`);
            }
        }
    }
}

run();
