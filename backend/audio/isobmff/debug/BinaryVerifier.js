/**
 * BinaryVerifier - Debug-only ISO-BMFF parser.
 * This tool parses a Buffer directly from raw bytes.
 * It is completely independent from MP4Generator.
 */
class BinaryVerifier {
    static verify(buffer, timescale = 1, logger = console.log) {
        const log = (msg) => logger(msg);

        log(`\n==================================================`);
        log(`BINARY VERIFIER ENTERED`);
        log(`VERIFY() START`);
        log(`==================================================`);
        log(`Total Buffer Size: ${buffer.length} bytes`);

        try {
            const rootBoxes = this.parseBoxes(buffer, 0, buffer.length);
            this.printReport(rootBoxes, buffer, timescale, 0, log);
            this.validateSpec(rootBoxes, buffer, log);
        } catch (e) {
            log(`\n==================================================`);
            log(`BINARY VERIFIER CRASH`);
            log(`Error: ${e.message}`);
            log(`Stack: ${e.stack}`);
            log(`==================================================`);
        }

        log(`\n==================================================`);
        log(`VERIFY() END`);
        log(`==================================================\n`);
    }

    static parseBoxes(buffer, offset, length) {
        const boxes = [];
        let pos = offset;
        const end = offset + length;

        while (pos < end) {
            if (pos + 8 > end) break;
            const size = buffer.readUInt32BE(pos);
            const type = buffer.toString('utf8', pos + 4, pos + 8);

            const box = {
                offset: pos,
                size: size,
                type: type,
                headerSize: 8,
                payloadOffset: pos + 8,
                payloadSize: size - 8
            };

            // Recursively parse children of known containers
            if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'moof', 'traf'].includes(type)) {
                box.children = this.parseBoxes(buffer, box.payloadOffset, box.payloadSize);
            }

            boxes.push(box);
            pos += size;
        }
        return boxes;
    }

    static printReport(boxes, buffer, timescale, depth, log) {
        const indent = '  '.repeat(depth);
        for (const box of boxes) {
            log(`${indent}[${box.type}] offset=${box.offset} size=${box.size} payload_start=${box.payloadOffset} payload_end=${box.payloadOffset + box.payloadSize}`);

            if (box.type === 'tfhd') this.decodeTfhd(box, buffer, indent, log);
            if (box.type === 'tfdt') this.decodeTfdt(box, buffer, timescale, indent, log);
            if (box.type === 'trun') this.decodeTrun(box, buffer, indent, log);
            if (box.type === 'mdat') log(`${indent}  Mdat Header Size: 8 bytes`);

            if (box.children) {
                this.printReport(box.children, buffer, timescale, depth + 1, log);
            }
        }
    }

    static decodeTfhd(box, buffer, indent, log) {
        const flags = buffer.readUInt32BE(box.payloadOffset) & 0x00FFFFFF;
        const trackId = buffer.readUInt32BE(box.payloadOffset + 4);
        log(`${indent}  Tfhd Flags: 0x${flags.toString(16).padStart(6, '0')}`);
        log(`${indent}  Track ID: ${trackId}`);
        log(`${indent}  default-base-is-moof: ${(flags & 0x020000) ? 'YES' : 'NO'}`);
    }

    static decodeTfdt(box, buffer, timescale, indent, log) {
        const version = buffer[box.payloadOffset];
        let baseTime;
        if (version === 1) {
            baseTime = buffer.readBigUInt64BE(box.payloadOffset + 4);
        } else {
            baseTime = BigInt(buffer.readUInt32BE(box.payloadOffset + 4));
        }
        log(`${indent}  Tfdt Version: ${version}`);
        log(`${indent}  baseMediaDecodeTime: ${baseTime} ticks (${(Number(baseTime)/timescale).toFixed(3)}s)`);
    }

    static decodeTrun(box, buffer, indent, log) {
        const flags = buffer.readUInt32BE(box.payloadOffset) & 0x00FFFFFF;
        const count = buffer.readUInt32BE(box.payloadOffset + 4);
        log(`${indent}  Trun Flags: 0x${flags.toString(16).padStart(6, '0')}`);
        log(`${indent}  Sample Count: ${count}`);

        let pos = box.payloadOffset + 8;
        if (flags & 0x01) {
            // data_offset is a SIGNED int32 relative to base data offset
            const dataOffset = buffer.readInt32BE(pos);
            log(`${indent}  Data Offset: ${dataOffset} (Signed Int32)`);
            pos += 4;
        }

        for (let i = 0; i < Math.min(1, count); i++) {
            let sInfo = `${indent}  Sample #0:`;
            if (flags & 0x0100) { sInfo += ` dur=${buffer.readUInt32BE(pos)}`; pos += 4; }
            if (flags & 0x0200) { sInfo += ` size=${buffer.readUInt32BE(pos)}`; pos += 4; }
            if (flags & 0x0400) { sInfo += ` flags=0x${buffer.readUInt32BE(pos).toString(16)}`; pos += 4; }
            if (flags & 0x0800) { sInfo += ` cto=${buffer.readInt32BE(pos)}`; pos += 4; }
            log(sInfo);
        }
    }

    static validateSpec(rootBoxes, buffer, log) {
        log(`\n--- SPECIFICATION VALIDATION ---`);

        const moof = rootBoxes.find(b => b.type === 'moof');
        const mdat = rootBoxes.find(b => b.type === 'mdat');
        const traf = moof ? moof.children.find(b => b.type === 'traf') : null;
        const trun = traf ? traf.children.find(b => b.type === 'trun') : null;

        if (!moof || !mdat || !trun) {
            log(`FAIL: Fragment missing moof, mdat, or trun`);
            return;
        }

        // H1 Check: trun.data_offset
        const trunFlags = buffer.readUInt32BE(trun.payloadOffset) & 0x00FFFFFF;
        let dataOffsetValue = 0;
        if (trunFlags & 0x01) {
            dataOffsetValue = buffer.readInt32BE(trun.payloadOffset + 8);
        }

        // Expected offset is the start of mdat payload (relative to moof start)
        const expectedOffset = mdat.payloadOffset;
        const actualOffset = 0 + dataOffsetValue; // 0 is moof start

        log(`H1 (trun.data_offset is 0): ${dataOffsetValue === 0}`);
        log(`H2 (trun.data_offset points inside moof): ${actualOffset < mdat.offset}`);
        log(`H3 (trun points to mdat header): ${actualOffset === mdat.offset}`);
        log(`H4 (trun points correctly to mdat payload): ${actualOffset === expectedOffset}`);

        log(`\nExpected Payload Offset: ${expectedOffset}`);
        log(`Actual Payload Offset: ${actualOffset}`);
        log(`Difference: ${actualOffset - expectedOffset} bytes`);

        // Binary proof dump
        const first32 = buffer.slice(actualOffset, Math.min(actualOffset + 32, buffer.length)).toString('hex');
        log(`\nHex dump at data_offset (${actualOffset}):`);
        log(first32);

        // Box validation
        let valid = true;
        for (const box of rootBoxes) {
            if (box.offset + box.size > buffer.length) {
                log(`VIOLATION: Box [${box.type}] overflows total buffer size.`);
                valid = false;
            }
        }
        log(`H5 (structurally valid): ${valid}`);
    }
}

module.exports = BinaryVerifier;
