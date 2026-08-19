const fs = require('fs');
const path = require('path');
const mkvMetaEngine = require('../../../../mkvMetaEngine');
const clusterManager = require('../../../../clusterManager');
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

    console.log(`[FORENSIC] Analyzing ${filePath}`);
    const metadata = await mkvMetaEngine.parse(fileId, filePath, tdSend, fileEvents, () => {});

    console.log(`[METADATA] Duration: ${metadata.duration}ms`);
    console.log(`[METADATA] First Cluster Position: ${metadata.firstClusterPos}`);
    console.log(`[METADATA] Track Count: ${metadata.tracks.length}`);
    metadata.tracks.forEach(t => {
        console.log(`  Track ${t.number}: Type=${t.type} Codec=${t.codec}`);
    });

    const audioTrack = metadata.tracks.find(t => t.type === 'audio');
    if (!audioTrack) {
        console.log("[ERROR] No audio track found");
        return;
    }
    const audioTrackNum = audioTrack.number;

    console.log(`[CUES] Audio Track ${audioTrackNum} Cue Count: ${metadata.cues[audioTrackNum]?.length || 0}`);
    if (metadata.cues[audioTrackNum]) {
        metadata.cues[audioTrackNum].slice(0, 5).forEach(c => console.log(`  Cue: Time=${c.time}ms ClusterPos=${c.clusterPos}`));
    }

    console.log(`\n[CLUSTER SCAN] Starting from beginning...`);
    let clusterOffset = metadata.firstClusterPos;
    let foundFirstAudio = false;
    let clustersParsed = 0;

    // We will manually walk the clusters to find the true first audio packet
    const fd = fs.openSync(filePath, 'r');

    while (clusterOffset < metadata.fileSize && clustersParsed < 20) {
        const startPoint = { startOffset: clusterOffset };
        await clusterManager.ensureCluster(fileId, filePath, startPoint, audioTrackNum, tdSend, fileEvents, () => {});

        const registry = clusterManager.getRegistry(fileId);
        const cluster = registry.clusters.get(clusterOffset);

        if (cluster && cluster.packets) {
            const audioPackets = cluster.packets.get(audioTrackNum) || [];
            const videoPackets = cluster.packets.get(1) || []; // Assume track 1 is video

            console.log(`Cluster at ${clusterOffset}: Time=${cluster.clusterTimecode}ms | AudioPkts=${audioPackets.length} VideoPkts=${videoPackets.length}`);

            if (audioPackets.length > 0 && !foundFirstAudio) {
                console.log(`  >>> FIRST AUDIO PACKET in file: Time=${audioPackets[0].time}ms`);
                foundFirstAudio = true;
            }

            if (audioPackets.length > 0) {
                console.log(`  Audio Time Range: [${audioPackets[0].time} - ${audioPackets[audioPackets.length-1].time}]ms`);
            }
            if (videoPackets.length > 0) {
                console.log(`  Video Time Range: [${videoPackets[0].time} - ${videoPackets[videoPackets.length-1].time}]ms`);
            }

            clusterOffset = cluster.endOffset;
            clustersParsed++;
        } else {
            break;
        }
    }

    fs.closeSync(fd);
}

run().catch(console.error);
