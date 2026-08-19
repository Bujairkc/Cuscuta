const fs = require('fs');
const path = require('path');

class MKVForensic {
    static async analyze(filePath, targetTrack) {
        console.log(`Analyzing: ${filePath}`);
        const fd = fs.openSync(filePath, 'r');
        const stats = fs.statSync(filePath);
        let pos = 0;

        let firstAudioPacket = null;
        let clusterCount = 0;
        let audioTrackNum = -1;

        function readVINT(fd, offset) {
            const buf = Buffer.alloc(8);
            try {
                fs.readSync(fd, buf, 0, 8, offset);
            } catch(e) { return null; }
            const first = buf[0];
            let len = 0;
            if (first & 0x80) len = 1;
            else if (first & 0x40) len = 2;
            else if (first & 0x20) len = 3;
            else if (first & 0x10) len = 4;
            else if (first & 0x08) len = 5;
            else if (first & 0x04) len = 6;
            else if (first & 0x02) len = 7;
            else if (first & 0x01) len = 8;

            if (len === 0) return null;
            let val = first & (0xFF >> len);
            for (let i = 1; i < len; i++) val = val * 256 + buf[i];
            return { val, len };
        }

        function readID(fd, offset) {
            const buf = Buffer.alloc(4);
            try {
                fs.readSync(fd, buf, 0, 4, offset);
            } catch(e) { return null; }
            const first = buf[0];
            let len = 0;
            if (first & 0x80) len = 1;
            else if (first & 0x40) len = 2;
            else if (first & 0x20) len = 3;
            else if (first & 0x10) len = 4;

            if (len === 0) return null;
            let val = 0;
            for (let i = 0; i < len; i++) val = val * 256 + buf[i];
            return { val, len };
        }

        function decodeVINT(buf, pos) {
            const first = buf[pos];
            let len = 0;
            if (first & 0x80) len = 1;
            else if (first & 0x40) len = 2;
            else if (first & 0x20) len = 3;
            else if (first & 0x10) len = 4;
            let val = first & (0xFF >> len);
            for (let i = 1; i < len; i++) val = val * 256 + buf[pos + i];
            return { val, len };
        }

        while (pos < stats.size && clusterCount < 1000) {
            const id = readID(fd, pos);
            if (!id) break;
            const size = readVINT(fd, pos + id.len);
            if (!size) break;

            const dataOffset = pos + id.len + size.len;

            if (id.val === 0x1654AE6B) { // Tracks
                 let trackPos = dataOffset;
                 const trackEnd = dataOffset + size.val;
                 while(trackPos < trackEnd) {
                     const tId = readID(fd, trackPos);
                     const tSize = readVINT(fd, trackPos + tId.len);
                     const tData = trackPos + tId.len + tSize.len;
                     if(tId.val === 0xAE) { // TrackEntry
                         let entryPos = tData;
                         const entryEnd = tData + tSize.val;
                         let tNum = -1, tType = -1, tCodec = "";
                         while(entryPos < entryEnd) {
                             const eId = readID(fd, entryPos);
                             const eSize = readVINT(fd, entryPos + eId.len);
                             const eVal = entryPos + eId.len + eSize.len;
                             if(eId.val === 0xD7) {
                                 const b = Buffer.alloc(eSize.val);
                                 fs.readSync(fd, b, 0, eSize.val, eVal);
                                 tNum = b.readUIntBE(0, eSize.val);
                             }
                             else if(eId.val === 0x83) {
                                 const b = Buffer.alloc(eSize.val);
                                 fs.readSync(fd, b, 0, eSize.val, eVal);
                                 tType = b.readUIntBE(0, eSize.val);
                             }
                             else if(eId.val === 0x86) {
                                 const b = Buffer.alloc(eSize.val);
                                 fs.readSync(fd, b, 0, eSize.val, eVal);
                                 tCodec = b.toString();
                             }
                             entryPos += eId.len + eSize.len + eSize.val;
                         }
                         console.log(`[TRACK] Num=${tNum} Type=${tType === 1 ? 'Video' : tType === 2 ? 'Audio' : 'Other'} Codec=${tCodec}`);
                         if(tType === 2 && audioTrackNum === -1) audioTrackNum = tNum;
                     }
                     trackPos += tId.len + tSize.len + tSize.val;
                 }
            }

            if (id.val === 0x1F43B675) { // Cluster
                clusterCount++;
                let clusterTimecode = 0;
                let clusterPos = dataOffset;
                const clusterEnd = dataOffset + size.val;

                while (clusterPos < clusterEnd) {
                    const elId = readID(fd, clusterPos);
                    if (!elId) break;
                    const elSize = readVINT(fd, clusterPos + elId.len);
                    if (!elSize) break;
                    const elDataPos = clusterPos + elId.len + elSize.len;

                    if (elId.val === 0xE7) { // Timecode
                        const tBuf = Buffer.alloc(elSize.val);
                        fs.readSync(fd, tBuf, 0, elSize.val, elDataPos);
                        clusterTimecode = tBuf.readUIntBE(0, elSize.val);
                    } else if (elId.val === 0xA3 || elId.val === 0xA0) { // SimpleBlock or BlockGroup
                        let actualBlockDataPos = elDataPos;
                        if (elId.val === 0xA0) {
                             let bgPos = elDataPos;
                             const bgEnd = elDataPos + elSize.val;
                             while(bgPos < bgEnd) {
                                 const subId = readID(fd, bgPos);
                                 const subSize = readVINT(fd, bgPos + subId.len);
                                 if(subId.val === 0xA1) {
                                     actualBlockDataPos = bgPos + subId.len + subSize.len;
                                     break;
                                 }
                                 bgPos += subId.len + subSize.len + subSize.val;
                             }
                        }

                        const blockData = Buffer.alloc(8);
                        fs.readSync(fd, blockData, 0, 8, actualBlockDataPos);
                        const trackNumV = decodeVINT(blockData, 0);
                        const trackNumber = trackNumV.val;
                        const timecode = blockData.readInt16BE(trackNumV.len);
                        const absTime = clusterTimecode + timecode;

                        if (trackNumber === targetTrack) {
                            if (!firstAudioPacket) {
                                firstAudioPacket = { time: absTime, clusterOffset: pos };
                                console.log(`[FIRST AUDIO] Time=${absTime}ms Cluster=${pos}`);
                            }
                        }
                    }
                    clusterPos += elId.len + elSize.len + elSize.val;
                }
            } else if (id.val === 0x18538067) { pos = dataOffset; continue; }

            pos += id.len + size.len + size.val;
        }
        fs.closeSync(fd);
    }
}

async function run() {
    const searchPaths = ['C:/Users/albih/Downloads/', 'C:/Users/albih/Music/new finest - Copy/'];
    for (const p of searchPaths) {
        try {
            const files = fs.readdirSync(p);
            const mkv = files.find(f => f.endsWith('.mkv'));
            if (mkv) {
                await MKVForensic.analyze(path.join(p, mkv), 2);
                return;
            }
        } catch(e) {}
    }
}
run();
