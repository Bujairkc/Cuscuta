/**
 * MP4Generator - Stateless box factory for ISOBMFF (fragmented MP4).
 *
 * This class generates the binary structure for MP4 containers.
 * Optimized for AAC audio initialization and media fragments.
 *
 * Reference: ISO/IEC 14496-12 (Base Media File Format)
 * Reference: ISO/IEC 14496-14 (MP4 File Format)
 */

class MP4Generator {
    /**
     * Generates a complete Initialization Segment (ftyp + moov).
     * @param {Object} track - Normalized track metadata.
     * @returns {Buffer}
     */
    static generateInitSegment(track) {
        const timescale = track.sampleRate || 44100;
        console.log('--------------------------------');
        console.log('mvhd.timescale =', timescale);
        console.log('mdhd.timescale =', timescale);
        console.log('Movie timescale =', timescale);
        console.log('Track timescale =', timescale);
        console.log('track.sampleRate =', track.sampleRate);
        console.log('--------------------------------');

        return Buffer.concat([
            this.box('ftyp', this.ftyp()),
            this.box('moov', this.moov(track))
        ]);
    }

    /**
     * Generates a complete Media Fragment (moof + mdat).
     */
    static generateFragment(sequenceNumber, samples, baseMediaDecodeTime) {
        const moof = this.moof(sequenceNumber, samples, baseMediaDecodeTime);
        const mdat = this.box('mdat', this.mdat(samples));

        // --- ROBUST DATA_OFFSET PATCHING ---
        // Instead of indexOf('trun'), we calculate the exact location.
        // moof(8) mfhd(16) traf(8) tfhd(16) tfdt(16|20) trun_header(8) trun_flags(4) trun_sample_count(4) -> data_offset(4)
        const is64 = baseMediaDecodeTime > 0xFFFFFFFF;
        const tfdtSize = is64 ? 20 : 16;
        const trunDataOffsetPos = 8 + 16 + 8 + 16 + tfdtSize + 12;

        // Safety check to ensure we aren't corrupting the box structure
        if (moof.readInt32BE(trunDataOffsetPos - 12) === 0x000701) {
             moof.writeInt32BE(moof.length + 8, trunDataOffsetPos);
        } else {
             // Fallback to indexOf if structure differs
             const fallback = moof.indexOf('trun');
             if (fallback !== -1) moof.writeInt32BE(moof.length + 8, fallback + 12);
        }

        return Buffer.concat([moof, mdat]);
    }

    // ---- INITIALIZATION BOXES ----

    static ftyp() {
        const brands = ['isom', 'iso2', 'avc1', 'mp41'];
        const buffer = Buffer.alloc(8 + (brands.length * 4));
        buffer.write('isom', 0); // major_brand
        buffer.writeUInt32BE(0x200, 4); // minor_version
        brands.forEach((brand, i) => buffer.write(brand, 8 + (i * 4)));
        return buffer;
    }

    static moov(track) {
        const timescale = track.sampleRate || 44100;
        return Buffer.concat([
            this.box('mvhd', this.mvhd(timescale)),
            this.box('trak', this.trak(track)),
            this.box('mvex', this.mvex())
        ]);
    }

    static mvhd(timescale) {
        const buffer = Buffer.alloc(100);
        buffer.writeUInt32BE(timescale, 12);
        buffer.writeUInt32BE(0, 16);
        buffer.writeUInt32BE(0x00010000, 20);
        buffer.writeUInt16BE(0x0100, 24);
        const matrix = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
        matrix.forEach((v, i) => buffer.writeUInt32BE(v, 32 + (i * 4)));
        buffer.writeUInt32BE(2, 96);
        return buffer;
    }

    static trak(track) {
        return Buffer.concat([
            this.box('tkhd', this.tkhd()),
            this.box('mdia', this.mdia(track))
        ]);
    }

    static tkhd() {
        const buffer = Buffer.alloc(84);
        buffer.writeUInt32BE(0x00000007, 0);
        buffer.writeUInt32BE(1, 12);
        buffer.writeUInt16BE(0x0100, 36);
        const matrix = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
        matrix.forEach((v, i) => buffer.writeUInt32BE(v, 44 + (i * 4)));
        return buffer;
    }

    static mdia(track) {
        const timescale = track.sampleRate || 44100;
        return Buffer.concat([
            this.box('mdhd', this.mdhd(timescale)),
            this.box('hdlr', this.hdlr('soun', 'SoundHandler')),
            this.box('minf', this.minf(track))
        ]);
    }

    static mdhd(timescale) {
        const buffer = Buffer.alloc(24);
        buffer.writeUInt32BE(timescale, 12);
        buffer.writeUInt16BE(0x55C4, 20);
        return buffer;
    }

    static hdlr(type, name) {
        const buffer = Buffer.alloc(24 + name.length + 1);
        buffer.write(type, 8);
        buffer.write(name, 24);
        return buffer;
    }

    static minf(track) {
        return Buffer.concat([
            this.box('smhd', Buffer.alloc(8)),
            this.box('dinf', this.dinf()),
            this.box('stbl', this.stbl(track))
        ]);
    }

    static dinf() {
        const drefHeader = Buffer.alloc(8);
        drefHeader.writeUInt32BE(1, 4);
        const urlBox = this.box('url ', Buffer.alloc(4));
        urlBox.writeUInt32BE(1, 8);
        return this.box('dref', Buffer.concat([drefHeader, urlBox]));
    }

    static stbl(track) {
        return Buffer.concat([
            this.box('stsd', this.stsd(track)),
            this.box('stts', Buffer.alloc(8)),
            this.box('stsc', Buffer.alloc(8)),
            this.box('stsz', Buffer.alloc(12)),
            this.box('stco', Buffer.alloc(8))
        ]);
    }

    static stsd(track) {
        const header = Buffer.alloc(8);
        header.writeUInt32BE(1, 4);
        return Buffer.concat([header, this.box('mp4a', this.mp4a(track))]);
    }

    static mp4a(track) {
        const buffer = Buffer.alloc(28);
        buffer.writeUInt16BE(1, 6);
        buffer.writeUInt16BE(track.channels || 2, 16);
        buffer.writeUInt16BE(16, 18);
        // Ensure unsigned 32-bit result for 16.16 fixed point (e.g. 48000 << 16 overflows signed int32)
        const samplerate1616 = ((track.sampleRate || 44100) * 65536) >>> 0;
        buffer.writeUInt32BE(samplerate1616, 24);
        return Buffer.concat([buffer, this.box('esds', this.esds(track))]);
    }

    static esds(track) {
        const config = track.codecPrivate || Buffer.alloc(0);
        const configLen = config.length;

        // Descriptor sizes (simplified 1-byte BER encoding for small AAC headers)
        const tag05Len = configLen;
        const tag04Len = 13 + 2 + tag05Len; // 13 bytes data + tag05 header
        const tag03Len = 3 + 2 + tag04Len + 2 + 1; // 3 bytes data + tag04 header + tag06 header

        const buffer = Buffer.alloc(4 + 2 + tag03Len);
        let pos = 4; // Skip FullBox header

        // Tag 0x03 (ES_Descriptor)
        buffer[pos++] = 0x03;
        buffer[pos++] = tag03Len - 2;
        buffer.writeUInt16BE(1, pos); pos += 2; // ES_ID
        buffer[pos++] = 0x00; // flags

        // Tag 0x04 (DecoderConfigDescriptor)
        buffer[pos++] = 0x04;
        buffer[pos++] = tag04Len - 2;
        buffer[pos++] = 0x40; // objectTypeIndication (MPEG-4 Audio)
        buffer[pos++] = 0x15; // streamType (Audio)
        pos += 3; // bufferSizeDB (reserved)
        buffer.writeUInt32BE(track.bitrate || 0, pos); pos += 4;
        buffer.writeUInt32BE(track.bitrate || 0, pos); pos += 4;

        // Tag 0x05 (DecSpecificInfoDescriptor)
        buffer[pos++] = 0x05;
        buffer[pos++] = tag05Len;
        config.copy(buffer, pos);
        pos += configLen;

        // Tag 0x06 (SLConfigDescriptor)
        buffer[pos++] = 0x06;
        buffer[pos++] = 0x01;
        buffer[pos++] = 0x02; // predefined

        return buffer;
    }

    static mvex() {
        const trex = Buffer.alloc(24);
        trex.writeUInt32BE(1, 4);
        trex.writeUInt32BE(1, 8);
        return this.box('trex', trex);
    }

    // ---- MEDIA FRAGMENT BOXES ----

    /**
     * Movie Fragment Box (moof)
     */
    static moof(sequenceNumber, samples, baseMediaDecodeTime) {
        return this.box('moof', Buffer.concat([
            this.box('mfhd', this.mfhd(sequenceNumber)),
            this.box('traf', this.traf(samples, baseMediaDecodeTime, sequenceNumber))
        ]));
    }

    /**
     * Movie Fragment Header (mfhd)
     */
    static mfhd(sequenceNumber) {
        const buffer = Buffer.alloc(8);
        // version 0, flags 0
        buffer.writeUInt32BE(sequenceNumber, 4);
        return buffer;
    }

    /**
     * Track Fragment (traf)
     */
    static traf(samples, baseMediaDecodeTime, sequenceNumber) {
        const tfhd = this.tfhd();
        const tfdt = this.tfdt(baseMediaDecodeTime);
        const trun = this.trun(samples);

        if (sequenceNumber === 1) {
            console.log(`[FRAGMENT-DIAG] --- MOOF STRUCTURE ---`);
            console.log(`[FRAGMENT-DIAG] tfdt.baseMediaDecodeTime: ${baseMediaDecodeTime}`);
            console.log(`[FRAGMENT-DIAG] trun.version: 0`);
            console.log(`[FRAGMENT-DIAG] trun.sample_count: ${samples.length}`);
            console.log(`[FRAGMENT-DIAG] trun.flags: 0x301`);

            samples.forEach((s, i) => {
                if (i < 5 || i >= samples.length - 5) {
                    console.log(`[FRAGMENT-DIAG] Sample #${i}: dur=${s.duration}, size=${s.size}, flags=${JSON.stringify(s.flags)}, cto=${s.compositionTimeOffset || 0}`);
                }
            });
            console.log(`[FRAGMENT-DIAG] -----------------------`);
        }

        return Buffer.concat([
            this.box('tfhd', tfhd),
            this.box('tfdt', tfdt),
            this.box('trun', trun)
        ]);
    }

    /**
     * Track Fragment Header (tfhd)
     */
    static tfhd() {
        const buffer = Buffer.alloc(8);
        // track_ID = 1
        // flags: default-base-is-moof (0x020000)
        buffer.writeUInt32BE(0x00020000, 0);
        buffer.writeUInt32BE(1, 4);
        return buffer;
    }

    /**
     * Track Fragment Base Media Decode Time (tfdt)
     */
    static tfdt(baseMediaDecodeTime) {
        const is64 = baseMediaDecodeTime > 0xFFFFFFFF;
        const buffer = Buffer.alloc(is64 ? 12 : 8);

        if (is64) {
            buffer[0] = 1; // version 1
            buffer.writeBigUInt64BE(BigInt(baseMediaDecodeTime), 4);
        } else {
            buffer[0] = 0; // version 0
            buffer.writeUInt32BE(baseMediaDecodeTime, 4);
        }
        return buffer;
    }

    /**
     * Track Fragment Run (trun)
     */
    static trun(samples) {
        const sampleCount = samples.length;
        // flags: data-offset-present (0x01) | sample-duration-present (0x0100) | sample-size-present (0x0200) | sample-flags-present (0x0400)
        const flags = 0x000701;
        const buffer = Buffer.alloc(12 + (sampleCount * 12));

        buffer.writeUInt32BE(flags, 0); // version 0, flags
        buffer.writeUInt32BE(sampleCount, 4);
        buffer.writeUInt32BE(0, 8); // Data offset (patched later)

        let pos = 12;
        for (const sample of samples) {
            buffer.writeUInt32BE(sample.duration, pos);
            buffer.writeUInt32BE(sample.size, pos + 4);

            // sample_flags:
            // - dependsOn: 2 (Keyframe)
            // - isNonSync: 0 (Sync)
            // binary: 0x02000000
            buffer.writeUInt32BE(0x02000000, pos + 8);
            pos += 12;
        }

        return buffer;
    }

    /**
     * Media Data Box (mdat) payload
     */
    static mdat(samples) {
        return Buffer.concat(samples.map(s => s.payload));
    }

    // ---- UTILITIES ----

    static box(type, payload) {
        const buffer = Buffer.alloc(8);
        buffer.writeUInt32BE(8 + payload.length, 0);
        buffer.write(type, 4);
        return Buffer.concat([buffer, payload]);
    }
}

module.exports = MP4Generator;
