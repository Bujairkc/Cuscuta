/**
 * SampleBuilder - Normalizes StreamVault packets into ISOBMFF samples.
 */
class SampleBuilder {
    static _packetCount = 0;

    /**
     * Converts a raw packet into a normalized sample object.
     * @param {Object} packet - StreamVault packet { payload, time, duration }.
     * @param {number} timescale - MP4 timescale.
     * @param {boolean} isKeyframe - Whether this frame is a keyframe (default true for audio).
     * @returns {Object} Normalized sample.
     */
    static buildSample(packet, timescale, isKeyframe = true) {
        // --- AAC DURATION CORRECTION ---
        // AAC standard frame size is 1024 samples.
        // We prioritize this over the container's duration to prevent drift.
        const duration = 1024;

        return {
            size: packet.payload.length,
            duration: duration,
            flags: {
                isLeading: 0,
                isDependedOn: 0,
                hasRedundancy: 0,
                degradPrio: 0,
                dependsOn: isKeyframe ? 2 : 1, // 2 = Keyframe, 1 = Non-keyframe
                isNonSync: isKeyframe ? 0 : 1, // 0 = Sync, 1 = Non-sync
                paddingValue: 0
            },
            compositionTimeOffset: 0, // Not used for AAC
            payload: packet.payload
        };
    }

    /**
     * Processes an array of packets.
     * @param {Array} packets - StreamVault packet array.
     * @param {number} timescale - MP4 timescale.
     * @returns {Array} Array of normalized samples.
     */
    static buildSamples(packets, timescale) {
        return packets.map(p => this.buildSample(p, timescale));
    }
}

module.exports = SampleBuilder;
