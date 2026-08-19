const fs = require('fs');

function readVINT(fd, offset) {
    const buf = Buffer.alloc(8);
    try { fs.readSync(fd, buf, 0, 8, offset); } catch(e) { return null; }
    const first = buf[0];
    let len = 0;
    if (first & 0x80) len = 1; else if (first & 0x40) len = 2; else if (first & 0x20) len = 3; else if (first & 0x10) len = 4;
    else if (first & 0x08) len = 5; else if (first & 0x04) len = 6; else if (first & 0x02) len = 7; else if (first & 0x01) len = 8;
    if (len === 0) return null;
    let val = first & (0xFF >> len);
    for (let i = 1; i < len; i++) val = val * 256 + buf[i];
    return { val, len };
}

function readID(fd, offset) {
    const buf = Buffer.alloc(4);
    try { fs.readSync(fd, buf, 0, 4, offset); } catch(e) { return null; }
    const first = buf[0];
    let len = 0;
    if (first & 0x80) len = 1; else if (first & 0x40) len = 2; else if (first & 0x20) len = 3; else if (first & 0x10) len = 4;
    if (len === 0) return null;
    let val = 0;
    for (let i = 0; i < len; i++) val = val * 256 + buf[i];
    return { val, len };
}

function scanForCues(filePath) {
    const fd = fs.openSync(filePath, 'r');
    let pos = 0;
    const stats = fs.statSync(filePath);

    function walk(offset, end) {
        let p = offset;
        while (p < end) {
            const id = readID(fd, p);
            if (!id) break;
            const size = readVINT(fd, p + id.len);
            if (!size) break;
            const dataPos = p + id.len + size.len;

            if (id.val === 0x18538067) { // Segment
                walk(dataPos, dataPos + size.val);
            } else if (id.val === 0x1C53BB6B) { // Cues
                console.log(`[CUES] Found at ${p}`);
                let cuePos = dataPos;
                const cueEnd = dataPos + size.val;
                let count = 0;
                while (cuePos < cueEnd) {
                    const cId = readID(fd, cuePos);
                    if(!cId) break;
                    const cSize = readVINT(fd, cuePos + cId.len);
                    if(!cSize) break;
                    const cData = cuePos + cId.len + cSize.len;
                    if (cId.val === 0xBB) { // CuePoint
                        let cpPos = cData;
                        const cpEnd = cData + cSize.val;
                        let time = -1;
                        while(cpPos < cpEnd) {
                            const eId = readID(fd, cpPos);
                            if(!eId) break;
                            const eSize = readVINT(fd, cpPos + eId.len);
                            if(!eSize) break;
                            const eVal = cpPos + eId.len + eSize.len;
                            if (eId.val === 0xB3) { // CueTime
                                const b = Buffer.alloc(eSize.val);
                                fs.readSync(fd, b, 0, eSize.val, eVal);
                                time = b.readUIntBE(0, eSize.val);
                            }
                            cpPos += eId.len + eSize.len + eSize.val;
                        }
                        if (count < 5) console.log(`  Cue #${count}: Time=${time}ms`);
                        count++;
                    }
                    cuePos += cId.len + cSize.len + cSize.val;
                }
                console.log(`[CUES] Total count: ${count}`);
            }
            p += id.len + size.len + size.val;
        }
    }

    walk(0, stats.size);
    fs.closeSync(fd);
}

scanForCues('C:/Users/albih/Downloads/check_movie.mkv');
