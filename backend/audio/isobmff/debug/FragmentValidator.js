/**
 * FragmentValidator - Development utility to inspect generated ISOBMFF buffers.
 * This is a read-only tool for structural validation.
 */
class FragmentValidator {
    static validate(buffer, label = "Buffer") {
        console.log(`\n===================================`);
        console.log(`VALIDATION REPORT: ${label}`);
        console.log(`Total Size: ${buffer.length} bytes`);
        console.log(`===================================`);

        let pos = 0;
        while (pos < buffer.length) {
            const size = buffer.readUInt32BE(pos);
            const type = buffer.toString('utf8', pos + 4, pos + 8);

            this.inspectBox(type, buffer.slice(pos + 8, pos + size), 0);

            pos += size;
        }
        console.log(`===================================\n`);
    }

    static inspectBox(type, data, depth) {
        const indent = "  ".repeat(depth);
        console.log(`${indent}[${type}] Size: ${data.length + 8}`);

        if (type === 'moov' || type === 'trak' || type === 'mdia' || type === 'minf' || type === 'stbl' || type === 'mvex' || type === 'moof' || type === 'traf') {
            let pos = 0;
            while (pos < data.length) {
                const childSize = data.readUInt32BE(pos);
                const childType = data.toString('utf8', pos + 4, pos + 8);
                this.inspectBox(childType, data.slice(pos + 8, pos + childSize), depth + 1);
                pos += childSize;
            }
        } else if (type === 'mvhd' || type === 'mdhd') {
            const timescale = data.readUInt32BE(12);
            const duration = data.readUInt32BE(16);
            console.log(`${indent}  Timescale: ${timescale}`);
            console.log(`${indent}  Duration: ${duration}`);
        } else if (type === 'mfhd') {
            const sn = data.readUInt32BE(4);
            console.log(`${indent}  Sequence Number: ${sn}`);
        } else if (type === 'tfdt') {
            const version = data[0];
            let baseTime;
            if (version === 1) {
                baseTime = data.readBigUInt64BE(4);
            } else {
                baseTime = data.readUInt32BE(4);
            }
            console.log(`${indent}  Base Media Decode Time: ${baseTime}`);
        } else if (type === 'trun') {
            const flags = data.readUInt32BE(0) & 0x00FFFFFF;
            const count = data.readUInt32BE(4);
            console.log(`${indent}  Sample Count: ${count}`);
            console.log(`${indent}  Flags: 0x${flags.toString(16)}`);

            // Basic validation of data-offset
            if (flags & 0x01) {
                const offset = data.readInt32BE(8);
                console.log(`${indent}  Data Offset: ${offset}`);
            }
        } else if (type === 'mdat') {
            console.log(`${indent}  Payload Data: ${data.length} bytes`);
        }
    }
}

module.exports = FragmentValidator;
