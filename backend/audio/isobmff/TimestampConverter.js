/**
 * TimestampConverter - Pure utility for time mapping between ms and MP4 timescale.
 */
class TimestampConverter {
    /**
     * Converts milliseconds to timescale units.
     * @param {number} ms - Time in milliseconds.
     * @param {number} timescale - MP4 timescale (e.g., 48000).
     * @returns {number} Time in timescale units.
     */
    static msToTimescale(ms, timescale) {
        return Math.round(ms * (timescale / 1000));
    }

    /**
     * Calculates the baseMediaDecodeTime for a fragment (tfdt box).
     * @param {number} startTimeMs - Start time of the first sample in ms.
     * @param {number} timescale - MP4 timescale.
     * @returns {number} Value for the tfdt box.
     */
    static calculateBaseMediaDecodeTime(startTimeMs, timescale) {
        return this.msToTimescale(startTimeMs, timescale);
    }
}

module.exports = TimestampConverter;
