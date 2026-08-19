const fs = require('fs');

function readID(fd, offset) {
    const buf = Buffer.alloc(4);
    try { fs.readSync(fd, buf, 0, 4, offset); } catch(e) { return null; }
    const first = buf[0];
    if (first === 0x1F && buf[1] === 0x43 && buf[2] === 0xB6 && buf[3] === 0x75) return { val: 0x1F43B675, len: 4 };
    if (first === 0x18 && buf[1] === 0x53 && buf[2] === 0x80 && buf[3] === 0x67) return { val: 0x18538067, len: 4 };
    return null;
}

function scan(filePath) {
    const fd = fs.openSync(filePath, 'r');
    let pos = 0;
    const stats = fs.statSync(filePath);
    console.log(`Scanning ${filePath} (${stats.size} bytes)`);

    while (pos < Math.min(stats.size, 1024 * 1024)) { // Scan first 1MB
        const id = readID(fd, pos);
        if (id && id.val === 0x1F43B675) {
            console.log(`[CLUSTER] Found at offset ${pos}`);
            // Let's see what's inside
            const sizeBuf = Buffer.alloc(8);
            fs.readSync(fd, sizeBuf, 0, 8, pos + 4);
            // Decode VINT for size
            let first = sizeBuf[0];
            let sLen = 0;
            if (first & 0x80) sLen = 1; else if (first & 0x40) sLen = 2; else if (first & 0x20) sLen = 3; else if (first & 0x10) sLen = 4;

            let timePos = pos + 4 + sLen;
            const tId = Buffer.alloc(1);
            fs.readSync(fd, tId, 0, 1, timePos);
            if (tId[0] === 0xE7) {
                 const tSizeBuf = Buffer.alloc(1);
                 fs.readSync(fd, tSizeBuf, 0, 1, timePos + 1);
                 const tSize = tSizeBuf[0] & 0x7F;
                 const tVal = Buffer.alloc(tSize);
                 fs.readSync(fd, tVal, 0, tSize, timePos + 2);
                 console.log(`  Cluster Timecode: ${tVal.readUIntBE(0, tSize)}ms`);
            }
        }
        pos++;
    }
    fs.closeSync(fd);
}

scan('C:/Users/albih/Downloads/check_movie.mkv');
